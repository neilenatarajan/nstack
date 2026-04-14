/**
 * Reporter — generates results.json and report.md from benchmark data.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import type { BenchResult, CalibrationResult, IRRResult, WeaknessOverlapResult } from './types';
import { formatHistogram } from './calibration';

export function writeResults(result: BenchResult, outputDir: string): void {
  const jsonPath = join(outputDir, 'results.json');
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  console.log(`  Results written to ${jsonPath}`);

  const mdPath = join(outputDir, 'report.md');
  const md = generateMarkdownReport(result);
  writeFileSync(mdPath, md);
  console.log(`  Report written to ${mdPath}`);
}

function generateMarkdownReport(r: BenchResult): string {
  const lines: string[] = [];

  lines.push(`# ReviewBench Report`);
  lines.push('');
  lines.push(`**Venue:** ${r.venue}`);
  lines.push(`**Date:** ${r.timestamp}`);
  lines.push(`**Sample:** ${r.effectiveN}/${r.sampleSize} papers (${r.samplingMode})`);
  lines.push(`**Model:** ${r.model}`);
  lines.push(`**Seed:** ${r.seed}`);
  lines.push('');

  if (r.effectiveN < 30) {
    lines.push('> **Warning:** Sample size too small for meaningful IRR statistics. Use --sample-size 50+ for publishable results.');
    lines.push('');
  }

  // IRR Summary
  lines.push('## Inter-Rater Reliability');
  lines.push('');
  lines.push('| Dimension | Krippendorff α | 95% CI | Cohen κ | 95% CI | KS stat | KS p |');
  lines.push('|-----------|---------------|--------|---------|--------|---------|------|');
  for (const irr of r.irr) {
    lines.push(formatIRRRow(irr));
  }
  lines.push('');
  lines.push('*Baseline: human-human kappa at top ML venues is 0.2-0.4.*');
  lines.push('');

  // Weakness Overlap
  lines.push('## Weakness Overlap (Qualitative)');
  lines.push('');
  lines.push(`**Mean overlap:** ${(r.weaknessOverlap.meanOverlap * 100).toFixed(1)}% of human weaknesses also flagged by AI`);
  lines.push('');
  if (r.weaknessOverlap.perPaper.length > 0) {
    lines.push('| Paper | Human Weaknesses | AI Matched | Overlap |');
    lines.push('|-------|-----------------|------------|---------|');
    for (const p of r.weaknessOverlap.perPaper.slice(0, 20)) {
      lines.push(`| ${p.paperId.slice(0, 12)}... | ${p.humanWeaknesses.length} | ${p.matchCount} | ${(p.overlapRatio * 100).toFixed(0)}% |`);
    }
    if (r.weaknessOverlap.perPaper.length > 20) {
      lines.push(`| ... | ${r.weaknessOverlap.perPaper.length - 20} more papers | | |`);
    }
    lines.push('');
  }

  // Calibration
  lines.push('## Calibration');
  lines.push('');
  for (const cal of r.calibration) {
    lines.push(`### ${cal.dimension}`);
    lines.push('');
    lines.push(`- Human median: ${cal.humanMedian.toFixed(2)}`);
    lines.push(`- Skill median: ${cal.skillMedian.toFixed(2)}`);
    lines.push(`- Calibration error: ${cal.calibrationError.toFixed(2)}`);
    if (cal.sycophancyIndex != null) {
      lines.push(`- Sycophancy index: ${cal.sycophancyIndex.toFixed(2)}`);
    }
    lines.push('');

    // Find scale for this dimension from the IRR results
    // Use the distribution lengths to infer scale
    const scaleMin = 1; // assume 1-based
    lines.push(formatHistogram('  Human', cal.humanDistribution, scaleMin));
    lines.push(formatHistogram('  Skill', cal.skillDistribution, scaleMin));
    lines.push('');
  }

  // Failures
  if (r.failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    lines.push(`${r.failures.length} papers failed:`);
    lines.push('');
    const byCause = new Map<string, number>();
    for (const f of r.failures) {
      const key = `${f.phase}: ${f.cause.slice(0, 60)}`;
      byCause.set(key, (byCause.get(key) || 0) + 1);
    }
    for (const [cause, count] of byCause.entries()) {
      lines.push(`- ${count}x ${cause}`);
    }
    lines.push('');
  }

  // Abort criteria
  lines.push('## Abort Criteria Check');
  lines.push('');
  const overallIRR = r.irr.find(i => i.dimension === 'overall');
  if (overallIRR?.krippendorphAlpha != null) {
    const alpha = overallIRR.krippendorphAlpha;
    if (alpha < 0.15) {
      lines.push(`**ABORT:** Overall alpha = ${alpha.toFixed(3)} < 0.15. Redesign rubric before re-running.`);
    } else {
      lines.push(`Overall alpha = ${alpha.toFixed(3)} (above 0.15 abort threshold)`);
    }
  }
  lines.push('');

  // Config
  lines.push('## Reproducibility');
  lines.push('');
  lines.push(`- Prompt hash: ${r.promptHash}`);
  lines.push(`- Tool version: ${r.toolVersion}`);
  lines.push(`- Concurrency: ${r.config.concurrency}`);
  lines.push(`- Min success rate: ${r.config.minSuccessRate}`);
  lines.push('');

  return lines.join('\n');
}

function formatIRRRow(irr: IRRResult): string {
  const alpha = irr.krippendorphAlpha != null ? irr.krippendorphAlpha.toFixed(3) : 'N/A';
  const alphaCI = irr.alphaCI ? `[${irr.alphaCI[0].toFixed(3)}, ${irr.alphaCI[1].toFixed(3)}]` : 'N/A';
  const kappa = irr.cohenKappa != null ? irr.cohenKappa.toFixed(3) : 'N/A';
  const kappaCI = irr.kappaCI ? `[${irr.kappaCI[0].toFixed(3)}, ${irr.kappaCI[1].toFixed(3)}]` : 'N/A';
  const ks = irr.ksStatistic != null ? irr.ksStatistic.toFixed(3) : 'N/A';
  const ksp = irr.ksPValue != null ? irr.ksPValue.toFixed(3) : 'N/A';
  return `| ${irr.dimension} | ${alpha} | ${alphaCI} | ${kappa} | ${kappaCI} | ${ks} | ${ksp} |`;
}

/**
 * Print a summary to the console.
 */
export function printSummary(r: BenchResult): void {
  console.log('\n═══════════════════════════════════════════');
  console.log(' ReviewBench Results');
  console.log('═══════════════════════════════════════════');
  console.log(`  Venue:   ${r.venue}`);
  console.log(`  Papers:  ${r.effectiveN}/${r.sampleSize} succeeded`);
  console.log(`  Model:   ${r.model}`);
  console.log('');

  for (const irr of r.irr) {
    const alpha = irr.krippendorphAlpha != null ? irr.krippendorphAlpha.toFixed(3) : 'N/A';
    const kappa = irr.cohenKappa != null ? irr.cohenKappa.toFixed(3) : 'N/A';
    console.log(`  ${irr.dimension.padEnd(15)} α=${alpha}  κ=${kappa}`);
  }

  console.log('');
  console.log(`  Weakness overlap: ${(r.weaknessOverlap.meanOverlap * 100).toFixed(1)}%`);

  if (r.failures.length > 0) {
    console.log(`\n  ${r.failures.length} papers failed:`);
    const summary = new Map<string, number>();
    for (const f of r.failures) {
      const key = `${f.phase} ${f.cause.slice(0, 40)}`;
      summary.set(key, (summary.get(key) || 0) + 1);
    }
    for (const [cause, count] of summary.entries()) {
      console.log(`    ${count}x ${cause}`);
    }
  }

  console.log('═══════════════════════════════════════════\n');
}
