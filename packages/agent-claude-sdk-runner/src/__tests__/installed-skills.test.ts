import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { materializeInstalledSkillsFromEnv } from '../installed-skills.js';

// ---------------------------------------------------------------------------
// materializeInstalledSkillsFromEnv tests.
//
// Uses a real tmpdir to exercise fs paths end-to-end. Each test gets a fresh
// tmpdir (created in beforeEach, removed in afterEach). process.env is saved
// and restored so tests don't bleed into each other.
//
// These tests also serve as the regression net for "AX_INSTALLED_SKILLS_JSON
// is NOT forwarded into the SDK subprocess" — that constraint is enforced by
// its absence from ENV_ALLOWLIST (proxy-startup.ts), not from this module's
// code; see proxy-startup.test.ts for that assertion.
// ---------------------------------------------------------------------------

let tmpRoot: string;
const savedEnv: Record<string, string | undefined> = {};

function saveEnvKey(key: string): void {
  savedEnv[key] = process.env[key];
}
function restoreEnvKeys(): void {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mat-skills-'));
  saveEnvKey('CLAUDE_CONFIG_DIR');
  saveEnvKey('AX_INSTALLED_SKILLS_JSON');
  process.env['CLAUDE_CONFIG_DIR'] = tmpRoot;
  delete process.env['AX_INSTALLED_SKILLS_JSON'];
});

afterEach(async () => {
  restoreEnvKeys();
  // Unlock the skills dir before cleanup — materializeInstalledSkillsFromEnv
  // chmods it to 0555, and fs.rm({ recursive: true }) cannot rmdir from a
  // 0555 dir on macOS (EACCES). Best-effort: if it doesn't exist, ignore.
  await fs.chmod(path.join(tmpRoot, 'skills'), 0o755).catch(() => undefined);
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('materializeInstalledSkillsFromEnv', () => {
  it('is a no-op when AX_INSTALLED_SKILLS_JSON is unset', async () => {
    await expect(materializeInstalledSkillsFromEnv()).resolves.toBeUndefined();
    // skills/ dir should NOT exist (we didn't create it)
    await expect(fs.stat(path.join(tmpRoot, 'skills'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('is a no-op when AX_INSTALLED_SKILLS_JSON is empty string', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = '';
    await expect(materializeInstalledSkillsFromEnv()).resolves.toBeUndefined();
  });

  it('is a no-op when AX_INSTALLED_SKILLS_JSON is an empty array (no chmod ENOENT)', async () => {
    // Distinct bootstrap path: well-formed empty array. Must not throw
    // ENOENT on chmod of a never-created skills dir, and must not
    // surprise-create one in prod (init container already did that).
    process.env['AX_INSTALLED_SKILLS_JSON'] = '[]';
    await expect(materializeInstalledSkillsFromEnv()).resolves.toBeUndefined();
    await expect(fs.stat(path.join(tmpRoot, 'skills'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('writes each skill SKILL.md and chmods parent dir to 0555', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      { id: 'github', skillMd: '---\nname: github\ndescription: x\n---\nBody' },
      { id: 'openai', skillMd: '---\nname: openai\ndescription: y\n---\nBody2' },
    ]);
    await materializeInstalledSkillsFromEnv();

    const ghContent = await fs.readFile(
      path.join(tmpRoot, 'skills', 'github', 'SKILL.md'),
      'utf8',
    );
    expect(ghContent).toContain('name: github');
    expect(ghContent).toContain('Body');

    const oaiContent = await fs.readFile(
      path.join(tmpRoot, 'skills', 'openai', 'SKILL.md'),
      'utf8',
    );
    expect(oaiContent).toContain('name: openai');
    expect(oaiContent).toContain('Body2');

    const skillsDirStat = await fs.stat(path.join(tmpRoot, 'skills'));
    // 0o555 = read+execute for all, no write
    expect(skillsDirStat.mode & 0o777).toBe(0o555);
  });

  it('throws when AX_INSTALLED_SKILLS_JSON is set but CLAUDE_CONFIG_DIR is missing', async () => {
    delete process.env['CLAUDE_CONFIG_DIR'];
    process.env['AX_INSTALLED_SKILLS_JSON'] = '[]';
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(/CLAUDE_CONFIG_DIR/);
  });

  it('throws on invalid JSON', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = '{not json}';
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(/not valid JSON/);
  });

  it('throws when root is not an array', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = '{}';
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(/must be an array/);
  });

  it('throws when an entry is missing skillMd', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([{ id: 'github' }]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(
      /must be { id, skillMd } objects/,
    );
  });

  it('throws when an entry is missing id', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([{ skillMd: 'x' }]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(
      /must be { id, skillMd } objects/,
    );
  });

  it('throws when entry is not an object', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify(['not-an-object']);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(
      /must be { id, skillMd } objects/,
    );
  });

  it('throws when skill id has invalid shape (path traversal attempt)', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      { id: '../escape', skillMd: 'x' },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(/invalid shape/);
  });

  it('throws when skill id starts with uppercase', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      { id: 'GitHub', skillMd: 'x' },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(/invalid shape/);
  });

  // -------------------------------------------------------------------------
  // Phase B (capabilities.mcpServers) — materialize a per-skill `.mcp.json`
  // alongside SKILL.md so the SDK auto-discovers bundled MCP servers via its
  // `'project'` setting source. Empty / absent mcpServers must NOT create
  // the file. http and stdio transports produce different JSON shapes.
  // -------------------------------------------------------------------------

  it('writes .mcp.json alongside SKILL.md when the skill declares mcpServers', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      {
        id: 'github',
        skillMd: '---\nname: github\n---\nbody',
        mcpServers: [
          {
            name: 'github',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'pkg'],
            env: {},
            allowedHosts: [],
            credentials: [],
          },
        ],
      },
    ]);
    await materializeInstalledSkillsFromEnv();
    const mcpJson = JSON.parse(
      await fs.readFile(path.join(tmpRoot, 'skills', 'github', '.mcp.json'), 'utf8'),
    );
    expect(mcpJson.mcpServers.github).toEqual({
      command: 'npx',
      args: ['-y', 'pkg'],
      env: {},
    });
  });

  it('does NOT write .mcp.json when the skill has no mcpServers', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      { id: 'github', skillMd: '---\nname: github\n---\nbody' },
    ]);
    await materializeInstalledSkillsFromEnv();
    await expect(
      fs.stat(path.join(tmpRoot, 'skills', 'github', '.mcp.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes .mcp.json with http transport shape', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      {
        id: 'remote',
        skillMd: '---\nname: remote\n---\nbody',
        mcpServers: [
          {
            name: 'remote',
            transport: 'http',
            url: 'https://mcp.example.com',
            allowedHosts: [],
            credentials: [],
          },
        ],
      },
    ]);
    await materializeInstalledSkillsFromEnv();
    const mcpJson = JSON.parse(
      await fs.readFile(path.join(tmpRoot, 'skills', 'remote', '.mcp.json'), 'utf8'),
    );
    expect(mcpJson.mcpServers.remote).toEqual({
      url: 'https://mcp.example.com',
      type: 'http',
    });
  });
});
