#!/usr/bin/env bun
/**
 * ReviewBench CLI — benchmark /research-peer-review against human reviewers.
 *
 * Usage:
 *   bun run eval/review-bench/src/cli.ts --venue iclr2024 --sample-size 10 --seed 42
 *   bun run bench:review -- --venue iclr2024 --sample-size 50
 */

import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { loadVenueConfig, loadAllVenueConfigs } from './venue-config';
import { fetchPapersWithReviews, getAuthToken } from './openreview-client';
import { downloadPDF, estimateDiskUsage, setPdfAuthToken } from './downloader';
import { stratifiedSample } from './sampler';
import { runBatch } from './runner';
import { parseSkillOutput } from './score-parser';
import { normalizeScores } from './normalizer';
import { krippendorffAlpha, cohenKappaQuadratic, bootstrapCI, ksTest } from './stats';
import { computeCalibration, checkSycophancy } from './calibration';
import { computeWeaknessOverlap } from './weakness-overlap';
import { writeResults, printSummary } from './reporter';
import type { BenchError, BenchResult, IRRResult, CalibrationResult, ParsedScores, OpenReviewPaper } from './types';

// ─── Argument parsing ────────────────────────────────────────

function parseArgs(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

// ─── Preflight checks ───────────────────────────────────────

async function preflight(): Promise<string[]> {
  const issues: string[] = [];

  // Check claude CLI
  try {
    const proc = Bun.spawn(['which', 'claude'], { stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
    if (proc.exitCode !== 0) {
      issues.push('claude CLI not found on PATH. Install: https://docs.anthropic.com/claude-code');
    }
  } catch {
    issues.push('Could not check for claude CLI');
  }

  // Check claude auth (claude -p uses the logged-in session, not ANTHROPIC_API_KEY)
  try {
    const proc = Bun.spawn(['claude', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
    if (proc.exitCode !== 0) {
      issues.push('claude CLI found but returned error. Run "claude" to check auth status.');
    }
  } catch {
    // Already caught by the "which claude" check above
  }

  return issues;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
ReviewBench — benchmark /research-peer-review against human reviewers

Usage:
  bun run eval/review-bench/src/cli.ts [options]

Options:
  --venue <name>          Venue config name (e.g., iclr2024) [required]
  --sample-size <n>       Number of papers to sample [default: 50]
  --seed <n>              Random seed for reproducibility [default: 42]
  --concurrency <n>       Parallel skill invocations [default: 5]
  --sampling-mode <mode>  equal_band or population_weighted [default: equal_band]
  --min-success-rate <r>  Abort if success rate drops below [default: 0.8]
  --cache-ttl <hours>     Cache TTL for API/PDF data, 0 = permanent [default: 0]
  --clear-cache           Clear all cached data before running
  --include-drafts        Include draft venue configs
  --dimensions <list>     Comma-separated dimensions to evaluate (all if omitted)
  --model <model>         Claude model to use [default: skill default]
  --sycophancy-warn <n>   Sycophancy index warning threshold [default: 1.2]
  --sycophancy-fail <n>   Sycophancy index failure threshold [default: 2.0]
  --dry-run               Run pipeline with cached data only, no API/LLM calls
  --help                  Show this help

Environment variables:
  OPENREVIEW_USERNAME        OpenReview account email (free registration at openreview.net)
  OPENREVIEW_PASSWORD        OpenReview account password

Requires: claude CLI logged in (for /research-peer-review skill invocations)
OpenReview requires authentication. Register for free at https://openreview.net/signup
`);
    process.exit(0);
  }

  const venueName = args.venue as string;
  if (!venueName) {
    console.error('Error: --venue is required. Use --help for options.');
    process.exit(1);
  }

  const ROOT = resolve(import.meta.dir, '..');
  const venuesDir = join(ROOT, 'venues');
  const dataDir = join(ROOT, 'data');
  const resultsDir = join(ROOT, 'results');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });

  const sampleSize = parseInt(args['sample-size'] as string || '50', 10);
  const seed = parseInt(args.seed as string || '42', 10);
  const concurrency = parseInt(args.concurrency as string || '5', 10);
  const samplingMode = (args['sampling-mode'] as string || 'equal_band') as 'equal_band' | 'population_weighted';
  const minSuccessRate = parseFloat(args['min-success-rate'] as string || '0.8');
  const cacheTtlHours = parseInt(args['cache-ttl'] as string || '0', 10);
  const includeDrafts = !!args['include-drafts'];
  const dryRun = !!args['dry-run'];
  const model = args.model as string | undefined;
  const sycophancyWarnThreshold = parseFloat(args['sycophancy-warn'] as string || '1.2');
  const sycophancyFailThreshold = parseFloat(args['sycophancy-fail'] as string || '2.0');
  const dimensionFilter = args.dimensions ? (args.dimensions as string).split(',').map(s => s.trim()) : null;

  // Load venue config
  const venueFile = join(venuesDir, `${venueName}.yaml`);
  if (!existsSync(venueFile)) {
    console.error(`Error: venue config not found: ${venueFile}`);
    const available = loadAllVenueConfigs(venuesDir, true).map(v => v.name);
    if (available.length > 0) console.error(`Available venues: ${available.join(', ')}`);
    process.exit(1);
  }

  const venue = loadVenueConfig(venueFile);
  console.log(`\nReviewBench: ${venue.name} (${venue.status})`);
  console.log(`  Sample size: ${sampleSize}, Seed: ${seed}, Mode: ${samplingMode}`);

  if (venue.status === 'draft' && !includeDrafts) {
    console.error('Error: venue is draft. Use --include-drafts to proceed.');
    process.exit(1);
  }

  // Preflight
  if (!dryRun) {
    const issues = await preflight();
    if (issues.length > 0) {
      console.error('\nPreflight check failed:');
      for (const issue of issues) console.error(`  - ${issue}`);
      process.exit(1);
    }
  }

  // Disk usage warning
  const diskWarning = estimateDiskUsage(sampleSize);
  if (diskWarning) console.warn(`\n  ${diskWarning}`);

  // ─── Fetch papers ──────────────────────────────────────────
  console.log('\n[1/7] Fetching papers and reviews...');
  const { papers, errors: fetchErrors } = await fetchPapersWithReviews({
    venue,
    dataDir,
    cacheTtlHours,
  });
  console.log(`  Found ${papers.length} papers with reviews`);

  const allErrors: BenchError[] = [...fetchErrors];

  // Pass auth token to PDF downloader
  const token = getAuthToken();
  if (token) setPdfAuthToken(token);

  // ─── Sample ────────────────────────────────────────────────
  console.log('\n[2/7] Sampling papers...');
  const sampled = stratifiedSample({
    papers,
    sampleSize,
    seed,
    venue,
    mode: samplingMode,
  });
  console.log(`  Sampled ${sampled.length} papers across bands`);

  if (sampled.length === 0) {
    console.error('Error: no papers could be sampled. Check venue config and API data.');
    process.exit(1);
  }

  // ─── Download PDFs ─────────────────────────────────────────
  console.log('\n[3/7] Downloading PDFs...');
  const paperPdfs: Array<{ id: string; pdfPath: string }> = [];

  for (const s of sampled) {
    const result = await downloadPDF(s.id, {
      dataDir,
      venue: venue.venue_id,
      cacheTtlHours,
    });
    if ('error' in result) {
      allErrors.push(result.error);
    } else {
      paperPdfs.push({ id: s.id, pdfPath: result.path });
    }
  }
  console.log(`  Downloaded ${paperPdfs.length}/${sampled.length} PDFs`);

  // ─── Run skill ─────────────────────────────────────────────
  let runResults: Awaited<ReturnType<typeof runBatch>> = [];

  if (dryRun) {
    console.log('\n[4/7] Dry run — skipping skill invocations');
  } else {
    console.log(`\n[4/7] Running /research-peer-review (concurrency: ${concurrency})...`);
    runResults = await runBatch(paperPdfs, {
      concurrency,
      timeoutMs: 300_000,
      model,
      resultsDir,
    }, (done, total, id, ok) => {
      console.log(`  [${done}/${total}] ${id.slice(0, 12)}... ${ok ? '✓' : '✗'}`);
    });

    for (const r of runResults) {
      if (r.error) allErrors.push(r.error);
    }
  }

  // Check success rate
  const successCount = runResults.filter(r => r.output != null).length;
  const successRate = paperPdfs.length > 0 ? successCount / paperPdfs.length : 0;
  if (!dryRun && successRate < minSuccessRate) {
    console.error(`\nError: success rate ${(successRate * 100).toFixed(0)}% below minimum ${(minSuccessRate * 100).toFixed(0)}%`);
    console.error(`  ${allErrors.length} total errors. See results/failures.json`);
    // Still generate partial results
  }

  // ─── Parse scores ──────────────────────────────────────────
  console.log('\n[5/7] Parsing scores...');
  const parsedScores: ParsedScores[] = [];

  for (const r of runResults) {
    if (!r.output) continue;
    const parsed = parseSkillOutput(r.paperId, r.output, venue);
    if (parsed.error) {
      allErrors.push(parsed.error);
    } else if (parsed.scores) {
      parsedScores.push(normalizeScores(parsed.scores, venue));
    }
  }
  console.log(`  Parsed ${parsedScores.length} score sets`);

  // Get papers map for human scores
  const papersMap = new Map<string, OpenReviewPaper>();
  for (const p of papers) papersMap.set(p.id, p);

  // ─── Compute metrics ──────────────────────────────────────
  console.log('\n[6/7] Computing metrics...');

  const dimensions = dimensionFilter || Object.keys(venue.dimensions);
  const irrResults: IRRResult[] = [];
  const calibrationResults: CalibrationResult[] = [];

  for (const dim of dimensions) {
    const dimConfig = venue.dimensions[dim];
    if (!dimConfig) continue;

    // Collect human scores for this dimension
    const humanScoresPerPaper: Map<string, number[]> = new Map();
    for (const s of parsedScores) {
      const paper = papersMap.get(s.paperId);
      if (!paper) continue;
      const humanDimScores = paper.reviews
        .map(r => r.scores[dim])
        .filter(v => v != null);
      if (humanDimScores.length > 0) {
        humanScoresPerPaper.set(s.paperId, humanDimScores);
      }
    }

    // Collect skill scores for this dimension
    const skillScoresMap = new Map<string, number>();
    for (const s of parsedScores) {
      if (s.raw[dim] != null) skillScoresMap.set(s.paperId, s.raw[dim]);
    }

    // Common paper IDs
    const commonIds = [...humanScoresPerPaper.keys()].filter(id => skillScoresMap.has(id));
    if (commonIds.length === 0) {
      irrResults.push({
        dimension: dim,
        krippendorphAlpha: null, alphaCI: null,
        cohenKappa: null, kappaCI: null,
        ksStatistic: null, ksPValue: null,
      });
      continue;
    }

    // Build data matrix for Krippendorff's alpha: [paper][rater]
    // Raters: all human reviewers + skill as an additional rater
    const alphaData: Array<Array<number | null>> = [];
    for (const id of commonIds) {
      const humanScores = humanScoresPerPaper.get(id)!;
      const skillScore = skillScoresMap.get(id)!;
      // Max human reviewers across papers
      const row: Array<number | null> = [...humanScores, skillScore];
      alphaData.push(row);
    }

    // Pad rows to same length
    const maxCols = Math.max(...alphaData.map(r => r.length));
    for (const row of alphaData) {
      while (row.length < maxCols) row.push(null);
    }

    const scaleValues = [];
    for (let v = dimConfig.scale[0]; v <= dimConfig.scale[1]; v++) scaleValues.push(v);

    // Krippendorff's alpha with bootstrap
    const alphaResult = bootstrapCI(
      alphaData,
      (sample) => krippendorffAlpha(sample, scaleValues),
      1000, seed
    );

    // Cohen's kappa: skill vs randomly selected human reviewer (seeded)
    const rng = (() => {
      let s = seed;
      return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    })();

    const humanForKappa: number[] = [];
    const skillForKappa: number[] = [];
    for (const id of commonIds) {
      const hs = humanScoresPerPaper.get(id)!;
      const idx = Math.floor(rng() * hs.length);
      humanForKappa.push(hs[idx]);
      skillForKappa.push(skillScoresMap.get(id)!);
    }

    const kappaResult = bootstrapCI(
      commonIds.map((id, i) => ({ h: humanForKappa[i], s: skillForKappa[i] })),
      (sample) => cohenKappaQuadratic(
        sample.map(x => x.h),
        sample.map(x => x.s),
        dimConfig.scale
      ),
      1000, seed
    );

    // KS test
    const allHumanScores: number[] = [];
    for (const id of commonIds) {
      allHumanScores.push(...humanScoresPerPaper.get(id)!);
    }
    const allSkillScores = commonIds.map(id => skillScoresMap.get(id)!);
    const ks = ksTest(allHumanScores, allSkillScores);

    irrResults.push({
      dimension: dim,
      krippendorphAlpha: alphaResult?.estimate ?? krippendorffAlpha(alphaData, scaleValues),
      alphaCI: alphaResult?.ci ?? null,
      cohenKappa: kappaResult?.estimate ?? cohenKappaQuadratic(humanForKappa, skillForKappa, dimConfig.scale),
      kappaCI: kappaResult?.ci ?? null,
      ksStatistic: ks.statistic,
      ksPValue: ks.pValue,
    });

    // Calibration
    calibrationResults.push(computeCalibration(
      dim, allHumanScores, allSkillScores, dimConfig.scale,
      { sycophancyWarnThreshold, sycophancyFailThreshold }
    ));
  }

  // Weakness overlap
  const overlapInputs = parsedScores.map(s => {
    const paper = papersMap.get(s.paperId);
    const humanWeaknesses = paper?.reviews.flatMap(r => r.weaknesses) || [];
    return {
      paperId: s.paperId,
      humanWeaknesses,
      skillWeaknesses: s.weaknesses,
    };
  });
  const weaknessOverlap = computeWeaknessOverlap(overlapInputs);

  // Sycophancy check
  const { warnings, failures } = checkSycophancy(calibrationResults, {
    sycophancyWarnThreshold,
    sycophancyFailThreshold,
  });
  for (const w of warnings) console.warn(`  ${w}`);
  for (const f of failures) console.error(`  ${f}`);

  // ─── Generate results ──────────────────────────────────────
  console.log('\n[7/7] Generating report...');

  // Compute prompt hash for reproducibility
  const promptTemplate = 'review-bench-v1'; // increment when prompt changes
  const promptHash = createHash('sha256').update(promptTemplate).digest('hex').slice(0, 12);

  const result: BenchResult = {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    seed,
    venue: venue.name,
    sampleSize: sampled.length,
    effectiveN: parsedScores.length,
    model: model || 'default',
    promptHash,
    toolVersion: '0.1.0',
    samplingMode,
    irr: irrResults,
    calibration: calibrationResults,
    weaknessOverlap,
    failures: allErrors,
    config: {
      concurrency,
      minSuccessRate,
      sycophancyWarnThreshold,
      sycophancyFailThreshold,
    },
  };

  writeResults(result, resultsDir);
  printSummary(result);

  // Exit with appropriate code
  if (failures.length > 0) process.exit(2); // sycophancy hard fail
  if (!dryRun && successRate < minSuccessRate) process.exit(1);
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
