import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let stateDir: string;
let fakeRepo: string;
let localLearnings: string;
let globalLearnings: string;

function runLog(input: string, opts: { expectFail?: boolean; env?: Record<string, string> } = {}): { stdout: string; stderr: string; exitCode: number } {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: fakeRepo,
    env: { ...process.env, NSTACK_STATE_DIR: stateDir, ...(opts.env || {}) },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    const stdout = execSync(`${BIN}/nstack-learnings-log '${input.replace(/'/g, "'\\''")}'`, execOpts).trim();
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    if (opts.expectFail || e.status) {
      return { stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '', exitCode: e.status ?? 1 };
    }
    throw e;
  }
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nstack-dual-state-'));
  fakeRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nstack-dual-repo-')));
  execSync('git init -q . && git remote add origin git@example.com:dual/test.git', { cwd: fakeRepo });
  localLearnings = path.join(fakeRepo, '.nstack', 'learnings.jsonl');
  globalLearnings = path.join(stateDir, 'learnings.jsonl');
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(fakeRepo, { recursive: true, force: true });
});

describe('nstack-learnings-log dual-write', () => {
  test('opt-in (cross_project_learnings=true): writes to BOTH local and global', () => {
    execSync(`${BIN}/nstack-config set --local cross_project_learnings true`, {
      cwd: fakeRepo, env: { ...process.env, NSTACK_STATE_DIR: stateDir },
    });
    runLog('{"skill":"impl","type":"pattern","key":"dual","insight":"test","confidence":7,"source":"observed"}');

    expect(fs.existsSync(localLearnings)).toBe(true);
    expect(fs.existsSync(globalLearnings)).toBe(true);

    const local = JSON.parse(fs.readFileSync(localLearnings, 'utf-8').trim().split('\n').pop()!);
    const global = JSON.parse(fs.readFileSync(globalLearnings, 'utf-8').trim().split('\n').pop()!);

    expect(local.key).toBe('dual');
    expect(global.key).toBe('dual');
    // Global enriched with project + repo_path metadata
    expect(global.project).toBeDefined();
    expect(global.repo_path).toBe(fakeRepo);
    // Local NOT enriched (kept clean)
    expect(local.project).toBeUndefined();
    expect(local.repo_path).toBeUndefined();
  });

  test('opt-out (cross_project_learnings=false): writes ONLY local', () => {
    execSync(`${BIN}/nstack-config set --local cross_project_learnings false`, {
      cwd: fakeRepo, env: { ...process.env, NSTACK_STATE_DIR: stateDir },
    });
    runLog('{"skill":"impl","type":"pattern","key":"local-only","insight":"test","confidence":7,"source":"observed"}');

    expect(fs.existsSync(localLearnings)).toBe(true);
    expect(fs.existsSync(globalLearnings)).toBe(false);
  });

  test('default (config unset): writes ONLY local — privacy-first default', () => {
    runLog('{"skill":"impl","type":"pattern","key":"unset","insight":"test","confidence":7,"source":"observed"}');
    expect(fs.existsSync(localLearnings)).toBe(true);
    expect(fs.existsSync(globalLearnings)).toBe(false);
  });

  test('size limit: insight > 4096 bytes is rejected', () => {
    execSync(`${BIN}/nstack-config set --local cross_project_learnings true`, {
      cwd: fakeRepo, env: { ...process.env, NSTACK_STATE_DIR: stateDir },
    });
    const big = 'a'.repeat(4097);
    const result = runLog(`{"skill":"impl","type":"pattern","key":"big","insight":"${big}","confidence":7,"source":"observed"}`, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/insight exceeds 4096|size validation failed/);
    // Neither file should have the rejected entry
    expect(fs.existsSync(localLearnings)).toBe(false);
    expect(fs.existsSync(globalLearnings)).toBe(false);
  });

  test('size limit: files array > 16 entries is rejected', () => {
    execSync(`${BIN}/nstack-config set --local cross_project_learnings true`, {
      cwd: fakeRepo, env: { ...process.env, NSTACK_STATE_DIR: stateDir },
    });
    const files = Array.from({ length: 17 }, (_, i) => `f${i}.ts`);
    const input = JSON.stringify({ skill: 'impl', type: 'pattern', key: 'many-files', insight: 'too many', confidence: 7, source: 'observed', files });
    const result = runLog(input, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/files array exceeds 16|size validation failed/);
  });

  test('cross-project search reads global archive directly', () => {
    execSync(`${BIN}/nstack-config set --local cross_project_learnings true`, {
      cwd: fakeRepo, env: { ...process.env, NSTACK_STATE_DIR: stateDir },
    });
    runLog('{"skill":"impl","type":"pattern","key":"global-key","insight":"in global","confidence":8,"source":"observed"}');
    // Search WITHOUT --cross-project — only local
    const localOnly = execSync(`${BIN}/nstack-learnings-search --query global-key`, {
      cwd: fakeRepo, env: { ...process.env, NSTACK_STATE_DIR: stateDir }, encoding: 'utf-8',
    });
    expect(localOnly).toContain('global-key');
    expect(localOnly).not.toContain('[cross-project]');
    // Search WITH --cross-project — picks up global enriched entry
    const cross = execSync(`${BIN}/nstack-learnings-search --cross-project --query global-key`, {
      cwd: fakeRepo, env: { ...process.env, NSTACK_STATE_DIR: stateDir }, encoding: 'utf-8',
    });
    expect(cross).toContain('global-key');
  });
});
