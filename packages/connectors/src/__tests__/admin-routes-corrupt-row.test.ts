import { describe, it, expect, vi } from 'vitest';
import { HookBus, PluginError } from '@ax/core';
import {
  createAdminConnectorRouteHandlers,
  type RouteRequest,
  type RouteResponse,
} from '../admin-routes.js';

// ---------------------------------------------------------------------------
// TASK-1031 — a stored connector row the read schema refuses is a host fault.
// The store throws `corrupt-row` (not `invalid-payload`), and the admin routes
// answer a logged 500 that never echoes the validation (zod) text, where they
// used to answer a 400 carrying it.
//
// No Docker: connectors:get is stubbed on a bare bus.
// ---------------------------------------------------------------------------

const ZOD_TEXT = 'capabilities must be a valid Capabilities object: [{"code":"invalid_type","path":["allowedHosts"]}]';

function mkRes(): { res: RouteResponse; statusOf: () => number; bodyOf: () => unknown } {
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
  return { res, statusOf: () => status, bodyOf: () => body };
}

function mkReq(id: string): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query: {},
    params: { id },
    signedCookie: () => null,
  };
}

function busThrowing(err: unknown): HookBus {
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'test', async () => ({ user: { id: 'admin', isAdmin: true } }));
  bus.registerService('connectors:get', 'test', async () => {
    throw err;
  });
  return bus;
}

async function captureStdout(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines.flatMap((l) => l.split('\n')).filter((l) => l.length > 0);
}

describe('connector admin routes: a corrupt stored row', () => {
  it('is a logged 500 with no validation text in the body', async () => {
    const bus = busThrowing(
      new PluginError({ code: 'corrupt-row', plugin: '@ax/connectors', message: ZOD_TEXT }),
    );
    const { res, statusOf, bodyOf } = mkRes();
    const lines = await captureStdout(() => createAdminConnectorRouteHandlers({ bus }).show(mkReq('broken'), res));

    expect(statusOf()).toBe(500);
    expect(bodyOf()).toEqual({ error: 'internal' });
    expect(JSON.stringify(bodyOf())).not.toContain('Capabilities');

    const logged = lines
      .filter((l) => l.includes('connectors_admin_corrupt_row'))
      .map((l) => JSON.parse(l) as { level: string; err: { code: string } });
    expect(logged).toHaveLength(1);
    expect(logged[0]!.level).toBe('error');
    expect(logged[0]!.err.code).toBe('corrupt-row');
  });

  it('a caller-fixable invalid-payload is still a 400 carrying its message', async () => {
    const bus = busThrowing(
      new PluginError({ code: 'invalid-payload', plugin: '@ax/connectors', message: 'connectorId must be 1-128 chars' }),
    );
    const { res, statusOf, bodyOf } = mkRes();
    await createAdminConnectorRouteHandlers({ bus }).show(mkReq('x'), res);
    expect(statusOf()).toBe(400);
    expect(bodyOf()).toEqual({ error: 'connectorId must be 1-128 chars' });
  });
});
