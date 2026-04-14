import { describe, test, expect } from 'bun:test';
import { bigramSimilarity, computeWeaknessOverlap } from '../src/weakness-overlap';

describe('bigramSimilarity', () => {
  test('identical strings return 1.0', () => {
    expect(bigramSimilarity('the model lacks ablation studies', 'the model lacks ablation studies')).toBeCloseTo(1.0, 2);
  });

  test('completely different strings return ~0', () => {
    expect(bigramSimilarity('apple banana cherry', 'xylophone zebra quantum')).toBeCloseTo(0, 2);
  });

  test('similar strings return positive similarity', () => {
    const sim = bigramSimilarity(
      'the paper lacks proper ablation studies for validating component contributions',
      'missing ablation studies in the evaluation for each component contribution'
    );
    expect(sim).toBeGreaterThan(0.1);
  });

  test('case insensitive', () => {
    expect(bigramSimilarity('Hello World', 'hello world')).toBeCloseTo(1.0, 2);
  });

  test('empty strings return 0', () => {
    expect(bigramSimilarity('', '')).toBe(0);
    expect(bigramSimilarity('test', '')).toBe(0);
  });
});

describe('computeWeaknessOverlap', () => {
  test('perfect overlap returns 1.0', () => {
    const result = computeWeaknessOverlap([{
      paperId: 'p1',
      humanWeaknesses: [
        'The model lacks ablation studies to demonstrate the contribution of each component',
        'The notation in section 3 is unclear and inconsistent',
        'Limited comparison with recent strong baselines',
      ],
      skillWeaknesses: [
        'The model lacks ablation studies to demonstrate the contribution of each component',
        'The notation in section 3 is unclear and inconsistent',
        'Limited comparison with recent strong baselines',
      ],
    }]);

    expect(result.meanOverlap).toBeCloseTo(1.0, 2);
    expect(result.perPaper[0].matchCount).toBe(3);
  });

  test('no overlap returns 0', () => {
    const result = computeWeaknessOverlap([{
      paperId: 'p1',
      humanWeaknesses: [
        'The theoretical analysis is incomplete and lacks formal proofs',
        'The experimental setup does not control for confounding variables',
        'The related work section misses several important references',
      ],
      skillWeaknesses: [
        'The writing quality could be improved throughout the paper',
        'Some figures are too small to read clearly at normal zoom level',
        'The appendix material should be better organized for readability',
      ],
    }]);

    expect(result.meanOverlap).toBeCloseTo(0, 1);
  });

  test('partial overlap returns intermediate value', () => {
    const result = computeWeaknessOverlap([{
      paperId: 'p1',
      humanWeaknesses: [
        'Missing ablation studies for each individual component of the proposed method to validate contributions',
        'Unclear notation in the mathematical formulation section three is problematic for readers',
        'Limited baselines in the experimental comparison with current state of the art methods',
      ],
      skillWeaknesses: [
        'Missing ablation studies for each component of the proposed method to validate individual contributions',
        'Some completely unrelated weakness about writing style formatting and presentation quality',
        'The mathematical notation in section three is unclear and confusing for readers of this paper',
      ],
    }]);

    expect(result.meanOverlap).toBeGreaterThan(0);
    expect(result.meanOverlap).toBeLessThanOrEqual(1);
  });

  test('averages across papers', () => {
    const result = computeWeaknessOverlap([
      {
        paperId: 'p1',
        humanWeaknesses: ['weakness A about methodology concerns in the experimental design'],
        skillWeaknesses: ['weakness A about methodology concerns in the experimental design'],
      },
      {
        paperId: 'p2',
        humanWeaknesses: ['weakness B about lack of formal theoretical grounding and proofs'],
        skillWeaknesses: ['something completely different about visualization quality issues'],
      },
    ]);

    expect(result.meanOverlap).toBeCloseTo(0.5, 1);
    expect(result.perPaper.length).toBe(2);
  });

  test('skips papers with no human weaknesses', () => {
    const result = computeWeaknessOverlap([{
      paperId: 'p1',
      humanWeaknesses: [],
      skillWeaknesses: ['some weakness text that is long enough to pass the filter'],
    }]);

    expect(result.perPaper.length).toBe(0);
    expect(result.meanOverlap).toBe(0);
  });
});
