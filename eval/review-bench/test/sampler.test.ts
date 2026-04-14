import { describe, test, expect } from 'bun:test';
import { stratifiedSample } from '../src/sampler';
import type { OpenReviewPaper, VenueConfig } from '../src/types';

const mockVenue: VenueConfig = {
  venue_id: 'TEST/2024',
  name: 'Test 2024',
  api_base: 'https://test.openreview.net',
  status: 'validated',
  dimensions: {
    overall: { field: 'rating', scale: [1, 10], labels: null },
  },
  score_parse_regex: '^(\\d+):',
  paper_invitation: 'TEST/-/Submission',
  review_invitation: 'TEST/Submission.*/-/Official_Review',
  score_bands: {
    reject: [1, 3],
    borderline: [4, 5],
    accept: [6, 7],
    strong_accept: [8, 10],
  },
};

function makePaper(id: string, score: number): OpenReviewPaper {
  return {
    id,
    title: `Paper ${id}`,
    authors: ['Author'],
    abstract: 'Abstract',
    reviews: [{ reviewerId: 'r1', scores: { overall: score }, text: '', weaknesses: [] }],
    overallScore: score,
  };
}

describe('stratifiedSample', () => {
  const papers = [
    // Reject band (1-3)
    ...Array.from({ length: 10 }, (_, i) => makePaper(`reject-${i}`, 2)),
    // Borderline band (4-5)
    ...Array.from({ length: 10 }, (_, i) => makePaper(`borderline-${i}`, 5)),
    // Accept band (6-7)
    ...Array.from({ length: 10 }, (_, i) => makePaper(`accept-${i}`, 7)),
    // Strong accept band (8-10)
    ...Array.from({ length: 10 }, (_, i) => makePaper(`strong-${i}`, 9)),
  ];

  test('equal band sampling distributes across bands', () => {
    const sampled = stratifiedSample({
      papers,
      sampleSize: 20,
      seed: 42,
      venue: mockVenue,
      mode: 'equal_band',
    });

    expect(sampled.length).toBe(20);
    const bands = new Set(sampled.map(s => s.band));
    expect(bands.size).toBe(4); // All four bands represented
  });

  test('same seed produces same sample', () => {
    const s1 = stratifiedSample({ papers, sampleSize: 10, seed: 42, venue: mockVenue, mode: 'equal_band' });
    const s2 = stratifiedSample({ papers, sampleSize: 10, seed: 42, venue: mockVenue, mode: 'equal_band' });

    expect(s1.map(s => s.id)).toEqual(s2.map(s => s.id));
  });

  test('different seeds produce different samples', () => {
    const s1 = stratifiedSample({ papers, sampleSize: 10, seed: 42, venue: mockVenue, mode: 'equal_band' });
    const s2 = stratifiedSample({ papers, sampleSize: 10, seed: 99, venue: mockVenue, mode: 'equal_band' });

    const ids1 = s1.map(s => s.id).sort();
    const ids2 = s2.map(s => s.id).sort();
    expect(ids1).not.toEqual(ids2);
  });

  test('empty band falls back gracefully', () => {
    // Only accept and strong_accept papers
    const limitedPapers = papers.filter(p => p.overallScore! >= 6);
    const sampled = stratifiedSample({
      papers: limitedPapers,
      sampleSize: 10,
      seed: 42,
      venue: mockVenue,
      mode: 'equal_band',
    });

    expect(sampled.length).toBe(10);
    const bands = new Set(sampled.map(s => s.band));
    expect(bands.has('reject')).toBe(false);
    expect(bands.has('borderline')).toBe(false);
  });

  test('sample size larger than available papers', () => {
    const sampled = stratifiedSample({
      papers: papers.slice(0, 5),
      sampleSize: 100,
      seed: 42,
      venue: mockVenue,
      mode: 'equal_band',
    });

    expect(sampled.length).toBeLessThanOrEqual(5);
  });

  test('population-weighted mode preserves proportions', () => {
    // Make 30 reject, 10 accept
    const skewedPapers = [
      ...Array.from({ length: 30 }, (_, i) => makePaper(`r-${i}`, 2)),
      ...Array.from({ length: 10 }, (_, i) => makePaper(`a-${i}`, 7)),
    ];
    const sampled = stratifiedSample({
      papers: skewedPapers,
      sampleSize: 20,
      seed: 42,
      venue: mockVenue,
      mode: 'population_weighted',
    });

    const rejectCount = sampled.filter(s => s.band === 'reject').length;
    const acceptCount = sampled.filter(s => s.band === 'accept').length;
    // Population is 75% reject, 25% accept — weighted should approximate this
    expect(rejectCount).toBeGreaterThan(acceptCount);
  });

  test('no eligible papers returns empty', () => {
    const noPapers: OpenReviewPaper[] = [];
    const sampled = stratifiedSample({
      papers: noPapers,
      sampleSize: 10,
      seed: 42,
      venue: mockVenue,
      mode: 'equal_band',
    });
    expect(sampled.length).toBe(0);
  });
});
