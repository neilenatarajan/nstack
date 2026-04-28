import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpDir: string;
let slugDir: string;

function run(input: string, opts: { expectFail?: boolean } = {}): { stdout: string; exitCode: number } {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, NSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 10000,
  };
  try {
    const stdout = execSync(`${BIN}/nstack-review-log '${input.replace(/'/g, "'\\''")}'`, execOpts).trim();
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    if (opts.expectFail) {
      return { stdout: e.stderr?.toString() || '', exitCode: e.status || 1 };
    }
    throw e;
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nstack-revlog-'));
  // NSTACK_HOME is now used directly as the project data dir (no projects/$SLUG nesting)
  slugDir = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('nstack-review-log', () => {
  test('appends valid JSON to review JSONL file', () => {
    const input = '{"skill":"plan-eng-review","status":"clean"}';
    const result = run(input);
    expect(result.exitCode).toBe(0);

    // Find the JSONL file that was written (now directly in NSTACK_HOME, no projects/$SLUG nesting)
    const jsonlFiles = fs.readdirSync(slugDir).filter(f => f.endsWith('.jsonl'));
    expect(jsonlFiles.length).toBeGreaterThan(0);

    const content = fs.readFileSync(path.join(slugDir, jsonlFiles[0]), 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.skill).toBe('plan-eng-review');
    expect(parsed.status).toBe('clean');
  });

  test('rejects non-JSON input with non-zero exit code', () => {
    const result = run('not json at all', { expectFail: true });
    expect(result.exitCode).not.toBe(0);

    // Verify nothing was written
    const jsonlFiles = fs.readdirSync(slugDir).filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length > 0) {
      const content = fs.readFileSync(path.join(slugDir, jsonlFiles[0]), 'utf-8').trim();
      expect(content).toBe('');
    }
  });
});
