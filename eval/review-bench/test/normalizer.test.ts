import { describe, test, expect } from 'bun:test';
import { normalizeScore, normalizeScores } from '../src/normalizer';
import type { ParsedScores, VenueConfig } from '../src/types';

describe('normalizeScore', () => {
  test('maps min to 0', () => {
    expect(normalizeScore(1, [1, 4])).toBeCloseTo(0, 5);
  });

  test('maps max to 1', () => {
    expect(normalizeScore(4, [1, 4])).toBeCloseTo(1, 5);
  });

  test('maps mid to 0.5', () => {
    expect(normalizeScore(5.5, [1, 10])).toBeCloseTo(0.5, 5);
  });

  test('maps 3 on [1,4] scale to 0.667', () => {
    expect(normalizeScore(3, [1, 4])).toBeCloseTo(0.667, 2);
  });

  test('degenerate scale (min=max) returns 0.5', () => {
    expect(normalizeScore(5, [5, 5])).toBe(0.5);
  });

  test('score below min normalizes to negative', () => {
    expect(normalizeScore(0, [1, 10])).toBeLessThan(0);
  });

  test('score above max normalizes to > 1', () => {
    expect(normalizeScore(12, [1, 10])).toBeGreaterThan(1);
  });
});

describe('normalizeScores', () => {
  const mockVenue: VenueConfig = {
    venue_id: 'TEST',
    name: 'Test',
    api_base: 'https://test',
    status: 'validated',
    dimensions: {
      overall: { field: 'rating', scale: [1, 10], labels: null },
      soundness: { field: 'soundness', scale: [1, 4], labels: null },
    },
    score_parse_regex: '^(\\d+):',
    paper_invitation: 'TEST',
    review_invitation: 'TEST',
  };

  test('normalizes all dimensions', () => {
    const parsed: ParsedScores = {
      paperId: 'test',
      raw: { overall: 6, soundness: 3 },
      normalized: {},
      weaknesses: [],
    };

    const result = normalizeScores(parsed, mockVenue);
    expect(result.normalized.overall).toBeCloseTo(5 / 9, 2); // (6-1)/(10-1)
    expect(result.normalized.soundness).toBeCloseTo(2 / 3, 2); // (3-1)/(4-1)
  });

  test('preserves raw scores', () => {
    const parsed: ParsedScores = {
      paperId: 'test',
      raw: { overall: 8 },
      normalized: {},
      weaknesses: [],
    };

    const result = normalizeScores(parsed, mockVenue);
    expect(result.raw.overall).toBe(8); // unchanged
    expect(result.normalized.overall).toBeCloseTo(7 / 9, 2);
  });

  test('produces values in [0,1] for valid scores', () => {
    const parsed: ParsedScores = {
      paperId: 'test',
      raw: { overall: 5, soundness: 2 },
      normalized: {},
      weaknesses: [],
    };

    const result = normalizeScores(parsed, mockVenue);
    for (const [, v] of Object.entries(result.normalized)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
