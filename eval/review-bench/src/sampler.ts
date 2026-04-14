/**
 * Stratified sampler — selects papers by score band with seeded PRNG.
 * Supports equal-band and population-weighted modes.
 */

import type { OpenReviewPaper, SampledPaper, ScoreBand, VenueConfig } from './types';

// Simple seeded PRNG (mulberry32)
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function assignBand(score: number, bands: NonNullable<VenueConfig['score_bands']>): ScoreBand {
  if (score >= bands.strong_accept[0] && score <= bands.strong_accept[1]) return 'strong_accept';
  if (score >= bands.accept[0] && score <= bands.accept[1]) return 'accept';
  if (score >= bands.borderline[0] && score <= bands.borderline[1]) return 'borderline';
  return 'reject';
}

const DEFAULT_BANDS_10: NonNullable<VenueConfig['score_bands']> = {
  reject: [1, 3],
  borderline: [4, 5],
  accept: [6, 7],
  strong_accept: [8, 10],
};

export interface SampleOptions {
  papers: OpenReviewPaper[];
  sampleSize: number;
  seed: number;
  venue: VenueConfig;
  mode: 'equal_band' | 'population_weighted';
}

export function stratifiedSample(opts: SampleOptions): SampledPaper[] {
  const { papers, sampleSize, seed, venue, mode } = opts;
  const rng = mulberry32(seed);

  // Filter to papers with an overall score and at least 1 review
  const eligible = papers.filter(p => p.overallScore != null && p.reviews.length > 0);
  if (eligible.length === 0) return [];

  const bands = venue.score_bands || DEFAULT_BANDS_10;
  const bandNames: ScoreBand[] = ['reject', 'borderline', 'accept', 'strong_accept'];

  // Assign papers to bands
  const byBand: Record<ScoreBand, OpenReviewPaper[]> = {
    reject: [],
    borderline: [],
    accept: [],
    strong_accept: [],
  };

  for (const p of eligible) {
    const band = assignBand(p.overallScore!, bands);
    byBand[band].push(p);
  }

  // Shuffle within each band
  for (const band of bandNames) {
    byBand[band] = seededShuffle(byBand[band], rng);
  }

  let selected: OpenReviewPaper[];

  if (mode === 'equal_band') {
    // Equal representation: take sampleSize/4 from each band
    const nonEmptyBands = bandNames.filter(b => byBand[b].length > 0);
    if (nonEmptyBands.length === 0) return [];

    const perBand = Math.ceil(sampleSize / nonEmptyBands.length);
    selected = [];
    for (const band of nonEmptyBands) {
      selected.push(...byBand[band].slice(0, perBand));
    }

    // Trim to exact sample size
    selected = seededShuffle(selected, rng).slice(0, sampleSize);

    // Log warning for empty bands
    const emptyBands = bandNames.filter(b => byBand[b].length === 0);
    if (emptyBands.length > 0) {
      console.warn(
        `  Warning: empty score bands: ${emptyBands.join(', ')}. ` +
        `Falling back to proportional sampling across ${nonEmptyBands.length} bands.`
      );
    }
  } else {
    // Population-weighted: proportional to band sizes
    const total = eligible.length;
    selected = [];
    for (const band of bandNames) {
      const proportion = byBand[band].length / total;
      const n = Math.round(sampleSize * proportion);
      selected.push(...byBand[band].slice(0, n));
    }
    selected = seededShuffle(selected, rng).slice(0, sampleSize);
  }

  return selected.map(p => ({
    id: p.id,
    title: p.title,
    band: assignBand(p.overallScore!, bands),
    overallScore: p.overallScore!,
    reviewCount: p.reviews.length,
  }));
}
