/**
 * OpenReview REST API client.
 * Fetches papers and reviews from api2.openreview.net with exponential backoff,
 * concurrency control, and local JSON caching.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BenchError, OpenReviewNote, OpenReviewPaper, OpenReviewReview, VenueConfig } from './types';

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) return response;
      if (response.status === 403) return response; // Let caller handle 403 (auth errors)
      if (response.status === 429) {
        const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);
        console.error(`  Rate limited, waiting ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (response.status === 401) {
        throw new Error(`Authentication error (${response.status}). Some OpenReview endpoints may require auth.`);
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (err) {
      lastError = err as Error;
      if ((err as Error).name === 'AbortError') {
        lastError = new Error(`Request timed out after ${TIMEOUT_MS}ms: ${url}`);
      }
      if (attempt < MAX_RETRIES - 1) {
        const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError ?? new Error('fetch failed');
}

// Shared semaphore for rate-limiting concurrent API requests
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(() => { this.active++; resolve(); });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const apiSemaphore = new Semaphore(3);

let authToken: string | null = null;

export function getAuthToken(): string | null {
  return authToken;
}

/**
 * Authenticate with OpenReview API using username/password.
 * Sets the auth token for subsequent requests.
 */
export async function authenticate(apiBase: string): Promise<void> {
  const username = process.env.OPENREVIEW_USERNAME;
  const password = process.env.OPENREVIEW_PASSWORD;

  if (!username || !password) {
    console.log('  No OPENREVIEW_USERNAME/OPENREVIEW_PASSWORD set, trying unauthenticated access...');
    return;
  }

  try {
    const resp = await fetchWithRetry(`${apiBase}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: username, password }),
    });
    const body = await resp.json() as { token?: string };
    if (body.token) {
      authToken = body.token;
      console.log('  Authenticated with OpenReview');
    }
  } catch (err) {
    console.warn(`  Warning: OpenReview auth failed: ${(err as Error).message}`);
    console.warn('  Continuing without auth (some endpoints may return 403)');
  }
}

function authHeaders(): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

async function fetchThrottled(url: string, init?: RequestInit): Promise<Response> {
  await apiSemaphore.acquire();
  try {
    const headers = { ...authHeaders(), ...(init?.headers || {}) };
    return await fetchWithRetry(url, { ...init, headers });
  } finally {
    apiSemaphore.release();
  }
}

function getCachePath(dataDir: string, venue: string, key: string): string {
  const dir = join(dataDir, venue);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${key}.json`);
}

interface CacheEnvelope {
  _cachedAt: string;
  data: unknown;
}

function readCache<T>(path: string, cacheTtlHours: number): T | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as CacheEnvelope;
    // Check TTL
    if (cacheTtlHours > 0 && raw._cachedAt) {
      const ageHours = (Date.now() - new Date(raw._cachedAt).getTime()) / (1000 * 60 * 60);
      if (ageHours > cacheTtlHours) return null;
    }
    return raw.data as T;
  } catch {
    return null;
  }
}

function writeCache(path: string, data: unknown): void {
  const envelope: CacheEnvelope = { _cachedAt: new Date().toISOString(), data };
  writeFileSync(path, JSON.stringify(envelope));
}

export interface FetchPapersOptions {
  venue: VenueConfig;
  dataDir: string;
  cacheTtlHours: number;
  limit?: number;
}

/**
 * Fetch all papers for a venue. Returns papers with their reviews.
 *
 * Uses the OpenReview API v2 pattern:
 * 1. Fetch submissions with details=replies to get reviews inline
 * 2. Reviews are in paper.details.replies, filtered by invitation containing "Official_Review"
 */
export async function fetchPapersWithReviews(opts: FetchPapersOptions): Promise<{
  papers: OpenReviewPaper[];
  errors: BenchError[];
}> {
  const { venue, dataDir, cacheTtlHours, limit } = opts;
  const errors: BenchError[] = [];
  const venueSlug = venue.venue_id.replace(/\//g, '_');

  // Authenticate if credentials available
  await authenticate(venue.api_base);

  // Check cache first
  const cachePath = getCachePath(dataDir, venueSlug, 'papers_with_reviews');
  const cached = readCache<OpenReviewPaper[]>(cachePath, cacheTtlHours);
  if (cached) {
    console.log(`  Using cached data (${cached.length} papers with reviews)`);
    const papersToReturn = limit ? cached.slice(0, limit) : cached;
    return { papers: papersToReturn, errors };
  }

  // Fetch submissions with inline replies (reviews)
  console.log(`  Fetching papers with reviews from ${venue.api_base}...`);

  const reviewInvitationRegex = new RegExp(venue.review_invitation);
  const papers: OpenReviewPaper[] = [];
  let offset = 0;
  const pageSize = 100;
  let totalCount = 0;

  while (true) {
    const url = `${venue.api_base}/notes?invitation=${encodeURIComponent(venue.paper_invitation)}&details=replies&offset=${offset}&limit=${pageSize}`;
    try {
      const resp = await fetchThrottled(url);
      const text = await resp.text();
      let body: { notes: any[]; count?: number };
      try {
        body = JSON.parse(text);
      } catch {
        if (text.includes('Forbidden') || text.includes('ForbiddenError')) {
          throw new Error(
            'OpenReview API returned 403 Forbidden. ' +
            'Set OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD environment variables. ' +
            'Register for free at https://openreview.net/signup'
          );
        }
        throw new Error(`Unexpected API response: ${text.slice(0, 200)}`);
      }

      if (!body.notes || !Array.isArray(body.notes)) {
        const asError = body as any;
        if (asError.name === 'ForbiddenError') {
          throw new Error(
            'OpenReview API returned 403 Forbidden. ' +
            'Set OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD environment variables. ' +
            'Register for free at https://openreview.net/signup'
          );
        }
        throw new Error('Unexpected API response shape: missing notes array');
      }

      if (body.count != null) totalCount = body.count;

      for (const note of body.notes) {
        const title = note.content?.title?.value || 'Unknown';
        const authors = note.content?.authors?.value || [];
        const abstract = note.content?.abstract?.value || '';

        // Extract reviews from inline replies
        const replies: any[] = note.details?.replies || [];
        const reviewReplies = replies.filter((r: any) => {
          // API v2: invitations is an array (plural)
          const invs: string[] = r.invitations || [];
          return invs.some((inv: string) => reviewInvitationRegex.test(inv));
        });

        const reviews: OpenReviewReview[] = reviewReplies.map((r: any) =>
          parseReviewV2(r, venue)
        );

        // Compute average overall score for stratification
        const overallDim = Object.entries(venue.dimensions).find(
          ([, d]) => d.field === 'rating' || d.field === 'overall'
        );
        let overallScore: number | null = null;
        if (overallDim && reviews.length > 0) {
          const scores = reviews.map(r => r.scores[overallDim[0]]).filter(s => s != null);
          if (scores.length > 0) {
            overallScore = scores.reduce((a, b) => a + b, 0) / scores.length;
          }
        }

        papers.push({ id: note.id, title, authors, abstract, reviews, overallScore });
      }

      const fetchedSoFar = offset + body.notes.length;
      const displayTotal = totalCount || '?';
      console.log(`  Fetched ${fetchedSoFar}/${displayTotal} papers...`);

      if (body.notes.length < pageSize) break;
      offset += pageSize;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('Forbidden') || msg.includes('403')) {
        throw new Error(msg);
      }
      errors.push({
        phase: 'fetch',
        paperId: 'VENUE',
        cause: `Failed to fetch papers at offset ${offset}: ${msg}`,
        suggestion: 'Check venue config and API availability',
      });
      break;
    }
  }

  // Cache the result
  if (papers.length > 0) {
    writeCache(cachePath, papers);
  }

  const withReviews = papers.filter(p => p.reviews.length > 0);
  console.log(`  Found ${withReviews.length} papers with reviews (${papers.length} total)`);

  return { papers: limit ? papers.slice(0, limit) : papers, errors };
}

/**
 * Parse a review from the API v2 inline reply format.
 * In v2, content fields are { value: ... } objects, and scores are strings like
 * "3: reject, not good enough" or "2 fair".
 */
function parseReviewV2(reply: any, venue: VenueConfig): OpenReviewReview {
  const content = reply.content || {};
  const scores: Record<string, number> = {};
  const regex = new RegExp(venue.score_parse_regex);

  for (const [dimName, dimConfig] of Object.entries(venue.dimensions)) {
    const fieldValue = content[dimConfig.field]?.value;
    if (fieldValue == null) continue;
    const rawStr = String(fieldValue);

    // Try the venue's score_parse_regex first (e.g. "3: reject...")
    const match = regex.exec(rawStr);
    if (match) {
      scores[dimName] = parseInt(match[1], 10);
    } else {
      // Try extracting leading integer (e.g. "2 fair")
      const numMatch = rawStr.match(/^(\d+)/);
      if (numMatch) {
        scores[dimName] = parseInt(numMatch[1], 10);
      } else if (typeof fieldValue === 'number') {
        scores[dimName] = fieldValue;
      }
    }
  }

  // Extract weaknesses text
  const weaknessesRaw = content.weaknesses?.value || '';
  const weaknessStr = typeof weaknessesRaw === 'string' ? weaknessesRaw : '';
  const weaknesses = weaknessStr
    .split(/\n(?=\d+[\.\)]\s|-\s)/)
    .map((w: string) => w.trim())
    .filter((w: string) => w.length > 10);

  const reviewerId = (reply.signatures?.[0] || reply.id || 'unknown').replace(/.*\//, '');

  return { reviewerId, scores, text: weaknessStr, weaknesses };
}

/**
 * Validate that the API response matches expected schema.
 * Used by integration tests to catch API drift.
 */
export async function validateApiSchema(venue: VenueConfig): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];
  try {
    const url = `${venue.api_base}/notes?invitation=${encodeURIComponent(venue.paper_invitation)}&offset=0&limit=1`;
    const resp = await fetchWithRetry(url);
    const body = await resp.json() as Record<string, unknown>;

    if (!body.notes) issues.push('Response missing "notes" field');
    if (!body.count && body.count !== 0) issues.push('Response missing "count" field');

    const notes = body.notes as OpenReviewNote[] | undefined;
    if (notes && notes.length > 0) {
      const note = notes[0];
      if (!note.id) issues.push('Note missing "id" field');
      if (!note.content) issues.push('Note missing "content" field');
      if (!note.invitation) issues.push('Note missing "invitation" field');

      // Check that expected content fields exist
      const content = note.content;
      if (content) {
        if (!content.title) issues.push('Note content missing "title"');
      }
    }
  } catch (err) {
    issues.push(`API request failed: ${(err as Error).message}`);
  }

  return { valid: issues.length === 0, issues };
}
