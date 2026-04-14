/**
 * Score normalizer — linear remap to [0,1] per dimension.
 * Preserves raw scores alongside normalized values.
 */

import type { ParsedScores, VenueConfig } from './types';

/**
 * Normalize a raw score to [0,1] using the dimension's declared scale.
 * Returns 0.5 if min === max (degenerate scale).
 */
export function normalizeScore(raw: number, scale: [number, number]): number {
  const [min, max] = scale;
  if (min === max) {
    console.warn(`  Warning: degenerate scale [${min}, ${max}], returning 0.5`);
    return 0.5;
  }
  return (raw - min) / (max - min);
}

/**
 * Normalize all scores in a ParsedScores object.
 * Returns a new object with the normalized field filled in.
 */
export function normalizeScores(parsed: ParsedScores, venue: VenueConfig): ParsedScores {
  const normalized: Record<string, number> = {};

  for (const [dim, rawScore] of Object.entries(parsed.raw)) {
    const config = venue.dimensions[dim];
    if (config) {
      normalized[dim] = normalizeScore(rawScore, config.scale);
    } else {
      // Dimension not in venue config; pass through raw
      normalized[dim] = rawScore;
    }
  }

  return {
    ...parsed,
    normalized,
  };
}

/**
 * Normalize human review scores for a dimension.
 */
export function normalizeHumanScores(
  scores: number[],
  scale: [number, number]
): number[] {
  return scores.map(s => normalizeScore(s, scale));
}
