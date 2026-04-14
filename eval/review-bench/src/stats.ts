/**
 * Statistical metrics for inter-rater reliability.
 * Implements Krippendorff's alpha (ordinal), Cohen's kappa (quadratic weighted),
 * bootstrap confidence intervals, and Kolmogorov-Smirnov test.
 */

// ─── Seeded PRNG for bootstrap ──────────────────────────────

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Krippendorff's Alpha (ordinal) ────────────────────────

/**
 * Compute Krippendorff's alpha for ordinal data.
 *
 * Input: reliability data matrix where rows = units (papers),
 * cols = coders (reviewers), values = ordinal scores.
 * Missing values represented as null.
 *
 * Reference: Krippendorff (2011), "Computing Krippendorff's Alpha-Reliability"
 */
export function krippendorffAlpha(
  data: Array<Array<number | null>>,
  scaleValues?: number[]
): number | null {
  const nUnits = data.length;
  if (nUnits === 0) return null;

  // Collect all non-null values to determine scale
  const allValues: number[] = [];
  for (const row of data) {
    for (const v of row) {
      if (v != null) allValues.push(v);
    }
  }
  if (allValues.length === 0) return null;

  const values = scaleValues || [...new Set(allValues)].sort((a, b) => a - b);
  const nValues = values.length;
  if (nValues <= 1) return null; // degenerate: all same value

  const valueIndex = new Map<number, number>();
  values.forEach((v, i) => valueIndex.set(v, i));

  // Ordinal distance function (squared cumulative metric)
  // d²(c,k) = (sum from g=c to k-1 of n_g - (n_c + n_k)/2)²
  // where n_g = frequency of value g across all observations
  const freq = new Array(nValues).fill(0);
  for (const v of allValues) {
    const idx = valueIndex.get(v);
    if (idx != null) freq[idx]++;
  }

  function ordinalDistSq(ci: number, ki: number): number {
    if (ci === ki) return 0;
    const lo = Math.min(ci, ki);
    const hi = Math.max(ci, ki);
    let sum = 0;
    for (let g = lo; g <= hi; g++) {
      sum += freq[g];
    }
    sum -= (freq[lo] + freq[hi]) / 2;
    return sum * sum;
  }

  // Compute observed disagreement (Do)
  let Do = 0;
  let totalPairs = 0;

  for (const row of data) {
    const observed = row.filter(v => v != null) as number[];
    const m = observed.length;
    if (m < 2) continue;

    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        const ci = valueIndex.get(observed[i]);
        const ki = valueIndex.get(observed[j]);
        if (ci != null && ki != null) {
          Do += ordinalDistSq(ci, ki);
          totalPairs++;
        }
      }
    }
  }

  if (totalPairs === 0) return null;
  Do /= totalPairs;

  // Compute expected disagreement (De)
  const n = allValues.length; // total observations
  let De = 0;
  for (let c = 0; c < nValues; c++) {
    for (let k = c + 1; k < nValues; k++) {
      De += freq[c] * freq[k] * ordinalDistSq(c, k);
    }
  }
  De /= (n * (n - 1)) / 2;

  if (De === 0) return null; // all raters agree perfectly

  return 1 - Do / De;
}

// ─── Cohen's Kappa (quadratic weighted) ─────────────────────

/**
 * Compute Cohen's kappa with quadratic weighting.
 * Input: paired observations from two raters.
 */
export function cohenKappaQuadratic(
  rater1: number[],
  rater2: number[],
  scale: [number, number]
): number | null {
  if (rater1.length !== rater2.length || rater1.length === 0) return null;

  const [min, max] = scale;
  const nCategories = max - min + 1;
  const n = rater1.length;

  // Build confusion matrix
  const matrix = Array.from({ length: nCategories }, () => new Array(nCategories).fill(0));
  for (let i = 0; i < n; i++) {
    const r1 = Math.round(rater1[i]) - min;
    const r2 = Math.round(rater2[i]) - min;
    if (r1 >= 0 && r1 < nCategories && r2 >= 0 && r2 < nCategories) {
      matrix[r1][r2]++;
    }
  }

  // Marginals
  const rowSums = matrix.map(row => row.reduce((a, b) => a + b, 0));
  const colSums = matrix[0].map((_, j) => matrix.reduce((sum, row) => sum + row[j], 0));

  // Quadratic weights: w_ij = 1 - (i-j)² / (nCategories-1)²
  const maxDist = nCategories - 1;
  if (maxDist === 0) return null;

  let po = 0; // observed weighted agreement
  let pe = 0; // expected weighted agreement

  for (let i = 0; i < nCategories; i++) {
    for (let j = 0; j < nCategories; j++) {
      const w = 1 - ((i - j) * (i - j)) / (maxDist * maxDist);
      po += w * matrix[i][j] / n;
      pe += w * (rowSums[i] * colSums[j]) / (n * n);
    }
  }

  if (pe === 1) return null;
  return (po - pe) / (1 - pe);
}

// ─── Bootstrap Confidence Intervals ─────────────────────────

export interface BootstrapResult {
  estimate: number;
  ci: [number, number];
  nResamples: number;
}

/**
 * Bootstrap a statistic with 95% confidence intervals.
 * Resamples at the paper (unit) level to preserve within-unit correlation.
 */
export function bootstrapCI<T>(
  data: T[],
  statFn: (sample: T[]) => number | null,
  nResamples = 1000,
  seed = 42,
  ciLevel = 0.95
): BootstrapResult | null {
  if (data.length < 10) return null; // too few for meaningful bootstrap

  const rng = mulberry32(seed);
  const estimates: number[] = [];

  for (let b = 0; b < nResamples; b++) {
    const sample: T[] = [];
    for (let i = 0; i < data.length; i++) {
      const idx = Math.floor(rng() * data.length);
      sample.push(data[idx]);
    }
    const est = statFn(sample);
    if (est != null) estimates.push(est);
  }

  if (estimates.length < nResamples * 0.5) return null; // too many failed resamples

  estimates.sort((a, b) => a - b);
  const alpha = 1 - ciLevel;
  const lo = Math.floor((alpha / 2) * estimates.length);
  const hi = Math.floor((1 - alpha / 2) * estimates.length);

  const pointEstimate = statFn(data);
  if (pointEstimate == null) return null;

  return {
    estimate: pointEstimate,
    ci: [estimates[lo], estimates[Math.min(hi, estimates.length - 1)]],
    nResamples: estimates.length,
  };
}

// ─── Kolmogorov-Smirnov Test ────────────────────────────────

export interface KSResult {
  statistic: number;
  pValue: number;
}

/**
 * Two-sample Kolmogorov-Smirnov test.
 * Returns the KS statistic and approximate p-value.
 */
export function ksTest(sample1: number[], sample2: number[]): KSResult {
  const n1 = sample1.length;
  const n2 = sample2.length;
  if (n1 === 0 || n2 === 0) return { statistic: 0, pValue: 1 };

  const all = [
    ...sample1.map(v => ({ v, group: 1 })),
    ...sample2.map(v => ({ v, group: 2 })),
  ].sort((a, b) => a.v - b.v);

  let maxD = 0;
  let cdf1 = 0;
  let cdf2 = 0;

  for (let i = 0; i < all.length; i++) {
    if (all[i].group === 1) cdf1 += 1 / n1;
    else cdf2 += 1 / n2;

    // Only check D at value boundaries (when the next value differs or we're at the end)
    if (i === all.length - 1 || all[i].v !== all[i + 1].v) {
      const d = Math.abs(cdf1 - cdf2);
      if (d > maxD) maxD = d;
    }
  }

  // Approximate p-value using asymptotic formula
  const en = Math.sqrt((n1 * n2) / (n1 + n2));
  const lambda = (en + 0.12 + 0.11 / en) * maxD;
  // Kolmogorov distribution approximation
  let pValue = 0;
  for (let k = 1; k <= 100; k++) {
    pValue += 2 * Math.pow(-1, k + 1) * Math.exp(-2 * k * k * lambda * lambda);
  }
  pValue = Math.max(0, Math.min(1, pValue));

  return { statistic: maxD, pValue };
}
