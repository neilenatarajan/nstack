import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let stateDir: string;
let fakeRepo: string;

function run(cmd: string, opts: { cwd?: string; expectFail?: boolean } = {}): { stdout: string; stderr: string; exitCode: number } {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: opts.cwd ?? fakeRepo,
    env: { ...process.env, NSTACK_STATE_DIR: stateDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    const stdout = execSync(cmd, execOpts).trim();
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    if (opts.expectFail || e.status) {
      return { stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '', exitCode: e.status ?? 1 };
    }
    throw e;
  }
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nstack-registry-state-'));
  fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'nstack-registry-repo-'));
  // realpath so registry stores the same path the test asserts against
  fakeRepo = fs.realpathSync(fakeRepo);
  execSync('git init -q . && git remote add origin git@example.com:foo/bar.git', { cwd: fakeRepo });
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(fakeRepo, { recursive: true, force: true });
});

describe('nstack-registry', () => {
  test('add is no-op when cross_project_learnings is unset/false', () => {
    run(`${BIN}/nstack-registry add`);
    const registry = path.join(stateDir, 'projects.yaml');
    expect(fs.existsSync(registry)).toBe(false);
  });

  test('add registers the current repo when opted in', () => {
    run(`${BIN}/nstack-config set --local cross_project_learnings true`);
    run(`${BIN}/nstack-registry add`);
    const registry = path.join(stateDir, 'projects.yaml');
    expect(fs.existsSync(registry)).toBe(true);
    const content = fs.readFileSync(registry, 'utf-8');
    expect(content).toContain(`"${fakeRepo}":`);
    expect(content).toContain('slug:');
    expect(content).toContain('archived: false');
  });

  test('add is idempotent — second add updates last_seen but keeps added', async () => {
    run(`${BIN}/nstack-config set --local cross_project_learnings true`);
    run(`${BIN}/nstack-registry add`);
    const registry = path.join(stateDir, 'projects.yaml');
    const first = fs.readFileSync(registry, 'utf-8');
    const firstAdded = first.match(/added: ([\dTZ:.-]+)/)?.[1];
    // wait > 1s so timestamps differ
    await Bun.sleep(1100);
    run(`${BIN}/nstack-registry add`);
    const second = fs.readFileSync(registry, 'utf-8');
    const secondAdded = second.match(/added: ([\dTZ:.-]+)/)?.[1];
    const secondLastSeen = second.match(/last_seen: ([\dTZ:.-]+)/)?.[1];
    expect(secondAdded).toBe(firstAdded!); // added unchanged
    expect(secondLastSeen).not.toBe(firstAdded!); // last_seen updated
    // Single entry, not two
    const entryCount = (second.match(/^  "/gm) || []).length;
    expect(entryCount).toBe(1);
  });

  test('list prints TSV header even when empty (no projects.yaml)', () => {
    const r = run(`${BIN}/nstack-registry list`);
    expect(r.stdout).toContain('no projects registered');
  });

  test('status reports unregistered when no entry exists', () => {
    const r = run(`${BIN}/nstack-registry status`);
    expect(r.stdout).toContain(`repo:`);
    expect(r.stdout).toContain(`registered:           no`);
  });

  test('status reports registered after add', () => {
    run(`${BIN}/nstack-config set --local cross_project_learnings true`);
    run(`${BIN}/nstack-registry add`);
    const r = run(`${BIN}/nstack-registry status`);
    expect(r.stdout).toContain('registered:           yes');
    expect(r.stdout).toContain('archived:             false');
  });

  test('remove --local removes the current repo entry', () => {
    run(`${BIN}/nstack-config set --local cross_project_learnings true`);
    run(`${BIN}/nstack-registry add`);
    run(`${BIN}/nstack-registry remove --local`);
    const registry = path.join(stateDir, 'projects.yaml');
    const content = fs.readFileSync(registry, 'utf-8');
    expect(content).not.toContain(`"${fakeRepo}":`);
  });

  test('prune marks missing paths as archived', () => {
    run(`${BIN}/nstack-config set --local cross_project_learnings true`);
    run(`${BIN}/nstack-registry add`);
    // Inject a fake stale entry
    const registry = path.join(stateDir, 'projects.yaml');
    fs.appendFileSync(registry, `  "/nonexistent/path/zzz":
    slug: ghost
    added: 2026-01-01T00:00:00Z
    last_seen: 2026-01-01T00:00:00Z
    archived: false
`);
    const r = run(`${BIN}/nstack-registry prune`);
    expect(r.stdout).toContain('ARCHIVED: /nonexistent/path/zzz');
    const after = fs.readFileSync(registry, 'utf-8');
    // Real entry preserved (archived: false)
    expect(after).toContain(`"${fakeRepo}"`);
    // Ghost entry marked archived: true
    expect(after).toMatch(/"\/nonexistent\/path\/zzz":[\s\S]*archived: true/);
  });

  test('opt-out cascade: setting cross_project_learnings=false auto-removes from registry', () => {
    run(`${BIN}/nstack-config set --local cross_project_learnings true`);
    run(`${BIN}/nstack-registry add`);
    const registry = path.join(stateDir, 'projects.yaml');
    expect(fs.readFileSync(registry, 'utf-8')).toContain(`"${fakeRepo}":`);
    run(`${BIN}/nstack-config set --local cross_project_learnings false`);
    expect(fs.readFileSync(registry, 'utf-8')).not.toContain(`"${fakeRepo}":`);
  });
});
