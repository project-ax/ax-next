/**
 * TASK-1024 — how POST /admin/agents/:id/authored-skills/promote answers a
 * failed `skills:upsert`.
 *
 * It used to map EVERY PluginError to 400 and echo its message. So a host
 * fault (a store error, a missing owner, anything the caller can't fix) read
 * as "your request was bad" and leaked whatever the message said. Now only the
 * manifest parser's own codes (`MANIFEST_CODES`) are a 400. Everything else is
 * a logged 500 with a generic body.
 *
 * Docker-free: the hooks the handler calls are stubbed on the harness bus.
 * The real skills plugin is covered in promote-authored-skills.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PluginError } from '@ax/core';
import { MANIFEST_CODES } from '@ax/skills-parser';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createAdminAgentRouteHandlers } from '../admin-routes.js';
import type { RouteRequest, RouteResponse } from '../admin-routes.js';

const harnesses: TestHarness[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (harnesses.length > 0) await harnesses.pop()!.close();
});

const SECRET_DETAIL = 'pg: relation skills_v1_skills violates constraint at 10.0.0.7:5432';

async function promoteWith(upsertError: unknown): Promise<{ status: number; body: unknown }> {
  const h = await createTestHarness({
    services: {
      'auth:require-user': async () => ({ user: { id: 'admin', isAdmin: true } }),
      'agents:list-authored-skills': async () => ({
        skills: [
          {
            id: 'foo',
            description: 'A skill called foo',
            version: 1,
            bodyMd: '# foo',
            connectors: [],
            hasForbiddenCapabilities: false,
          },
        ],
      }),
      'skills:upsert': async () => {
        throw upsertError;
      },
    },
  });
  harnesses.push(h);
  const handlers = createAdminAgentRouteHandlers({
    bus: h.bus,
    boot: { allowed: ['anthropic/claude-sonnet-4-6'], default: 'anthropic/claude-sonnet-4-6' },
    store: { countByModel: async () => [] },
  });

  let status = 200;
  let body: unknown;
  const res: RouteResponse = {
    status(n: number) {
      status = n;
      return res;
    },
    json(v: unknown) {
      body = v;
    },
    text(s: string) {
      body = s;
    },
    end() {},
  };
  const req: RouteRequest = {
    headers: {},
    body: Buffer.from(JSON.stringify({ skillId: 'foo', targetScope: 'global' })),
    cookies: {},
    query: {},
    params: { id: 'agent-1' },
    signedCookie: () => null,
  };
  await handlers.promoteAuthoredSkill(req, res);
  return { status, body };
}

function captureStdout(): () => string {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return () => lines.join('');
}

describe('promote: skills:upsert failures (TASK-1024)', () => {
  it.each([...MANIFEST_CODES])('manifest code %s → 400 with its code and message', async (code) => {
    const { status, body } = await promoteWith(
      new PluginError({ code, plugin: '@ax/skills', message: `manifest says ${code}` }),
    );
    expect(status).toBe(400);
    expect(body).toEqual({ error: `manifest says ${code}`, code });
  });

  it('invalid-payload stays a 400 (writeServiceError)', async () => {
    const { status } = await promoteWith(
      new PluginError({ code: 'invalid-payload', plugin: '@ax/skills', message: 'bodyMd must be a string' }),
    );
    expect(status).toBe(400);
  });

  // A plain Error never reaches the route as-is: HookBus.call wraps it as
  // PluginError code 'unknown' with the original message inside. The old
  // code therefore answered a store crash with a 400 echoing its message.
  // Expected log fields: [code, plugin, hookName]. The harness registers stub
  // services as plugin 'mock', and only the bus wrapper sets a hookName.
  it.each([
    ['a non-manifest PluginError (missing-owner)', new PluginError({ code: 'missing-owner', plugin: '@ax/skills', message: SECRET_DETAIL }), 'missing-owner', '@ax/skills', undefined],
    ['a PluginError with a code the parser no longer emits (invalid-host)', new PluginError({ code: 'invalid-host', plugin: '@ax/skills', message: SECRET_DETAIL }), 'invalid-host', '@ax/skills', undefined],
    ['a plain Error from the store', new Error(SECRET_DETAIL), 'unknown', 'mock', 'skills:upsert'],
  ])('%s → logged 500 that does not echo the message', async (_label, err, expectedCode, expectedPlugin, expectedHook) => {
    const stdout = captureStdout();
    const { status, body } = await promoteWith(err);
    const logged = stdout();

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'internal' });
    expect(JSON.stringify(body)).not.toContain('10.0.0.7');

    // The detail goes to the structured log instead, where an operator can find it.
    const line = logged
      .split('\n')
      .filter((l) => l.startsWith('{"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.msg === 'agents_admin_promote_failed');
    expect(line).toBeDefined();
    expect(line!.level).toBe('error');
    expect(line).toMatchObject({
      agentId: 'agent-1',
      skillId: 'foo',
      targetScope: 'global',
      pluginErrorCode: expectedCode,
      plugin: expectedPlugin,
    });
    if (expectedHook === undefined) {
      expect(line).not.toHaveProperty('hookName');
    } else {
      expect(line!.hookName).toBe(expectedHook);
    }
    expect(JSON.stringify(line!.err)).toContain('10.0.0.7');
  });
});
