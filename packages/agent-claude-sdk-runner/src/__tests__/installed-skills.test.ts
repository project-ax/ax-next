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
      { id: 'github', files: [{ path: 'SKILL.md', contents: '---\nname: github\ndescription: x\n---\nBody' }] },
      { id: 'openai', files: [{ path: 'SKILL.md', contents: '---\nname: openai\ndescription: y\n---\nBody2' }] },
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

  it('materializes a multi-file bundle read-only and rejects traversal', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      {
        id: 'demo',
        files: [
          { path: 'SKILL.md', contents: '# x' },
          { path: 'scripts/a.py', contents: 'print(1)' },
        ],
      },
    ]);
    await materializeInstalledSkillsFromEnv();
    const body = await fs.readFile(path.join(tmpRoot, 'skills', 'demo', 'scripts', 'a.py'), 'utf8');
    expect(body).toBe('print(1)');
    const st = await fs.stat(path.join(tmpRoot, 'skills', 'demo', 'scripts', 'a.py'));
    // 0o444 = read-only for all (no write bits) — scripts run via interpreter,
    // never by exec permission.
    expect(st.mode & 0o222).toBe(0);

    // A second materialize with a traversal path must be rejected at the
    // runner's extract boundary (defense in depth — the wire schema also
    // rejects it, but the runner re-validates independently). Unlock the
    // skills dir first (the prior materialize chmod'd it 0555).
    await fs.chmod(path.join(tmpRoot, 'skills'), 0o755);
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      {
        id: 'demo2',
        files: [
          { path: 'SKILL.md', contents: '# x' },
          { path: '../escape.txt', contents: 'x' },
        ],
      },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(/invalid|escape/i);
  });

  it('rejects a reserved bundle path (.mcp.json) supplied as a file', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      {
        id: 'demo',
        files: [
          { path: 'SKILL.md', contents: '# x' },
          { path: '.mcp.json', contents: '{}' },
        ],
      },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(/reserved/i);
  });

  it('rejects a .claude/* SDK-config path supplied as a file', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      {
        id: 'demo',
        files: [
          { path: 'SKILL.md', contents: '# x' },
          { path: '.claude/settings.json', contents: '{}' },
        ],
      },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(/reserved/i);
  });

  it('throws when a bundle is missing SKILL.md', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      { id: 'demo', files: [{ path: 'a.txt', contents: 'x' }] },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(/missing SKILL\.md/);
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

  it('throws when an entry has no files array', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([{ id: 'github' }]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(
      /non-empty files array/,
    );
  });

  it('throws when an entry is missing id', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      { files: [{ path: 'SKILL.md', contents: 'x' }] },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(
      /must be { id, files } objects/,
    );
  });

  it('throws when entry is not an object', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify(['not-an-object']);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(
      /must be { id, files } objects/,
    );
  });

  it('throws when skill id has invalid shape (path traversal attempt)', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      { id: '../escape', files: [{ path: 'SKILL.md', contents: 'x' }] },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(/invalid shape/);
  });

  it('throws when skill id starts with uppercase', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      { id: 'GitHub', files: [{ path: 'SKILL.md', contents: 'x' }] },
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
        files: [{ path: 'SKILL.md', contents: '---\nname: github\n---\nbody' }],
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
      { id: 'github', files: [{ path: 'SKILL.md', contents: '---\nname: github\n---\nbody' }] },
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
        files: [{ path: 'SKILL.md', contents: '---\nname: remote\n---\nbody' }],
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

  // -------------------------------------------------------------------------
  // Transport-specific invariants + array caps (Phase B follow-up).
  //
  // validateMcpEntry is the runner's trust-boundary defense. A buggy or
  // compromised host could otherwise smuggle a cross-contaminated entry
  // (stdio with url, http with command, etc.) or an unbounded args/env
  // through to .mcp.json. These tests pin the rejection paths.
  // -------------------------------------------------------------------------

  it('throws when stdio mcpServers entry is missing command', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      {
        id: 'github',
        files: [{ path: 'SKILL.md', contents: '---\nname: github\n---\nbody' }],
        mcpServers: [
          { name: 'github', transport: 'stdio', allowedHosts: [], credentials: [] },
        ],
      },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(
      /stdio.*missing required 'command'/,
    );
  });

  it('throws when http mcpServers entry is missing url', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      {
        id: 'remote',
        files: [{ path: 'SKILL.md', contents: '---\nname: remote\n---\nbody' }],
        mcpServers: [
          { name: 'remote', transport: 'http', allowedHosts: [], credentials: [] },
        ],
      },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(
      /http.*missing required 'url'/,
    );
  });

  it('throws when stdio mcpServers entry also sets url (cross-contamination)', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      {
        id: 'github',
        files: [{ path: 'SKILL.md', contents: '---\nname: github\n---\nbody' }],
        mcpServers: [
          {
            name: 'github',
            transport: 'stdio',
            command: 'npx',
            url: 'https://evil.example.com',
            allowedHosts: [],
            credentials: [],
          },
        ],
      },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(
      /stdio.*must not set 'url'/,
    );
  });

  it('throws when http mcpServers entry also sets command (cross-contamination)', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      {
        id: 'remote',
        files: [{ path: 'SKILL.md', contents: '---\nname: remote\n---\nbody' }],
        mcpServers: [
          {
            name: 'remote',
            transport: 'http',
            url: 'https://mcp.example.com',
            command: 'npx',
            allowedHosts: [],
            credentials: [],
          },
        ],
      },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(
      /http.*must not set 'command'/,
    );
  });

  it('throws when mcpServers entry args has more than 32 entries', async () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `a${i}`);
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      {
        id: 'github',
        files: [{ path: 'SKILL.md', contents: '---\nname: github\n---\nbody' }],
        mcpServers: [
          {
            name: 'github',
            transport: 'stdio',
            command: 'npx',
            args: tooMany,
            allowedHosts: [],
            credentials: [],
          },
        ],
      },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(
      /too many args/,
    );
  });

  it('throws when mcpServers entry has an arg longer than 256 chars', async () => {
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      {
        id: 'github',
        files: [{ path: 'SKILL.md', contents: '---\nname: github\n---\nbody' }],
        mcpServers: [
          {
            name: 'github',
            transport: 'stdio',
            command: 'npx',
            args: ['x'.repeat(257)],
            allowedHosts: [],
            credentials: [],
          },
        ],
      },
    ]);
    await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(
      /arg over 256 chars/,
    );
  });
});
