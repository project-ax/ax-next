import { describe, expect, it } from 'vitest';
import { OpenSessionInputSchema } from '../open-session.js';

// ---------------------------------------------------------------------------
// Schema rejection tests for OpenSessionInputSchema (Phase B follow-up).
//
// The structural twin of sandbox-subprocess's InstalledSkillSchema /
// McpServerSchema lives in `open-session.ts` because of I2 (no cross-plugin
// imports). The whole point of duplicating the schema is that the k8s
// boundary re-validates everything the host orchestrator hands it — a drifted
// orchestrator must NOT be able to ship a malformed payload through to the
// runner pod. These tests cover the negative cases for the duplicated
// McpServerSchema so the boundary's contract is exercised, not just trusted.
//
// Each test starts from a known-valid base input and mutates exactly one
// field. If the schema's `.regex`/`.max`/`.enum` constraints ever silently
// loosen (e.g. someone widens `max(32)` to `max(64)` without updating the
// subprocess sibling), one of these assertions flips and we notice.
// ---------------------------------------------------------------------------

function validBaseInput(): unknown {
  return {
    sessionId: 'sess-base',
    workspaceRoot: '/tmp/ws',
    runnerBinary: '/opt/ax/runner.js',
    installedSkills: [
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
    ],
  };
}

// Helper: replace the first installedSkills entry with a single mcpServers
// entry whose fields are mutated. Returns a fresh deep-cloned input.
function withMcpServer(server: Record<string, unknown>): unknown {
  const base = validBaseInput() as {
    installedSkills: Array<{ mcpServers: unknown[] }>;
  };
  base.installedSkills[0]!.mcpServers = [server];
  return base;
}

describe('OpenSessionInputSchema (k8s) — mcpServers rejection', () => {
  it('accepts the valid base input (sanity)', () => {
    const result = OpenSessionInputSchema.safeParse(validBaseInput());
    expect(result.success).toBe(true);
  });

  it('rejects an mcpServers entry whose name does not match the regex', () => {
    // Name must match /^[a-z][a-z0-9-]{0,63}$/ — uppercase and leading
    // digits are out. We use uppercase here; both shapes are equivalent
    // rejection cases.
    const result = OpenSessionInputSchema.safeParse(
      withMcpServer({
        name: 'GitHub',
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: {},
        allowedHosts: [],
        credentials: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an mcpServers entry whose transport is neither stdio nor http', () => {
    const result = OpenSessionInputSchema.safeParse(
      withMcpServer({
        name: 'github',
        transport: 'websocket',
        command: 'npx',
        args: [],
        env: {},
        allowedHosts: [],
        credentials: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an mcpServers entry whose args array has more than 32 entries', () => {
    // 33 single-char entries trips the .max(32) on the array.
    const args = Array.from({ length: 33 }, (_, i) => `a${i}`);
    const result = OpenSessionInputSchema.safeParse(
      withMcpServer({
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        args,
        env: {},
        allowedHosts: [],
        credentials: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an mcpServers entry whose individual arg string is longer than 256 chars', () => {
    // .max(256) on the per-string length — a 257-char arg trips it.
    const longArg = 'x'.repeat(257);
    const result = OpenSessionInputSchema.safeParse(
      withMcpServer({
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        args: [longArg],
        env: {},
        allowedHosts: [],
        credentials: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects installedSkills entries with more than 8 mcpServers', () => {
    // 9 distinct, individually-valid servers trips the .max(8) on the
    // mcpServers array. Names stay regex-valid so the only rejection
    // surface is the array length.
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      name: `srv-${i}`,
      transport: 'stdio' as const,
      command: 'npx',
      args: [],
      env: {},
      allowedHosts: [],
      credentials: [],
    }));
    const base = validBaseInput() as {
      installedSkills: Array<{ mcpServers: unknown[] }>;
    };
    base.installedSkills[0]!.mcpServers = tooMany;
    const result = OpenSessionInputSchema.safeParse(base);
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Transport-specific invariants (.refine on McpServerSchema). The base
  // schema's optional command/url fields let the structural type
  // accept malformed shapes — the .refine pins the transport contract:
  //   stdio → command required (non-empty), url forbidden
  //   http  → url required, command/args/env forbidden
  // Without these tests, a future refine regression would silently expand
  // the wire surface (e.g. accept a stdio entry with no command and pass
  // it to the runner pod which then writes a broken .mcp.json).
  // -------------------------------------------------------------------------

  it('rejects a stdio mcpServers entry that is missing command', () => {
    const result = OpenSessionInputSchema.safeParse(
      withMcpServer({
        name: 'github',
        transport: 'stdio',
        // command omitted
        args: [],
        env: {},
        allowedHosts: [],
        credentials: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a stdio mcpServers entry with an empty command', () => {
    const result = OpenSessionInputSchema.safeParse(
      withMcpServer({
        name: 'github',
        transport: 'stdio',
        command: '',
        args: [],
        env: {},
        allowedHosts: [],
        credentials: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an http mcpServers entry that is missing url', () => {
    const result = OpenSessionInputSchema.safeParse(
      withMcpServer({
        name: 'remote',
        transport: 'http',
        // url omitted
        allowedHosts: [],
        credentials: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a stdio mcpServers entry that also sets url (cross-contamination)', () => {
    const result = OpenSessionInputSchema.safeParse(
      withMcpServer({
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        url: 'https://evil.example.com',
        args: [],
        env: {},
        allowedHosts: [],
        credentials: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an http mcpServers entry that also sets command (cross-contamination)', () => {
    const result = OpenSessionInputSchema.safeParse(
      withMcpServer({
        name: 'remote',
        transport: 'http',
        url: 'https://mcp.example.com',
        command: 'npx',
        allowedHosts: [],
        credentials: [],
      }),
    );
    expect(result.success).toBe(false);
  });
});
