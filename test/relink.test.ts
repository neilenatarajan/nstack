import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpDir: string;
let skillsDir: string;
let installDir: string;

function run(cmd: string, env: Record<string, string> = {}, expectFail = false): string {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      env: { ...process.env, NSTACK_STATE_DIR: tmpDir, ...env },
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    if (expectFail) return (e.stderr || e.stdout || '').toString().trim();
    throw e;
  }
}

// Create a mock nstack install directory with skill subdirs
function setupMockInstall(skills: string[]): void {
  installDir = path.join(tmpDir, 'nstack-install');
  skillsDir = path.join(tmpDir, 'skills');
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  // Copy the real nstack-config and nstack-relink to the mock install
  const mockBin = path.join(installDir, 'bin');
  fs.mkdirSync(mockBin, { recursive: true });
  fs.copyFileSync(path.join(BIN, 'nstack-config'), path.join(mockBin, 'nstack-config'));
  fs.chmodSync(path.join(mockBin, 'nstack-config'), 0o755);
  if (fs.existsSync(path.join(BIN, 'nstack-relink'))) {
    fs.copyFileSync(path.join(BIN, 'nstack-relink'), path.join(mockBin, 'nstack-relink'));
    fs.chmodSync(path.join(mockBin, 'nstack-relink'), 0o755);
  }
  if (fs.existsSync(path.join(BIN, 'nstack-patch-names'))) {
    fs.copyFileSync(path.join(BIN, 'nstack-patch-names'), path.join(mockBin, 'nstack-patch-names'));
    fs.chmodSync(path.join(mockBin, 'nstack-patch-names'), 0o755);
  }

  // Create mock skill directories with proper frontmatter
  for (const skill of skills) {
    fs.mkdirSync(path.join(installDir, skill), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, skill, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: test\n---\n# ${skill}`
    );
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nstack-relink-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('nstack-relink (always prefixed)', () => {
  test('creates nstack-* prefixed entries for all skills', () => {
    setupMockInstall(['qa', 'ship', 'review']);
    const output = run(`${path.join(installDir, 'bin', 'nstack-relink')}`, {
      NSTACK_INSTALL_DIR: installDir,
      NSTACK_SKILLS_DIR: skillsDir,
    });
    expect(fs.existsSync(path.join(skillsDir, 'nstack-qa'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'nstack-ship'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'nstack-review'))).toBe(true);
    expect(output).toContain('nstack-');
  });

  test('skills are real directories with SKILL.md symlinks, not dir symlinks', () => {
    setupMockInstall(['qa', 'ship', 'review', 'plan-ceo-review']);
    run(`${path.join(installDir, 'bin', 'nstack-relink')}`, {
      NSTACK_INSTALL_DIR: installDir,
      NSTACK_SKILLS_DIR: skillsDir,
    });
    for (const skill of ['nstack-qa', 'nstack-ship', 'nstack-review', 'nstack-plan-ceo-review']) {
      const skillPath = path.join(skillsDir, skill);
      const skillMdPath = path.join(skillPath, 'SKILL.md');
      // Must be a real directory, NOT a symlink
      expect(fs.lstatSync(skillPath).isDirectory()).toBe(true);
      expect(fs.lstatSync(skillPath).isSymbolicLink()).toBe(false);
      // Must contain a SKILL.md that IS a symlink
      expect(fs.existsSync(skillMdPath)).toBe(true);
      expect(fs.lstatSync(skillMdPath).isSymbolicLink()).toBe(true);
      // The SKILL.md symlink must point to the source skill's SKILL.md
      const target = fs.readlinkSync(skillMdPath);
      expect(target).toEndWith('/SKILL.md');
    }
  });

  test('upgrades old directory symlinks to real directories', () => {
    setupMockInstall(['qa', 'ship']);
    // Simulate old behavior: create directory symlinks (the old pattern)
    fs.symlinkSync(path.join(installDir, 'qa'), path.join(skillsDir, 'qa'));
    fs.symlinkSync(path.join(installDir, 'ship'), path.join(skillsDir, 'ship'));
    // Verify they start as symlinks
    expect(fs.lstatSync(path.join(skillsDir, 'qa')).isSymbolicLink()).toBe(true);

    run(`${path.join(installDir, 'bin', 'nstack-relink')}`, {
      NSTACK_INSTALL_DIR: installDir,
      NSTACK_SKILLS_DIR: skillsDir,
    });

    // After relink: old flat entries cleaned up, nstack-* entries are real dirs
    expect(fs.existsSync(path.join(skillsDir, 'qa'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'ship'))).toBe(false);
    expect(fs.lstatSync(path.join(skillsDir, 'nstack-qa')).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(skillsDir, 'nstack-qa')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(skillsDir, 'nstack-qa', 'SKILL.md')).isSymbolicLink()).toBe(true);
  });

  test('cleans up old flat (unprefixed) entries on relink', () => {
    setupMockInstall(['qa', 'ship', 'review']);
    // Simulate old flat entries (pre-always-prefix era)
    for (const skill of ['qa', 'ship', 'review']) {
      const dir = path.join(skillsDir, skill);
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(path.join(installDir, skill, 'SKILL.md'), path.join(dir, 'SKILL.md'));
    }
    expect(fs.existsSync(path.join(skillsDir, 'qa'))).toBe(true);

    run(`${path.join(installDir, 'bin', 'nstack-relink')}`, {
      NSTACK_INSTALL_DIR: installDir,
      NSTACK_SKILLS_DIR: skillsDir,
    });

    // Old flat entries removed, nstack-* entries created
    expect(fs.existsSync(path.join(skillsDir, 'qa'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'ship'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'review'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'nstack-qa'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'nstack-ship'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'nstack-review'))).toBe(true);
  });

  test('does not double-prefix nstack-upgrade directory', () => {
    setupMockInstall(['qa', 'ship', 'nstack-upgrade']);
    run(`${path.join(installDir, 'bin', 'nstack-relink')}`, {
      NSTACK_INSTALL_DIR: installDir,
      NSTACK_SKILLS_DIR: skillsDir,
    });
    // nstack-upgrade should keep its name, NOT become nstack-nstack-upgrade
    expect(fs.existsSync(path.join(skillsDir, 'nstack-upgrade'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'nstack-nstack-upgrade'))).toBe(false);
    // Regular skills still get prefixed
    expect(fs.existsSync(path.join(skillsDir, 'nstack-qa'))).toBe(true);
  });

  test('only nstack-* entries exist after fresh install', () => {
    setupMockInstall(['qa', 'ship', 'review', 'plan-ceo-review', 'nstack-upgrade']);
    run(`${path.join(installDir, 'bin', 'nstack-relink')}`, {
      NSTACK_INSTALL_DIR: installDir,
      NSTACK_SKILLS_DIR: skillsDir,
    });
    const entries = fs.readdirSync(skillsDir);
    expect(entries.sort()).toEqual([
      'nstack-plan-ceo-review', 'nstack-qa', 'nstack-review', 'nstack-ship', 'nstack-upgrade',
    ]);
    // No unprefixed entries
    const leaked = entries.filter(e => !e.startsWith('nstack-'));
    expect(leaked).toEqual([]);
  });

  test('prints error when install dir missing', () => {
    const output = run(`${BIN}/nstack-relink`, {
      NSTACK_INSTALL_DIR: '/nonexistent/path/nstack',
      NSTACK_SKILLS_DIR: '/nonexistent/path/skills',
    }, true);
    expect(output).toContain('setup');
  });
});

describe('upgrade migrations', () => {
  const MIGRATIONS_DIR = path.join(ROOT, 'nstack-upgrade', 'migrations');

  test('migrations directory exists', () => {
    expect(fs.existsSync(MIGRATIONS_DIR)).toBe(true);
  });

  test('all migration scripts are executable and parse without syntax errors', () => {
    const scripts = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sh'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      const fullPath = path.join(MIGRATIONS_DIR, script);
      // Must be executable
      const stat = fs.statSync(fullPath);
      expect(stat.mode & 0o111).toBeGreaterThan(0);
      // Must parse without syntax errors (bash -n is a syntax check, doesn't execute)
      execSync(`bash -n "${fullPath}" 2>&1`, { encoding: 'utf-8', timeout: 5000 });
    }
  });

  test('migration filenames follow v{VERSION}.sh pattern', () => {
    const scripts = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sh'));
    for (const script of scripts) {
      expect(script).toMatch(/^v\d+\.\d+\.\d+\.\d+\.sh$/);
    }
  });

  test('v0.15.2.0 migration runs nstack-relink', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, 'v0.15.2.0.sh'), 'utf-8');
    expect(content).toContain('nstack-relink');
  });

  test('v0.17.0.0 migration removes skill_prefix from config', () => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, 'v0.17.0.0.sh'), 'utf-8');
    expect(content).toContain('skill_prefix');
    expect(content).toContain('nstack-relink');
  });

  test('v0.17.0.0 migration cleans up skill_prefix from global config', () => {
    setupMockInstall(['qa', 'ship']);
    // Create a config with skill_prefix
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), 'proactive: true\nskill_prefix: false\nauto_upgrade: false\n');

    run(`bash ${path.join(MIGRATIONS_DIR, 'v0.17.0.0.sh')}`, {
      NSTACK_STATE_DIR: configDir,
      NSTACK_INSTALL_DIR: installDir,
      NSTACK_SKILLS_DIR: skillsDir,
    });

    // skill_prefix should be removed, other keys preserved
    const config = fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf-8');
    expect(config).not.toContain('skill_prefix');
    expect(config).toContain('proactive: true');
    expect(config).toContain('auto_upgrade: false');
  });
});

describe('nstack-patch-names (always prefixed)', () => {
  // Helper to read name: from SKILL.md frontmatter
  function readSkillName(skillDir: string): string | null {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const match = content.match(/^name:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  }

  test('patches name: field with nstack- prefix', () => {
    setupMockInstall(['qa', 'ship', 'review']);
    run(`${path.join(installDir, 'bin', 'nstack-relink')}`, {
      NSTACK_INSTALL_DIR: installDir,
      NSTACK_SKILLS_DIR: skillsDir,
    });
    // Verify name: field is patched with nstack- prefix
    expect(readSkillName(path.join(installDir, 'qa'))).toBe('nstack-qa');
    expect(readSkillName(path.join(installDir, 'ship'))).toBe('nstack-ship');
    expect(readSkillName(path.join(installDir, 'review'))).toBe('nstack-review');
  });

  test('nstack-upgrade name: not double-prefixed', () => {
    setupMockInstall(['qa', 'nstack-upgrade']);
    run(`${path.join(installDir, 'bin', 'nstack-relink')}`, {
      NSTACK_INSTALL_DIR: installDir,
      NSTACK_SKILLS_DIR: skillsDir,
    });
    // nstack-upgrade should keep its name, NOT become nstack-nstack-upgrade
    expect(readSkillName(path.join(installDir, 'nstack-upgrade'))).toBe('nstack-upgrade');
    // Regular skill should be prefixed
    expect(readSkillName(path.join(installDir, 'qa'))).toBe('nstack-qa');
  });

  test('SKILL.md without frontmatter is a no-op', () => {
    setupMockInstall(['qa']);
    // Overwrite qa SKILL.md with no frontmatter
    fs.writeFileSync(path.join(installDir, 'qa', 'SKILL.md'), '# qa\nSome content.');
    // Should not crash
    run(`${path.join(installDir, 'bin', 'nstack-relink')}`, {
      NSTACK_INSTALL_DIR: installDir,
      NSTACK_SKILLS_DIR: skillsDir,
    });
    // Content should be unchanged (no name: to patch)
    const content = fs.readFileSync(path.join(installDir, 'qa', 'SKILL.md'), 'utf-8');
    expect(content).toBe('# qa\nSome content.');
  });
});
