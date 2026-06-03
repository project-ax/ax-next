import { describe, expect, it } from 'vitest';
import {
  AgentConfigSchema,
  InstalledSkillSchema,
  McpServerSchema,
  OpenSessionInputSchema,
  OpenSessionResultSchema,
  ProxyConfigSchema,
} from '../schemas.js';

// ---------------------------------------------------------------------------
// @ax/sandbox-protocol — shared contract for the `sandbox:open-session` payload.
//
// These schemas WERE duplicated (and drifting) across @ax/sandbox-k8s,
// @ax/sandbox-subprocess, and @ax/chat-orchestrator. This package is the single
// source of truth; the tests below pin the contract so a future loosening
// (e.g. widening `max(32)`, dropping the transport refine, or relaxing the
// ProxyConfig exactly-one-of invariant) flips an assertion and we notice.
//
// Strictness note: the canonical ProxyConfigSchema is the STRICTER of the two
// former variants — `endpoint`/`unixSocketPath` are non-empty and mutually
// exclusive (exactly one). The k8s backend previously accepted neither/both;
// converging up tightens that boundary.
// ---------------------------------------------------------------------------

// --- McpServerSchema --------------------------------------------------------

function validStdioServer(): Record<string, unknown> {
  return {
    name: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'pkg'],
    env: {},
    allowedHosts: [],
    credentials: [],
  };
}

describe('McpServerSchema', () => {
  it('accepts a valid stdio entry', () => {
    expect(McpServerSchema.safeParse(validStdioServer()).success).toBe(true);
  });

  it('accepts a valid http entry', () => {
    const result = McpServerSchema.safeParse({
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com',
      allowedHosts: [],
      credentials: [],
    });
    expect(result.success).toBe(true);
  });

  it('defaults allowedHosts and credentials to empty arrays', () => {
    const result = McpServerSchema.parse({
      name: 'github',
      transport: 'stdio',
      command: 'npx',
    });
    expect(result.allowedHosts).toEqual([]);
    expect(result.credentials).toEqual([]);
  });

  it('rejects a name that does not match the id regex', () => {
    const result = McpServerSchema.safeParse({
      ...validStdioServer(),
      name: 'GitHub',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a transport that is neither stdio nor http', () => {
    const result = McpServerSchema.safeParse({
      ...validStdioServer(),
      transport: 'websocket',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an args array with more than 32 entries', () => {
    const result = McpServerSchema.safeParse({
      ...validStdioServer(),
      args: Array.from({ length: 33 }, (_, i) => `a${i}`),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an individual arg longer than 256 chars', () => {
    const result = McpServerSchema.safeParse({
      ...validStdioServer(),
      args: ['x'.repeat(257)],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a stdio entry missing command', () => {
    const { command: _c, ...rest } = validStdioServer();
    expect(McpServerSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a stdio entry with an empty command', () => {
    const result = McpServerSchema.safeParse({
      ...validStdioServer(),
      command: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an http entry missing url', () => {
    const result = McpServerSchema.safeParse({
      name: 'remote',
      transport: 'http',
      allowedHosts: [],
      credentials: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a stdio entry that also sets url (cross-contamination)', () => {
    const result = McpServerSchema.safeParse({
      ...validStdioServer(),
      url: 'https://evil.example.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an http entry that also sets command (cross-contamination)', () => {
    const result = McpServerSchema.safeParse({
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com',
      command: 'npx',
      allowedHosts: [],
      credentials: [],
    });
    expect(result.success).toBe(false);
  });

  // TASK-18 — env caps now match the runner's validateMcpEntry
  // (MCP_ENV_MAX=32, MCP_ENV_LEN_MAX=256) and the upstream manifest parser, so
  // the host rejects oversize env early instead of leaning on the runner (the
  // last gate). A future loosening of these caps flips one of these.
  it('accepts an env with exactly 32 entries (boundary)', () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 32; i++) env[`K${i}`] = 'v';
    const result = McpServerSchema.safeParse({ ...validStdioServer(), env });
    expect(result.success).toBe(true);
  });

  it('rejects an env with more than 32 entries', () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 33; i++) env[`K${i}`] = 'v';
    const result = McpServerSchema.safeParse({ ...validStdioServer(), env });
    expect(result.success).toBe(false);
  });

  it('accepts an env key/value at exactly 256 chars (boundary)', () => {
    const result = McpServerSchema.safeParse({
      ...validStdioServer(),
      env: { ['k'.repeat(256)]: 'v'.repeat(256) },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an env key longer than 256 chars', () => {
    const result = McpServerSchema.safeParse({
      ...validStdioServer(),
      env: { ['k'.repeat(257)]: 'v' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an env value longer than 256 chars', () => {
    const result = McpServerSchema.safeParse({
      ...validStdioServer(),
      env: { K: 'v'.repeat(257) },
    });
    expect(result.success).toBe(false);
  });
});

// --- InstalledSkillSchema ---------------------------------------------------

describe('InstalledSkillSchema', () => {
  it('accepts a valid single-file skill (SKILL.md only)', () => {
    const result = InstalledSkillSchema.safeParse({
      id: 'github',
      files: [{ path: 'SKILL.md', contents: '---\nname: github\n---\nbody' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a multi-file bundle (SKILL.md + extras)', () => {
    const result = InstalledSkillSchema.safeParse({
      id: 'demo',
      files: [
        { path: 'SKILL.md', contents: '# x' },
        { path: 'scripts/a.py', contents: 'print(1)' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('defaults mcpServers to an empty array', () => {
    const parsed = InstalledSkillSchema.parse({
      id: 'github',
      files: [{ path: 'SKILL.md', contents: 'body' }],
    });
    expect(parsed.mcpServers).toEqual([]);
  });

  it('rejects an invalid id shape', () => {
    const result = InstalledSkillSchema.safeParse({
      id: 'Github',
      files: [{ path: 'SKILL.md', contents: 'body' }],
    });
    expect(result.success).toBe(false);
  });

  it('requires a SKILL.md file', () => {
    const result = InstalledSkillSchema.safeParse({
      id: 'demo',
      files: [{ path: 'a.txt', contents: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty files array', () => {
    const result = InstalledSkillSchema.safeParse({ id: 'github', files: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a file path that traverses out of the dir', () => {
    const result = InstalledSkillSchema.safeParse({
      id: 'demo',
      files: [
        { path: 'SKILL.md', contents: '# x' },
        { path: '../escape.txt', contents: 'x' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an absolute file path', () => {
    const result = InstalledSkillSchema.safeParse({
      id: 'demo',
      files: [
        { path: 'SKILL.md', contents: '# x' },
        { path: '/abs.txt', contents: 'x' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects single-dot path segments (. and a/./b)', () => {
    for (const bad of ['.', 'scripts/./run.py']) {
      const result = InstalledSkillSchema.safeParse({
        id: 'demo',
        files: [
          { path: 'SKILL.md', contents: '# x' },
          { path: bad, contents: 'x' },
        ],
      });
      expect(result.success).toBe(false);
    }
  });

  it('vetoes reserved paths at the wire (.mcp.json, .claude/*, .git/*) — SKILL.md is the only exception', () => {
    for (const bad of ['.mcp.json', '.mcp.json/foo', '.claude', '.claude/settings.json', '.git', '.git/config']) {
      const result = InstalledSkillSchema.safeParse({
        id: 'demo',
        files: [
          { path: 'SKILL.md', contents: '# x' },
          { path: bad, contents: 'x' },
        ],
      });
      expect(result.success).toBe(false);
    }
  });

  it('rejects a file over the 256 KiB per-file cap', () => {
    const result = InstalledSkillSchema.safeParse({
      id: 'github',
      files: [{ path: 'SKILL.md', contents: 'x'.repeat(256 * 1024 + 1) }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 24 files', () => {
    const files = [
      { path: 'SKILL.md', contents: '# x' },
      ...Array.from({ length: 24 }, (_, i) => ({ path: `f${i}.txt`, contents: 'x' })),
    ];
    const result = InstalledSkillSchema.safeParse({ id: 'github', files });
    expect(result.success).toBe(false);
  });

  it('rejects more than 8 mcpServers', () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      name: `srv-${i}`,
      transport: 'stdio' as const,
      command: 'npx',
      args: [],
      env: {},
      allowedHosts: [],
      credentials: [],
    }));
    const result = InstalledSkillSchema.safeParse({
      id: 'github',
      files: [{ path: 'SKILL.md', contents: 'body' }],
      mcpServers: tooMany,
    });
    expect(result.success).toBe(false);
  });
});

// --- ProxyConfigSchema (the strict, converged variant) ----------------------

describe('ProxyConfigSchema', () => {
  it('accepts an endpoint-only config', () => {
    const result = ProxyConfigSchema.safeParse({
      endpoint: 'http://127.0.0.1:54321',
      caCertPem: 'PEM',
      envMap: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts a unixSocketPath-only config', () => {
    const result = ProxyConfigSchema.safeParse({
      unixSocketPath: '/var/run/ax/proxy.sock',
      caCertPem: 'PEM',
      envMap: {},
    });
    expect(result.success).toBe(true);
  });

  it('rejects a config with NEITHER endpoint nor unixSocketPath', () => {
    const result = ProxyConfigSchema.safeParse({ caCertPem: 'PEM', envMap: {} });
    expect(result.success).toBe(false);
  });

  it('rejects a config with BOTH endpoint and unixSocketPath', () => {
    const result = ProxyConfigSchema.safeParse({
      endpoint: 'http://127.0.0.1:54321',
      unixSocketPath: '/var/run/ax/proxy.sock',
      caCertPem: 'PEM',
      envMap: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string endpoint', () => {
    const result = ProxyConfigSchema.safeParse({
      endpoint: '',
      caCertPem: 'PEM',
      envMap: {},
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional 32-hex proxyAuthToken (TASK-52)', () => {
    const result = ProxyConfigSchema.safeParse({
      endpoint: 'http://127.0.0.1:54321',
      caCertPem: 'PEM',
      envMap: {},
      proxyAuthToken: 'a'.repeat(32),
    });
    expect(result.success).toBe(true);
    // Back-compat: still valid without it.
    const legacy = ProxyConfigSchema.safeParse({
      endpoint: 'http://127.0.0.1:54321',
      caCertPem: 'PEM',
      envMap: {},
    });
    expect(legacy.success).toBe(true);
  });

  it('rejects a malformed proxyAuthToken (not 32-hex)', () => {
    const result = ProxyConfigSchema.safeParse({
      endpoint: 'http://127.0.0.1:54321',
      caCertPem: 'PEM',
      envMap: {},
      proxyAuthToken: 'not-a-hex-token',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing caCertPem', () => {
    const result = ProxyConfigSchema.safeParse({
      endpoint: 'http://127.0.0.1:54321',
      envMap: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string envMap value', () => {
    const result = ProxyConfigSchema.safeParse({
      endpoint: 'http://127.0.0.1:54321',
      caCertPem: 'PEM',
      envMap: { ANTHROPIC_API_KEY: 42 },
    });
    expect(result.success).toBe(false);
  });
});

// --- AgentConfigSchema ------------------------------------------------------

describe('AgentConfigSchema', () => {
  it('accepts a valid agent config', () => {
    const result = AgentConfigSchema.safeParse({
      displayName: 'Helper',
      systemPromptAugment: 'be helpful',
      allowedTools: ['Read'],
      mcpConfigIds: [],
      model: 'claude',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing model', () => {
    const result = AgentConfigSchema.safeParse({
      displayName: 'Helper',
      systemPromptAugment: 'be helpful',
      allowedTools: [],
      mcpConfigIds: [],
    });
    expect(result.success).toBe(false);
  });
});

// --- OpenSessionInputSchema (envelope) --------------------------------------

function validOpenSessionInput(): unknown {
  return {
    sessionId: 'sess-base',
    workspaceRoot: '/tmp/ws',
    runnerBinary: '/opt/ax/runner.js',
    installedSkills: [
      {
        id: 'github',
        files: [{ path: 'SKILL.md', contents: '---\nname: github\n---\nbody' }],
        mcpServers: [validStdioServer()],
      },
    ],
  };
}

describe('OpenSessionInputSchema', () => {
  it('accepts a minimal valid input (only required fields)', () => {
    const result = OpenSessionInputSchema.safeParse({
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a full valid input', () => {
    const result = OpenSessionInputSchema.safeParse(validOpenSessionInput());
    expect(result.success).toBe(true);
  });

  it('rejects a relative workspaceRoot', () => {
    const result = OpenSessionInputSchema.safeParse({
      sessionId: 'sess-1',
      workspaceRoot: 'relative/ws',
      runnerBinary: '/opt/ax/runner.js',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a relative runnerBinary', () => {
    const result = OpenSessionInputSchema.safeParse({
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/ws',
      runnerBinary: 'runner.js',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty sessionId', () => {
    const result = OpenSessionInputSchema.safeParse({
      sessionId: '',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 50 installedSkills', () => {
    const skills = Array.from({ length: 51 }, (_, i) => ({
      id: `skill-${i}`,
      files: [{ path: 'SKILL.md', contents: 'body' }],
    }));
    const result = OpenSessionInputSchema.safeParse({
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
      installedSkills: skills,
    });
    expect(result.success).toBe(false);
  });

  it('propagates a bad nested mcpServers entry to a rejection', () => {
    const bad = validOpenSessionInput() as {
      installedSkills: Array<{ mcpServers: Record<string, unknown>[] }>;
    };
    bad.installedSkills[0]!.mcpServers = [
      { name: 'github', transport: 'stdio', allowedHosts: [], credentials: [] },
    ];
    expect(OpenSessionInputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a proxyConfig that sets both endpoint and unixSocketPath', () => {
    const result = OpenSessionInputSchema.safeParse({
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
      proxyConfig: {
        endpoint: 'http://127.0.0.1:1',
        unixSocketPath: '/var/run/ax/proxy.sock',
        caCertPem: 'PEM',
        envMap: {},
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `sandbox:open-session` RETURN contract (ARCH-6). The result carries a LIVE
// `handle` (functions + Promise). A strict object schema would strip it; the
// `.passthrough()` schema must keep it intact while still asserting the
// opaque `runnerEndpoint`.
// ---------------------------------------------------------------------------
describe('OpenSessionResultSchema', () => {
  it('accepts a result with a non-empty runnerEndpoint', () => {
    expect(
      OpenSessionResultSchema.safeParse({ runnerEndpoint: 'unix:///run/ax.sock' }).success,
    ).toBe(true);
  });

  it('rejects a missing or empty runnerEndpoint', () => {
    expect(OpenSessionResultSchema.safeParse({}).success).toBe(false);
    expect(OpenSessionResultSchema.safeParse({ runnerEndpoint: '' }).success).toBe(false);
  });

  it('PRESERVES the live handle through validation (passthrough, not strip)', () => {
    const handle = {
      kill: () => Promise.resolve(),
      exited: Promise.resolve({ code: 0 }),
    };
    const result = { runnerEndpoint: 'http://10.0.0.1:7777', handle };
    const parsed = OpenSessionResultSchema.parse(result) as typeof result;
    // The handle object must survive by reference — a strict schema would
    // have dropped it, breaking the orchestrator's session teardown.
    expect(parsed.handle).toBe(handle);
    expect(typeof parsed.handle.kill).toBe('function');
    expect(parsed.runnerEndpoint).toBe('http://10.0.0.1:7777');
  });
});
