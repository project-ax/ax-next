import { describe, expect, it } from 'vitest';
import {
  AgentConfigSchema,
  InstalledSkillSchema,
  McpServerSchema,
  OpenSessionInputSchema,
  OpenSessionResultSchema,
  ProxyConfigSchema,
  ServiceDescriptorSchema,
} from '../schemas.js';

const PINNED_IMAGE = 'docker.io/library/postgres@sha256:' + 'a'.repeat(64);

function validServiceDescriptor(): Record<string, unknown> {
  return {
    name: 'postgres',
    image: PINNED_IMAGE,
    ports: [5432],
    env: { POSTGRES_PASSWORD: 'x' },
    healthcheck: { kind: 'tcp', port: 5432 },
    writablePaths: ['/var/lib/postgresql/data'],
  };
}

// ---------------------------------------------------------------------------
// @ax/sandbox-protocol — shared contract for the `sandbox:open-session` payload.
//
// These schemas WERE duplicated (and drifting) across @ax/sandbox-k8s,
// @ax/sandbox-subprocess, and @ax/chat-orchestrator. This package is the single
// source of truth; the tests below pin the contract so a future loosening
// (e.g. widening `max(32)`, dropping the stdio-key rejection, or relaxing the
// ProxyConfig exactly-one-of invariant) flips an assertion and we notice.
//
// Strictness note: the canonical ProxyConfigSchema is the STRICTER of the two
// former variants — `endpoint`/`unixSocketPath` are non-empty and mutually
// exclusive (exactly one). The k8s backend previously accepted neither/both;
// converging up tightens that boundary.
// ---------------------------------------------------------------------------

// --- McpServerSchema --------------------------------------------------------

function validHttpServer(): Record<string, unknown> {
  return {
    name: 'remote',
    transport: 'http',
    url: 'https://mcp.example.com',
    allowedHosts: [],
    credentials: [],
  };
}

describe('McpServerSchema', () => {
  it('accepts a valid http entry', () => {
    expect(McpServerSchema.safeParse(validHttpServer()).success).toBe(true);
  });

  it('defaults allowedHosts and credentials to empty arrays', () => {
    const result = McpServerSchema.parse({
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com',
    });
    expect(result.allowedHosts).toEqual([]);
    expect(result.credentials).toEqual([]);
  });

  it('rejects a name that does not match the id regex', () => {
    const result = McpServerSchema.safeParse({
      ...validHttpServer(),
      name: 'Remote',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a transport other than http', () => {
    const result = McpServerSchema.safeParse({
      ...validHttpServer(),
      transport: 'websocket',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a stdio MCP server', () => {
    const r = McpServerSchema.safeParse({ name: 'local', transport: 'stdio', command: 'npx', allowedHosts: [], credentials: [] });
    expect(r.success).toBe(false);
  });

  it('rejects an http server that still carries command', () => {
    const r = McpServerSchema.safeParse({ name: 'remote', transport: 'http', url: 'https://mcp.example.com', command: 'x' });
    expect(r.success).toBe(false);
  });

  // The removed stdio-only keys must be rejected, not silently stripped: a
  // plain z.object drops unknown keys before any refine sees them, so a host
  // that still sends one would look healthy. Each key is pinned on its own.
  it.each([
    ['command', 'npx'],
    ['args', ['-y', 'pkg']],
    ['env', { TOKEN: 'x' }],
  ])('rejects an http entry that carries the removed stdio key %s', (key, value) => {
    const result = McpServerSchema.safeParse({ ...validHttpServer(), [key]: value });
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
      transport: 'http' as const,
      url: 'https://mcp.example.com',
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

const PROXY_TOKEN = 'a'.repeat(32);

describe('ProxyConfigSchema', () => {
  it('accepts an endpoint-only config', () => {
    const result = ProxyConfigSchema.safeParse({
      endpoint: 'http://127.0.0.1:54321',
      caCertPem: 'PEM',
      proxyAuthToken: PROXY_TOKEN,
      envMap: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts a unixSocketPath-only config', () => {
    const result = ProxyConfigSchema.safeParse({
      unixSocketPath: '/var/run/ax/proxy.sock',
      caCertPem: 'PEM',
      proxyAuthToken: PROXY_TOKEN,
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
      proxyAuthToken: PROXY_TOKEN,
      envMap: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string endpoint', () => {
    const result = ProxyConfigSchema.safeParse({
      endpoint: '',
      caCertPem: 'PEM',
      proxyAuthToken: PROXY_TOKEN,
      envMap: {},
    });
    expect(result.success).toBe(false);
  });

  it('REQUIRES a 32-hex proxyAuthToken (TASK-784 — fail closed, no stub-proxy exemption)', () => {
    const withToken = ProxyConfigSchema.safeParse({
      endpoint: 'http://127.0.0.1:54321',
      caCertPem: 'PEM',
      envMap: {},
      proxyAuthToken: PROXY_TOKEN,
    });
    expect(withToken.success).toBe(true);
    // No token → rejected. Before TASK-784 this parsed, and the runner then
    // died at boot with MissingEnvError (exit 2) instead of the host refusing.
    const missing = ProxyConfigSchema.safeParse({
      endpoint: 'http://127.0.0.1:54321',
      caCertPem: 'PEM',
      envMap: {},
    });
    expect(missing.success).toBe(false);
    const unix = ProxyConfigSchema.safeParse({
      unixSocketPath: '/var/run/ax/proxy.sock',
      caCertPem: 'PEM',
      envMap: {},
    });
    expect(unix.success).toBe(false);
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
      proxyAuthToken: PROXY_TOKEN,
      envMap: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string envMap value', () => {
    const result = ProxyConfigSchema.safeParse({
      endpoint: 'http://127.0.0.1:54321',
      caCertPem: 'PEM',
      proxyAuthToken: PROXY_TOKEN,
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
      runner: 'claude-sdk',
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

  it('preserves systemPromptBootstrapAugment when present', () => {
    const result = AgentConfigSchema.safeParse({
      displayName: 'Helper',
      systemPromptAugment: 'be helpful',
      systemPromptBootstrapAugment: 'rules-content',
      allowedTools: ['Read'],
      mcpConfigIds: [],
      model: 'claude',
      runner: 'claude-sdk',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.systemPromptBootstrapAugment).toBe('rules-content');
    }
  });

  it('leaves systemPromptBootstrapAugment absent when omitted', () => {
    const result = AgentConfigSchema.safeParse({
      displayName: 'Helper',
      systemPromptAugment: 'be helpful',
      allowedTools: ['Read'],
      mcpConfigIds: [],
      model: 'claude',
      runner: 'claude-sdk',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('systemPromptBootstrapAugment' in result.data).toBe(false);
    }
  });

  it('preserves disallowedTools when present (a z.object would silently strip it)', () => {
    const result = AgentConfigSchema.safeParse({
      displayName: 'Helper',
      systemPromptAugment: '',
      allowedTools: [],
      disallowedTools: ['Bash', 'mcp.c0123456789.x'],
      mcpConfigIds: [],
      model: 'claude',
      runner: 'claude-sdk',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.disallowedTools).toEqual(['Bash', 'mcp.c0123456789.x']);
    }
  });

  it('leaves disallowedTools absent when omitted', () => {
    const result = AgentConfigSchema.safeParse({
      displayName: 'Helper',
      systemPromptAugment: '',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'claude',
      runner: 'claude-sdk',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('disallowedTools' in result.data).toBe(false);
    }
  });

  it('rejects a non-string systemPromptBootstrapAugment', () => {
    const result = AgentConfigSchema.safeParse({
      displayName: 'Helper',
      systemPromptAugment: 'be helpful',
      systemPromptBootstrapAugment: 123,
      allowedTools: ['Read'],
      mcpConfigIds: [],
      model: 'claude',
      runner: 'claude-sdk',
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
        mcpServers: [validHttpServer()],
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
      { name: 'remote', transport: 'http', allowedHosts: [], credentials: [] },
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
        proxyAuthToken: PROXY_TOKEN,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a proxyConfig without a proxyAuthToken at the open-session envelope (TASK-784)', () => {
    const base = {
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
    };
    const proxyConfig = { endpoint: 'http://127.0.0.1:1', caCertPem: 'PEM', envMap: {} };
    expect(OpenSessionInputSchema.safeParse({ ...base, proxyConfig }).success).toBe(false);
    expect(
      OpenSessionInputSchema.safeParse({
        ...base,
        proxyConfig: { ...proxyConfig, proxyAuthToken: PROXY_TOKEN },
      }).success,
    ).toBe(true);
  });

  // --- TASK-150 services (wire re-validation) -------------------------------
  it('accepts an input carrying a well-formed services array', () => {
    const result = OpenSessionInputSchema.safeParse({
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
      services: [validServiceDescriptor()],
    });
    expect(result.success).toBe(true);
  });

  it('still accepts an input with no services (back-compat)', () => {
    const result = OpenSessionInputSchema.safeParse({
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a service whose image is not digest-pinned (I8 at the wire)', () => {
    const result = OpenSessionInputSchema.safeParse({
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
      services: [{ ...validServiceDescriptor(), image: 'postgres:16' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a service with a non-absolute writablePath', () => {
    const result = OpenSessionInputSchema.safeParse({
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
      services: [{ ...validServiceDescriptor(), writablePaths: ['var/lib/data'] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a service carrying smuggled backend vocabulary (strict) (I2)', () => {
    const result = OpenSessionInputSchema.safeParse({
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
      services: [{ ...validServiceDescriptor(), runtimeClassName: 'gvisor' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 8 services (carrier cap)', () => {
    const services = Array.from({ length: 9 }, (_, i) => ({
      ...validServiceDescriptor(),
      name: `svc-${i}`,
    }));
    const result = OpenSessionInputSchema.safeParse({
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
      services,
    });
    expect(result.success).toBe(false);
  });
});

// --- ServiceDescriptorSchema (standalone wire re-validation) ----------------
describe('ServiceDescriptorSchema', () => {
  it('accepts a well-formed descriptor', () => {
    expect(ServiceDescriptorSchema.safeParse(validServiceDescriptor()).success).toBe(true);
  });

  it('rejects an over-cap env (>32 entries)', () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 33; i++) env[`K${i}`] = 'v';
    const result = ServiceDescriptorSchema.safeParse({ ...validServiceDescriptor(), env });
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    expect(
      ServiceDescriptorSchema.safeParse({ ...validServiceDescriptor(), ports: [0] }).success,
    ).toBe(false);
  });

  it('defaults writablePaths to [] when omitted', () => {
    const { writablePaths: _drop, ...rest } = validServiceDescriptor();
    const parsed = ServiceDescriptorSchema.parse(rest);
    expect(parsed.writablePaths).toEqual([]);
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
