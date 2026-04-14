import { describe, test, expect } from 'bun:test';
import { parseSkillOutput, validateFixture } from '../src/score-parser';
import type { SkillReviewOutput, VenueConfig } from '../src/types';

const mockVenue: VenueConfig = {
  venue_id: 'TEST/2024',
  name: 'Test 2024',
  api_base: 'https://test.openreview.net',
  status: 'validated',
  dimensions: {
    soundness: { field: 'soundness', scale: [1, 4], labels: null, skillDimension: 'soundness' },
    clarity: { field: 'clarity', scale: [1, 4], labels: null, skillDimension: 'presentation' },
    overall: { field: 'rating', scale: [1, 10], labels: null, skillDimension: 'overall' },
  },
  score_parse_regex: '^(\\d+):',
  paper_invitation: 'TEST/-/Submission',
  review_invitation: 'TEST/-/Review',
};

const validOutput: SkillReviewOutput = {
  individual_reviews: [{
    reviewer: 'claude',
    scores: { overall: 6, soundness: 3, presentation: 3, contribution: 3, confidence: 4 },
    weaknesses: [
      { text: 'Missing ablation study', quote: 'We evaluate...', explanation: 'No ablations' },
      { text: 'Unclear notation', quote: 'Let x be...', explanation: 'Ambiguous' },
      { text: 'Limited baselines', explanation: 'Only compared to 2 methods' },
    ],
  }],
  meta_review: {
    consolidated_scores: { overall: 6, soundness: 3, presentation: 3, contribution: 3 },
    decision: 'minor_revision',
  },
};

describe('parseSkillOutput', () => {
  test('parses valid output correctly', () => {
    const result = parseSkillOutput('paper-1', validOutput, mockVenue);
    expect(result.error).toBeNull();
    expect(result.scores).not.toBeNull();
    expect(result.scores!.raw.overall).toBe(6);
    expect(result.scores!.raw.soundness).toBe(3);
    expect(result.scores!.raw.clarity).toBe(3); // mapped from presentation
  });

  test('extracts weaknesses', () => {
    const result = parseSkillOutput('paper-1', validOutput, mockVenue);
    expect(result.scores!.weaknesses.length).toBe(3);
    expect(result.scores!.weaknesses[0]).toBe('Missing ablation study');
  });

  test('prefers meta_review consolidated scores', () => {
    const output: SkillReviewOutput = {
      individual_reviews: [{
        reviewer: 'claude',
        scores: { overall: 5, soundness: 2, presentation: 2 },
        weaknesses: [],
      }],
      meta_review: {
        consolidated_scores: { overall: 7, soundness: 4, presentation: 3 },
        decision: 'accept',
      },
    };
    const result = parseSkillOutput('paper-1', output, mockVenue);
    expect(result.scores!.raw.overall).toBe(7); // from meta_review, not individual
  });

  test('returns error for missing scores', () => {
    const noScores: SkillReviewOutput = {
      individual_reviews: [{
        reviewer: 'claude',
        scores: {},
        weaknesses: [],
      }],
    };
    const result = parseSkillOutput('paper-1', noScores, mockVenue);
    expect(result.error).not.toBeNull();
    expect(result.error!.phase).toBe('parse');
    expect(result.error!.cause).toContain('overall');
  });

  test('returns error for completely empty output', () => {
    const empty: SkillReviewOutput = { individual_reviews: [] };
    const result = parseSkillOutput('paper-1', empty, mockVenue);
    expect(result.error).not.toBeNull();
  });

  test('warns on out-of-range scores but still parses', () => {
    const output: SkillReviewOutput = {
      individual_reviews: [{
        reviewer: 'claude',
        scores: { overall: 15, soundness: 3, presentation: 3 },
        weaknesses: [],
      }],
    };
    const result = parseSkillOutput('paper-1', output, mockVenue);
    // Should still parse (with warning), since overall is present
    expect(result.scores).not.toBeNull();
    expect(result.scores!.raw.overall).toBe(15);
  });
});

describe('validateFixture', () => {
  test('valid fixture passes', () => {
    const result = validateFixture(validOutput, mockVenue, ['overall', 'soundness', 'clarity']);
    expect(result.valid).toBe(true);
    expect(result.issues.length).toBe(0);
  });

  test('missing expected dimension fails', () => {
    const result = validateFixture(validOutput, mockVenue, ['overall', 'soundness', 'clarity', 'nonexistent']);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.includes('nonexistent'))).toBe(true);
  });
});
