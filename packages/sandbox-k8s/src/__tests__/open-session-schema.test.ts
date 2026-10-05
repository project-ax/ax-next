import { describe, expect, it } from 'vitest';
import { OpenSessionInputSchema } from '../open-session.js';
import { TEST_PROXY_CONFIG } from './proxy-config.js';

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
    // REQUIRED since TASK-838. Every rejection test below mutates this base, so
    // each one must be refused for ITS OWN field (see expectRejectedAt).
    proxyConfig: TEST_PROXY_CONFIG,
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

// Assert `input` is rejected AT `expectedPath` (a dotted zod issue path) and
// NOT because proxyConfig is missing/invalid. A bare `success === false` can't
// tell those apart now that proxyConfig is required, which would let every
// rejection test pass vacuously if the base input lost its proxyConfig.
function expectRejectedAt(input: unknown, expectedPath: string): void {
  const result = OpenSessionInputSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) return;
  const paths = result.error.issues.map((i) => i.path.join('.'));
  expect(paths).toContain(expectedPath);
  expect(paths.some((p) => p.startsWith('proxyConfig'))).toBe(false);
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
    expectRejectedAt(
      withMcpServer({
        name: 'Remote',
        transport: 'http',
        url: 'https://mcp.example.com',
        allowedHosts: [],
        credentials: [],
      }),
      'installedSkills.0.mcpServers.0.name',
    );
  });

  it('rejects an mcpServers entry whose transport is not http', () => {
    expectRejectedAt(
      withMcpServer({
        name: 'remote',
        transport: 'websocket',
        url: 'https://mcp.example.com',
        allowedHosts: [],
        credentials: [],
      }),
      'installedSkills.0.mcpServers.0.transport',
    );
  });

  it('rejects a stdio mcpServers entry (transport removed)', () => {
    expectRejectedAt(
      withMcpServer({
        name: 'local',
        transport: 'stdio',
        command: 'npx',
        allowedHosts: [],
        credentials: [],
      }),
      'installedSkills.0.mcpServers.0.command',
    );
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
    expectRejectedAt(base, 'installedSkills.0.mcpServers');
  });

  // -------------------------------------------------------------------------
  // Transport invariants (http only). An entry needs a url and must not carry
  // the removed stdio-only command/args/env fields. Without these tests, a
  // regression would silently expand the wire surface (e.g. pass a command
  // through to the runner pod, which then writes a broken .mcp.json).
  // -------------------------------------------------------------------------

  it('rejects an http mcpServers entry that is missing url', () => {
    expectRejectedAt(
      withMcpServer({
        name: 'remote',
        transport: 'http',
        // url omitted
        allowedHosts: [],
        credentials: [],
      }),
      'installedSkills.0.mcpServers.0.url',
    );
  });

  it('rejects an http mcpServers entry that also sets command (cross-contamination)', () => {
    expectRejectedAt(
      withMcpServer({
        name: 'remote',
        transport: 'http',
        url: 'https://mcp.example.com',
        command: 'npx',
        allowedHosts: [],
        credentials: [],
      }),
      'installedSkills.0.mcpServers.0.command',
    );
  });
});
