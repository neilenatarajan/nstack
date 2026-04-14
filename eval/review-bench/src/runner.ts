/**
 * Skill runner — invokes /research-peer-review via claude -p for each paper.
 * Captures review_report.json from the working directory after subprocess exits.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import type { BenchError, SkillReviewOutput } from './types';

// Semaphore for concurrent skill invocations
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) { this.active++; return; }
    return new Promise(resolve => { this.queue.push(() => { this.active++; resolve(); }); });
  }
  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export interface RunOptions {
  concurrency: number;
  timeoutMs: number;
  model?: string;
  resultsDir: string;
}

export interface RunResult {
  paperId: string;
  output: SkillReviewOutput | null;
  transcript: string;
  durationMs: number;
  error: BenchError | null;
}

export async function runSkillOnPaper(
  paperId: string,
  pdfPath: string,
  opts: RunOptions
): Promise<RunResult> {
  const start = Date.now();
  const workDir = join(tmpdir(), `review-bench-${paperId}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  // Copy PDF into working directory so claude -p can access it
  const pdfName = basename(pdfPath);
  const localPdf = join(workDir, pdfName);
  copyFileSync(pdfPath, localPdf);

  const prompt = `Review the paper "${pdfName}" in the current directory using /research-peer-review.

After the review is complete, write a file called review_report.json with this structure:
{
  "individual_reviews": [{ "reviewer": "claude", "scores": { "overall": N, "confidence": N, "soundness": N, "presentation": N, "contribution": N }, "weaknesses": [{ "text": "...", "quote": "...", "explanation": "..." }], "decision": "accept|minor_revision|major_revision|reject" }],
  "meta_review": { "consolidated_scores": { "overall": N, "soundness": N, "presentation": N, "contribution": N }, "decision": "..." }
}

Start by reading the PDF, then write the review.`;

  const promptFile = join(workDir, 'prompt.txt');
  writeFileSync(promptFile, prompt);

  try {
    const modelFlag = opts.model ? `--model ${opts.model}` : '';
    const allowedTools = '--allowedTools Read,Write,Bash,Glob,Grep,Edit';
    const cmd = `cat "${promptFile}" | claude -p ${modelFlag} ${allowedTools} --max-turns 30 --output-format stream-json --verbose 2>&1`;

    const proc = Bun.spawn(['sh', '-c', cmd], {
      cwd: workDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Set up timeout
    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(() => {
        proc.kill();
        reject(new Error(`Skill timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    });

    // Collect stdout
    let stdout = '';
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await Promise.race([
          reader.read(),
          timeoutPromise.then(() => ({ done: true, value: undefined })),
        ]) as ReadableStreamReadResult<Uint8Array>;
        if (done) break;
        if (value) stdout += decoder.decode(value, { stream: true });
      }
    } catch {
      // timeout killed the process
    }

    await proc.exited;
    const durationMs = Date.now() - start;

    // Save transcript
    const transcriptPath = join(opts.resultsDir, `transcript_${paperId}.txt`);
    writeFileSync(transcriptPath, stdout);

    // Read review_report.json from working directory
    const reportPath = join(workDir, 'review_report.json');
    if (!existsSync(reportPath)) {
      return {
        paperId,
        output: null,
        transcript: stdout,
        durationMs,
        error: {
          phase: 'run',
          paperId,
          cause: 'Skill did not produce review_report.json',
          suggestion: 'Check if /research-peer-review is installed and the paper is readable',
        },
      };
    }

    const reportJson = readFileSync(reportPath, 'utf-8');
    let output: SkillReviewOutput;
    try {
      output = JSON.parse(reportJson) as SkillReviewOutput;
    } catch {
      return {
        paperId,
        output: null,
        transcript: stdout,
        durationMs,
        error: {
          phase: 'run',
          paperId,
          cause: 'review_report.json is not valid JSON',
          suggestion: 'Check skill output format',
        },
      };
    }

    return { paperId, output, transcript: stdout, durationMs, error: null };
  } catch (err) {
    return {
      paperId,
      output: null,
      transcript: '',
      durationMs: Date.now() - start,
      error: {
        phase: 'run',
        paperId,
        cause: (err as Error).message,
        suggestion: 'Check claude CLI availability and API key',
      },
    };
  }
}

export async function runBatch(
  papers: Array<{ id: string; pdfPath: string }>,
  opts: RunOptions,
  onProgress?: (completed: number, total: number, paperId: string, success: boolean) => void
): Promise<RunResult[]> {
  const sem = new Semaphore(opts.concurrency);
  const results: RunResult[] = [];
  let completed = 0;

  const tasks = papers.map(async (paper) => {
    await sem.acquire();
    try {
      const result = await runSkillOnPaper(paper.id, paper.pdfPath, opts);
      completed++;
      onProgress?.(completed, papers.length, paper.id, result.error === null);
      results.push(result);
    } finally {
      sem.release();
    }
  });

  await Promise.all(tasks);
  return results;
}
