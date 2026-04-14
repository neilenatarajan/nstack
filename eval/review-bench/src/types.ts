/**
 * ReviewBench types — shared across all modules.
 */

// ─── Errors ──────────────────────────────────────────────────

export interface BenchError {
  phase: 'fetch' | 'download' | 'run' | 'parse' | 'stats';
  paperId: string;
  cause: string;
  suggestion: string;
}

// ─── Venue Config ────────────────────────────────────────────

export interface DimensionConfig {
  field: string;
  scale: [number, number];
  labels: string[] | null;
  skillDimension?: string; // maps this venue dimension to a skill output dimension
}

export interface VenueConfig {
  venue_id: string;
  name: string;
  api_base: string;
  status: 'validated' | 'draft';
  dimensions: Record<string, DimensionConfig>;
  score_parse_regex: string;
  paper_invitation: string;
  review_invitation: string;
  score_bands?: {
    reject: [number, number];
    borderline: [number, number];
    accept: [number, number];
    strong_accept: [number, number];
  };
}

// ─── OpenReview API ──────────────────────────────────────────

export interface OpenReviewNote {
  id: string;
  forum: string;
  invitation: string;
  content: Record<string, { value: unknown }>;
  signatures?: string[];
}

export interface OpenReviewPaper {
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  reviews: OpenReviewReview[];
  overallScore: number | null; // average human review score for stratification
}

export interface OpenReviewReview {
  reviewerId: string;
  scores: Record<string, number>; // dimension name → raw score
  text: string;
  weaknesses: string[]; // extracted weakness text
}

// ─── Sampling ────────────────────────────────────────────────

export type ScoreBand = 'reject' | 'borderline' | 'accept' | 'strong_accept';

export interface SampledPaper {
  id: string;
  title: string;
  band: ScoreBand;
  overallScore: number;
  reviewCount: number;
}

// ─── Skill Output ────────────────────────────────────────────

export interface SkillReviewOutput {
  individual_reviews: Array<{
    reviewer: string;
    scores: Record<string, number>;
    weaknesses: Array<{ text: string; quote?: string; explanation?: string }>;
  }>;
  meta_review?: {
    consolidated_scores: Record<string, number>;
    decision: string;
  };
}

export interface ParsedScores {
  paperId: string;
  raw: Record<string, number>;       // dimension → raw score
  normalized: Record<string, number>; // dimension → [0,1]
  weaknesses: string[];               // top weakness texts
}

// ─── Stats ───────────────────────────────────────────────────

export interface IRRResult {
  dimension: string;
  krippendorphAlpha: number | null;
  alphaCI: [number, number] | null;
  cohenKappa: number | null;
  kappaCI: [number, number] | null;
  ksStatistic: number | null;
  ksPValue: number | null;
}

export interface CalibrationResult {
  dimension: string;
  humanMedian: number;
  skillMedian: number;
  calibrationError: number;
  sycophancyIndex: number | null; // only for dimensions with defined thresholds
  humanDistribution: number[];
  skillDistribution: number[];
}

export interface WeaknessOverlapResult {
  meanOverlap: number;       // 0-1, average across papers
  perPaper: Array<{
    paperId: string;
    humanWeaknesses: string[];
    skillWeaknesses: string[];
    matchCount: number;
    overlapRatio: number;
  }>;
}

// ─── Results ─────────────────────────────────────────────────

export interface BenchResult {
  schema_version: 1;
  timestamp: string;
  seed: number;
  venue: string;
  sampleSize: number;
  effectiveN: number; // papers that succeeded
  model: string;
  promptHash: string;
  toolVersion: string;
  samplingMode: 'equal_band' | 'population_weighted';
  irr: IRRResult[];
  calibration: CalibrationResult[];
  weaknessOverlap: WeaknessOverlapResult;
  failures: BenchError[];
  config: {
    concurrency: number;
    minSuccessRate: number;
    sycophancyWarnThreshold: number;
    sycophancyFailThreshold: number;
  };
}
