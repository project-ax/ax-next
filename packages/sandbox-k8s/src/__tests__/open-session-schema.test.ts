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
            name: 'remote',
            transport: 'http',
            url: 'https://mcp.example.com',
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
        name: 'Remote',
        transport: 'http',
        url: 'https://mcp.example.com',
        allowedHosts: [],
        credentials: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an mcpServers entry whose transport is not http', () => {
    const result = OpenSessionInputSchema.safeParse(
      withMcpServer({
        name: 'remote',
        transport: 'websocket',
        url: 'https://mcp.example.com',
        allowedHosts: [],
        credentials: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a stdio mcpServers entry (transport removed)', () => {
    const result = OpenSessionInputSchema.safeParse(
      withMcpServer({
        name: 'local',
        transport: 'stdio',
        command: 'npx',
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
      transport: 'http' as const,
      url: 'https://mcp.example.com',
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
  // Transport invariants (http only). An entry needs a url and must not carry
  // the removed stdio-only command/args/env fields. Without these tests, a
  // regression would silently expand the wire surface (e.g. pass a command
  // through to the runner pod, which then writes a broken .mcp.json).
  // -------------------------------------------------------------------------

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
