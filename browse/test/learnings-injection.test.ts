import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT_PATH = path.join(import.meta.dir, '../../bin/nstack-learnings-search');
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf-8');
const BIN_DIR = path.join(import.meta.dir, '../../bin');

describe('nstack-learnings-search injection safety', () => {
  // The bun invocation may be `bun -e ...` or `"$BUN_BIN" -e ...` depending on
  // how the script resolves bun. Match either form.
  const idx = SCRIPT.search(/(bun|BUN_BIN")\s+-e/);

  it('must not interpolate variables into JS string literals', () => {
    expect(idx).toBeGreaterThanOrEqual(0);
    const jsBlock = SCRIPT.slice(idx);
    expect(jsBlock).not.toMatch(/const \w+ = '\$\{/);
    expect(jsBlock).not.toMatch(/= \$\{[A-Z_]+\};/);
    expect(jsBlock).not.toMatch(/'\$\{CROSS_PROJECT\}'/);
  });

  it('must use process.env for parameters', () => {
    expect(idx).toBeGreaterThanOrEqual(0);
    const jsBlock = SCRIPT.slice(idx);
    expect(jsBlock).toContain('process.env');
  });
});

describe('nstack-learnings-search injection behavioral', () => {
  it('handles single quotes in query safely', () => {
    const result = spawnSync('bash', [
      path.join(BIN_DIR, 'nstack-learnings-search'),
      '--query', "test'; process.exit(99); //",
      '--limit', '1'
    ], { encoding: 'utf-8', timeout: 5000, env: { ...process.env, HOME: '/tmp/nonexistent-nstack-test' } });
    expect(result.status).not.toBe(99);
  });
});
