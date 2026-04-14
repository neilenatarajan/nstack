/**
 * PDF downloader with caching and sanitization.
 * Downloads papers from OpenReview and caches them locally.
 */

import { existsSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { fetchWithRetry } from './openreview-client';
import type { BenchError } from './types';

// Re-export so CLI can pass the token
let pdfAuthToken: string | null = null;
export function setPdfAuthToken(token: string): void {
  pdfAuthToken = token;
}

const PAPER_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function sanitizePaperId(id: string): string {
  // Strip any path traversal attempts, keep only safe chars
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!PAPER_ID_REGEX.test(safe) || safe.length === 0) {
    throw new Error(`Invalid paper ID after sanitization: "${id}" → "${safe}"`);
  }
  return safe;
}

export interface DownloadOptions {
  dataDir: string;
  venue: string;
  cacheTtlHours: number;
}

export async function downloadPDF(
  paperId: string,
  opts: DownloadOptions
): Promise<{ path: string } | { error: BenchError }> {
  const safeId = sanitizePaperId(paperId);
  const dir = join(opts.dataDir, opts.venue.replace(/\//g, '_'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const pdfPath = join(dir, `${safeId}.pdf`);

  // Check cache
  if (existsSync(pdfPath)) {
    const stat = statSync(pdfPath);
    if (stat.size === 0) {
      // Corrupted (0-byte) file, re-download
      unlinkSync(pdfPath);
    } else if (opts.cacheTtlHours > 0) {
      const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
      if (ageHours <= opts.cacheTtlHours) {
        return { path: pdfPath };
      }
    } else {
      return { path: pdfPath };
    }
  }

  // Download — use auth token if available (OpenReview locked down PDF access post-Nov 2025)
  const url = `https://openreview.net/pdf?id=${encodeURIComponent(paperId)}`;
  try {
    const headers: Record<string, string> = {};
    if (pdfAuthToken) headers['Authorization'] = `Bearer ${pdfAuthToken}`;
    const resp = await fetchWithRetry(url, { headers });

    // Check for error responses (403, HTML error pages)
    if (!resp.ok) {
      return {
        error: {
          phase: 'download',
          paperId,
          cause: `PDF download returned HTTP ${resp.status}`,
          suggestion: 'Ensure OPENREVIEW_USERNAME/PASSWORD are set. PDF access requires auth.',
        },
      };
    }

    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Check if we got an HTML error page instead of a PDF
    const textPrefix = new TextDecoder().decode(bytes.slice(0, 50));
    if (textPrefix.includes('<html') || textPrefix.includes('<!DOCTYPE') || textPrefix.includes('Forbidden')) {
      return {
        error: {
          phase: 'download',
          paperId,
          cause: 'PDF download returned HTML error page instead of PDF',
          suggestion: 'Ensure OPENREVIEW_USERNAME/PASSWORD are set. PDF access requires auth.',
        },
      };
    }

    if (bytes.length === 0) {
      // Try once more
      const resp2 = await fetchWithRetry(url);
      const buffer2 = await resp2.arrayBuffer();
      const bytes2 = new Uint8Array(buffer2);
      if (bytes2.length === 0) {
        return {
          error: {
            phase: 'download',
            paperId,
            cause: 'Downloaded PDF is 0 bytes after retry',
            suggestion: 'Paper may have been withdrawn or is not publicly available',
          },
        };
      }
      writeFileSync(pdfPath, bytes2);
    } else {
      writeFileSync(pdfPath, bytes);
    }

    return { path: pdfPath };
  } catch (err) {
    return {
      error: {
        phase: 'download',
        paperId,
        cause: (err as Error).message,
        suggestion: 'Check network connectivity and paper availability',
      },
    };
  }
}

export function estimateDiskUsage(sampleSize: number): string {
  const avgPdfMb = 5;
  const totalMb = sampleSize * avgPdfMb;
  if (totalMb > 500) {
    return `Warning: estimated ${totalMb}MB of PDF downloads (~${avgPdfMb}MB per paper x ${sampleSize} papers)`;
  }
  return '';
}
