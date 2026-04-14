/**
 * Score parser — extracts per-dimension scores from /research-peer-review output.
 * Maps skill dimensions to venue dimensions via venue config.
 */

import type { BenchError, ParsedScores, SkillReviewOutput, VenueConfig } from './types';

// Default skill → venue dimension mapping (used if venue config doesn't specify skillDimension)
const DEFAULT_SKILL_TO_VENUE: Record<string, string[]> = {
  overall: ['overall', 'rating'],
  soundness: ['soundness'],
  presentation: ['clarity'],
  contribution: ['significance', 'novelty'],
  confidence: ['confidence'],
};

export interface ParseResult {
  scores: ParsedScores | null;
  error: BenchError | null;
}

export function parseSkillOutput(
  paperId: string,
  output: SkillReviewOutput,
  venue: VenueConfig
): ParseResult {
  // Use consolidated scores from meta_review if available, otherwise first individual review
  const scores = output.meta_review?.consolidated_scores
    || output.individual_reviews?.[0]?.scores;

  if (!scores || typeof scores !== 'object') {
    return {
      scores: null,
      error: {
        phase: 'parse',
        paperId,
        cause: 'No scores found in skill output',
        suggestion: 'Check that /research-peer-review produced scores in the expected format',
      },
    };
  }

  const raw: Record<string, number> = {};
  const missingDimensions: string[] = [];

  for (const [venueDim, dimConfig] of Object.entries(venue.dimensions)) {
    let matched = false;

    // Check if venue config specifies which skill dimension maps here
    if (dimConfig.skillDimension) {
      if (scores[dimConfig.skillDimension] != null) {
        raw[venueDim] = scores[dimConfig.skillDimension];
        matched = true;
      }
    } else {
      // Use default mapping: find a skill dimension that maps to this venue dimension
      for (const [skillDim, venueDims] of Object.entries(DEFAULT_SKILL_TO_VENUE)) {
        if (venueDims.includes(venueDim) || venueDims.includes(dimConfig.field)) {
          if (scores[skillDim] != null) {
            raw[venueDim] = scores[skillDim];
            matched = true;
            break;
          }
        }
      }
    }

    if (!matched) {
      missingDimensions.push(venueDim);
    }
  }

  // Require at least the 'overall' dimension
  const hasOverall = Object.entries(venue.dimensions).some(([name, dim]) =>
    (dim.field === 'rating' || dim.field === 'overall' || name === 'overall') && raw[name] != null
  );

  if (!hasOverall) {
    return {
      scores: null,
      error: {
        phase: 'parse',
        paperId,
        cause: `Missing required 'overall' dimension. Found: ${Object.keys(raw).join(', ')}`,
        suggestion: 'Check skill output score format and venue dimension mapping',
      },
    };
  }

  // Validate score ranges
  for (const [dim, score] of Object.entries(raw)) {
    const config = venue.dimensions[dim];
    if (config) {
      const [min, max] = config.scale;
      if (score < min || score > max) {
        console.warn(`  Warning: ${paperId} dimension '${dim}' score ${score} out of range [${min}, ${max}]`);
      }
    }
  }

  if (missingDimensions.length > 0) {
    console.warn(`  Warning: ${paperId} missing dimensions: ${missingDimensions.join(', ')}`);
  }

  // Extract weaknesses
  const weaknesses: string[] = [];
  for (const review of output.individual_reviews || []) {
    for (const w of review.weaknesses || []) {
      if (w.text) weaknesses.push(w.text);
    }
  }

  return {
    scores: {
      paperId,
      raw,
      normalized: {}, // filled by normalizer
      weaknesses,
    },
    error: null,
  };
}

/**
 * Validate the parser against a known-good fixture.
 * Call before each bench run to detect skill output format changes.
 */
export function validateFixture(
  fixture: SkillReviewOutput,
  venue: VenueConfig,
  expectedDimensions: string[]
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const result = parseSkillOutput('FIXTURE', fixture, venue);

  if (result.error) {
    issues.push(`Parse failed: ${result.error.cause}`);
    return { valid: false, issues };
  }

  const parsed = result.scores!;
  for (const dim of expectedDimensions) {
    if (parsed.raw[dim] == null) {
      issues.push(`Expected dimension '${dim}' not found in parsed output`);
    }
  }

  return { valid: issues.length === 0, issues };
}
