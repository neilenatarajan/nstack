import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { spawn, which } from 'bun';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

// `git` must remain available because each tool calls `git rev-parse --show-toplevel`.
// We strip everything else from PATH so `bun` cannot be found, simulating the
// Claude Code subshell environment where ~/.bun/bin is not inherited.
const gitPath = which('git') ?? '/usr/bin/git';
const gitDir = path.dirname(gitPath);
const RESTRICTED_PATH = `${gitDir}:/usr/bin:/bin`;

beforeAll(() => {
  // Sanity: bun must be on PATH in the unrestricted env (so the "default env"
  // test cases actually exercise the bun path).
  expect(which('bun')).not.toBeNull();
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nstack-logtools-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type RunOpts = {
  restrictedPath?: boolean;
};

async function runTool(
  tool: string,
  input: string,
  opts: RunOpts = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? '',
    NSTACK_HOME: tmpDir,
  };
  if (opts.restrictedPath) {
    env.PATH = RESTRICTED_PATH;
  } else {
    env.PATH = process.env.PATH ?? '';
  }

  const proc = spawn({
    cmd: [path.join(BIN, tool), input],
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

function readJsonlLines(filename: string): any[] {
  // v0.18+: NSTACK_HOME is the flat project data dir (no `projects/$SLUG/` nesting).
  const filePath = path.join(tmpDir, filename);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map((line) => JSON.parse(line));
}

function findFile(filename: string): string | null {
  const filePath = path.join(tmpDir, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

describe('log tools — env restriction sanity check', () => {
  test('bun is NOT discoverable under RESTRICTED_PATH', async () => {
    // Spawn a probe command that tries to find bun.
    const proc = spawn({
      cmd: ['sh', '-c', 'command -v bun || echo NOTFOUND'],
      env: { PATH: RESTRICTED_PATH, HOME: process.env.HOME ?? '' },
      stdout: 'pipe',
    });
    await proc.exited;
    const out = (await new Response(proc.stdout).text()).trim();
    expect(out).toBe('NOTFOUND');
  });
});

// review-log writes to `${BRANCH}-reviews.jsonl` where BRANCH comes from
// nstack-slug. Discover the actual filename rather than hardcoding it so the
// test is branch-agnostic.
function findReviewsFile(): string | null {
  // v0.18+: reviews live directly in NSTACK_HOME (no nesting).
  if (!fs.existsSync(tmpDir)) return null;
  const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('-reviews.jsonl'));
  return files.length > 0 ? path.join(tmpDir, files[0]) : null;
}

function readReviewsJsonl(): any[] {
  const filePath = findReviewsFile();
  if (!filePath) return [];
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map((line) => JSON.parse(line));
}

describe('nstack-review-log', () => {
  const validJson = '{"skill":"plan-eng-review","status":"clean"}';

  test('valid JSON, default env (bun on PATH) → exit 0, file written', async () => {
    const r = await runTool('nstack-review-log', validJson);
    expect(r.exitCode).toBe(0);
    const lines = readReviewsJsonl();
    expect(lines.length).toBe(1);
    expect(lines[0].skill).toBe('plan-eng-review');
  });

  test('REGRESSION: valid JSON, restricted env (bun OFF PATH) → exit 0, file written', async () => {
    const r = await runTool('nstack-review-log', validJson, { restrictedPath: true });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    const lines = readReviewsJsonl();
    expect(lines.length).toBe(1);
    expect(lines[0].skill).toBe('plan-eng-review');
  });

  test('malformed JSON → exit 1, accurate error, no file written', async () => {
    const r = await runTool('nstack-review-log', 'not json at all', { restrictedPath: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('failed shape check');
    expect(r.stderr).not.toContain('invalid JSON'); // the misleading old message
    expect(findReviewsFile()).toBeNull();
  });

  test('empty input → exit 1, "empty" reason', async () => {
    const r = await runTool('nstack-review-log', '', { restrictedPath: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('(empty)');
  });

  test('input containing newline → exit 1, "control" reason', async () => {
    const r = await runTool('nstack-review-log', '{"a":1\nbad}', { restrictedPath: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('(control)');
  });
});

describe('nstack-learnings-log', () => {
  const validJson = '{"skill":"test","type":"pattern","key":"k","insight":"i","confidence":5,"source":"observed"}';
  const learningsFile = 'learnings.jsonl';

  test('valid JSON, default env → exit 0, file written, ts injected', async () => {
    const r = await runTool('nstack-learnings-log', validJson);
    expect(r.exitCode).toBe(0);
    const lines = readJsonlLines(learningsFile);
    expect(lines.length).toBe(1);
    expect(lines[0].ts).toBeDefined();
    // Accept both `2026-04-28T12:34:56Z` (pure-bash fallback) and
    // `2026-04-28T12:34:56.123Z` (bun's Date.toISOString output).
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test('REGRESSION: valid JSON, restricted env (bun OFF PATH) → exit 0, file written', async () => {
    const r = await runTool('nstack-learnings-log', validJson, { restrictedPath: true });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    const lines = readJsonlLines(learningsFile);
    expect(lines.length).toBe(1);
    expect(lines[0].skill).toBe('test');
  });

  test('input with `ts` as top-level key → ts is preserved, not overwritten', async () => {
    const input = '{"ts":"2020-01-01T00:00:00Z","skill":"x","type":"p","key":"k","insight":"i","confidence":5,"source":"observed"}';
    const r = await runTool('nstack-learnings-log', input, { restrictedPath: true });
    expect(r.exitCode).toBe(0);
    const lines = readJsonlLines(learningsFile);
    expect(lines[0].ts).toBe('2020-01-01T00:00:00Z');
  });

  test('input with `ts` substring inside a string value → ts is NOT re-injected (avoids duplicate keys)', async () => {
    // The ts-injection check matches `"ts":` anywhere in the input. False
    // positive: a string value containing `"ts":` like {"description":"ts: foo"}
    // would skip injection. But the design's bigger fear is duplicate `ts` keys
    // when `ts` appears as a non-first top-level key — that risk is worse than
    // missing an injection. Document the tradeoff here.
    const input = '{"description":"prefix \\"ts\\":suffix","skill":"x","type":"p","key":"k","insight":"i","confidence":5,"source":"observed"}';
    const r = await runTool('nstack-learnings-log', input, { restrictedPath: true });
    expect(r.exitCode).toBe(0);
    const lines = readJsonlLines(learningsFile);
    // ts was not injected — but the line is still valid JSONL
    expect(lines.length).toBe(1);
    expect(lines[0].skill).toBe('x');
  });

  test('`ts` as second top-level key → not duplicated (regression for finding 4)', async () => {
    // Previously the anchored regex only matched `ts` as the FIRST key. With
    // skill/type/key/... first and ts later, the script wrongly prepended a
    // second `ts`, producing duplicate keys. Fix: match `"ts":` anywhere.
    const input = '{"skill":"x","type":"p","key":"k","insight":"i","confidence":5,"source":"observed","ts":"2020-01-01T00:00:00Z"}';
    const r = await runTool('nstack-learnings-log', input, { restrictedPath: true });
    expect(r.exitCode).toBe(0);
    // Read the raw file line (not parsed) to verify no duplicate ts string
    const filePath = findFile(learningsFile);
    expect(filePath).not.toBeNull();
    const raw = fs.readFileSync(filePath!, 'utf-8').trim();
    // Count occurrences of `"ts":` — should be exactly 1
    const tsCount = (raw.match(/"ts":/g) ?? []).length;
    expect(tsCount).toBe(1);
    const parsed = JSON.parse(raw);
    expect(parsed.ts).toBe('2020-01-01T00:00:00Z');
  });

  test('malformed JSON → exit 1, no file written', async () => {
    const r = await runTool('nstack-learnings-log', 'garbage', { restrictedPath: true });
    expect(r.exitCode).toBe(1);
    // learnings-log uses a different validator (bun-backed with bash fallback)
    // than review-log/timeline-log. Accept any rejection message that names
    // the underlying validation failure.
    expect(r.stderr).toMatch(/failed shape check|invalid JSON|must be a JSON object/);
    expect(findFile(learningsFile)).toBeNull();
  });

  test('input with literal newline → exit 1', async () => {
    const r = await runTool('nstack-learnings-log', '{"a":1\nbad}', { restrictedPath: true });
    expect(r.exitCode).toBe(1);
    // learnings-log's validator may report this as a JSON parse error or as
    // a shape/control rejection — exit 1 is the contract; reason text varies.
    expect(r.stderr).toMatch(/control|invalid JSON|failed shape check|must be a JSON object/);
  });

  test('empty-object {} input gets ts injected with no trailing comma', async () => {
    const r = await runTool('nstack-learnings-log', '{}', { restrictedPath: true });
    expect(r.exitCode).toBe(0);
    const lines = readJsonlLines(learningsFile);
    expect(lines.length).toBe(1);
    // Accept ts with or without millisecond fraction (pure-bash fallback vs bun).
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Object.keys(lines[0])).toEqual(['ts']);
  });
});

describe('nstack-timeline-log', () => {
  const validJson = '{"skill":"test","event":"started"}';
  const timelineFile = 'timeline.jsonl';

  test('valid JSON, default env → exit 0, file written, ts injected', async () => {
    const r = await runTool('nstack-timeline-log', validJson);
    expect(r.exitCode).toBe(0);
    const lines = readJsonlLines(timelineFile);
    expect(lines.length).toBe(1);
    expect(lines[0].skill).toBe('test');
    expect(lines[0].event).toBe('started');
    expect(lines[0].ts).toBeDefined();
  });

  test('REGRESSION: valid JSON, restricted env (bun OFF PATH) → exit 0, file written (was: silent drop)', async () => {
    const r = await runTool('nstack-timeline-log', validJson, { restrictedPath: true });
    expect(r.exitCode).toBe(0);
    const lines = readJsonlLines(timelineFile);
    expect(lines.length).toBe(1);
    expect(lines[0].skill).toBe('test');
  });

  test('REGRESSION: malformed input must NOT silently exit 0 (the silent-drop bug)', async () => {
    const r = await runTool('nstack-timeline-log', 'not json', { restrictedPath: true });
    // The whole point: prior behavior was exit 0 with no file written.
    // After fix: exit 1 with a stderr message.
    expect(r.exitCode).toBe(1);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(findFile(timelineFile)).toBeNull();
  });

  test('missing `event` field → exit 1, accurate error', async () => {
    const r = await runTool('nstack-timeline-log', '{"skill":"test"}', { restrictedPath: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('missing required field');
    expect(findFile(timelineFile)).toBeNull();
  });

  test('missing `skill` field → exit 1, accurate error', async () => {
    const r = await runTool('nstack-timeline-log', '{"event":"started"}', { restrictedPath: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('missing required field');
    expect(findFile(timelineFile)).toBeNull();
  });

  test('input with literal newline → exit 1, "control" reason', async () => {
    const r = await runTool('nstack-timeline-log', '{"skill":"x","event":"y"\nbad}', { restrictedPath: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('(control)');
  });

  test('empty `skill` value → exit 1 (regression for falsy-field check)', async () => {
    const r = await runTool('nstack-timeline-log', '{"skill":"","event":"started"}', { restrictedPath: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('empty/null');
  });

  test('empty `event` value → exit 1', async () => {
    const r = await runTool('nstack-timeline-log', '{"skill":"x","event":""}', { restrictedPath: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('empty/null');
  });

  test('null `skill` → exit 1', async () => {
    const r = await runTool('nstack-timeline-log', '{"skill":null,"event":"started"}', { restrictedPath: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('empty/null');
  });

  test('null `event` → exit 1', async () => {
    const r = await runTool('nstack-timeline-log', '{"skill":"x","event":null}', { restrictedPath: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('empty/null');
  });

  test('`ts` as second top-level key → not duplicated (regression for finding 4)', async () => {
    const input = '{"skill":"x","event":"started","ts":"2020-01-01T00:00:00Z"}';
    const r = await runTool('nstack-timeline-log', input, { restrictedPath: true });
    expect(r.exitCode).toBe(0);
    const filePath = findFile(timelineFile);
    expect(filePath).not.toBeNull();
    const raw = fs.readFileSync(filePath!, 'utf-8').trim();
    const tsCount = (raw.match(/"ts":/g) ?? []).length;
    expect(tsCount).toBe(1);
    const parsed = JSON.parse(raw);
    expect(parsed.ts).toBe('2020-01-01T00:00:00Z');
  });
});

describe('shape check — documented threat-model behavior', () => {
  // Pins the design's Premise 4: shape check, not validity check. Bad-but-shaped
  // input (starts with `{`, ends with `}`, no control chars) is accepted on
  // purpose — readers handle parse errors gracefully. A future tightening
  // should remove this test deliberately.
  test('malformed-but-shaped JSON without jq passes the shape check (documented behavior)', async () => {
    // {not: valid json} starts with `{`, ends with `}`, no control chars. If jq
    // is on PATH, the bonus check will catch it. We can't unconditionally rely
    // on jq presence, so this test exercises the design contract: the floor is
    // "shape, not validity."
    const r = await runTool('nstack-review-log', '{not valid json}', { restrictedPath: true });
    // Two acceptable outcomes:
    // - jq is installed → exit 1 with reason "jq"
    // - jq is absent     → exit 0, line written (reader handles the parse error)
    if (r.exitCode === 0) {
      expect(r.stderr).toBe('');
    } else {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('(jq)');
    }
  });
});
