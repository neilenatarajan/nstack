/**
 * Weakness overlap — qualitative complement to IRR.
 * Measures how many human-identified weaknesses the AI also flagged.
 */

import type { WeaknessOverlapResult } from './types';

const SIMILARITY_THRESHOLD = 0.6;

/**
 * Compute bigrams from a normalized string.
 */
function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const words = normalized.split(/\s+/);
  const result = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    result.add(`${words[i]} ${words[i + 1]}`);
  }
  return result;
}

/**
 * Compute bigram similarity (Dice coefficient) between two strings.
 */
export function bigramSimilarity(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;

  let intersection = 0;
  for (const bg of ba) {
    if (bb.has(bg)) intersection++;
  }

  return (2 * intersection) / (ba.size + bb.size);
}

/**
 * Extract top-N weakness texts from a list, keeping the longest/most specific ones.
 */
function topN(weaknesses: string[], n: number): string[] {
  return [...weaknesses]
    .filter(w => w.length >= 20) // skip very short fragments
    .sort((a, b) => b.length - a.length) // prefer longer (more specific) weaknesses
    .slice(0, n);
}

/**
 * Count how many human weaknesses the skill also identified.
 * Uses bigram similarity with a configurable threshold.
 */
function countMatches(
  humanWeaknesses: string[],
  skillWeaknesses: string[],
  threshold = SIMILARITY_THRESHOLD
): number {
  let matches = 0;
  const matched = new Set<number>(); // indices of matched skill weaknesses

  for (const hw of humanWeaknesses) {
    for (let i = 0; i < skillWeaknesses.length; i++) {
      if (matched.has(i)) continue;
      const sim = bigramSimilarity(hw, skillWeaknesses[i]);
      if (sim >= threshold) {
        matches++;
        matched.add(i);
        break;
      }
    }
  }

  return matches;
}

export interface WeaknessOverlapInput {
  paperId: string;
  humanWeaknesses: string[]; // from all human reviews combined
  skillWeaknesses: string[]; // from skill review output
}

/**
 * Compute weakness overlap across all papers.
 */
export function computeWeaknessOverlap(
  papers: WeaknessOverlapInput[],
  topNWeaknesses = 3
): WeaknessOverlapResult {
  const perPaper: WeaknessOverlapResult['perPaper'] = [];
  let totalOverlap = 0;
  let validPapers = 0;

  for (const paper of papers) {
    const humanTop = topN(paper.humanWeaknesses, topNWeaknesses);
    const skillTop = topN(paper.skillWeaknesses, topNWeaknesses);

    if (humanTop.length === 0) continue;

    const matchCount = countMatches(humanTop, skillTop);
    const overlapRatio = matchCount / humanTop.length;

    perPaper.push({
      paperId: paper.paperId,
      humanWeaknesses: humanTop,
      skillWeaknesses: skillTop,
      matchCount,
      overlapRatio,
    });

    totalOverlap += overlapRatio;
    validPapers++;
  }

  return {
    meanOverlap: validPapers > 0 ? totalOverlap / validPapers : 0,
    perPaper,
  };
}
