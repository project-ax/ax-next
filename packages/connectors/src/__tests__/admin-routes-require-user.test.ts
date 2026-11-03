import { describe, it, expect, vi } from 'vitest';
import { HookBus, PluginError } from '@ax/core';
import {
  createConnectorRouteHandlers,
  type RouteRequest,
  type RouteResponse,
} from '../admin-routes.js';

// ---------------------------------------------------------------------------
// The connector routes' `auth:require-user` gate (TASK-1030). Only the hook's
// own 'unauthenticated' refusal is a 401. HookBus.call wraps whatever else a
// service throws as PluginError{ code: 'unknown', cause }, so a session-store
// crash must come out as a logged 500, not a "sign in again" 401.
//
// No Docker: the gate runs before any connectors:* hook is called.
// ---------------------------------------------------------------------------

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

const req: RouteRequest = {
  headers: {},
  body: Buffer.alloc(0),
  cookies: {},
  query: {},
  params: {},
  signedCookie: () => null,
};

describe('connector routes: auth:require-user gate', () => {
  it('unauthenticated refusal -> 401', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'test', async () => {
      throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'no cookie' });
    });
    const { res, statusOf, bodyOf } = mkRes();
    await createConnectorRouteHandlers({ bus }).list(req, res);
    expect(statusOf()).toBe(401);
    expect(bodyOf()).toEqual({ error: 'unauthenticated' });
  });

  it('a session-store fault -> logged 500 that does not echo the message', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'test', async () => {
      throw new Error('pg down at 10.0.0.7');
    });
    // The handlers build their own ctx, so read the logger's stdout lines.
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    const { res, statusOf, bodyOf } = mkRes();
    try {
      await createConnectorRouteHandlers({ bus }).list(req, res);
    } finally {
      spy.mockRestore();
    }
    expect(statusOf()).toBe(500);
    expect(bodyOf()).toEqual({ error: 'internal' });
    expect(JSON.stringify(bodyOf())).not.toContain('pg down');
    const logged = lines
      .flatMap((l) => l.split('\n'))
      .filter((l) => l.includes('connectors_admin_require_user_failed'))
      .map(
        (l) =>
          JSON.parse(l) as {
            level: string;
            hook: string;
            err: { code: string; cause: { name: string } };
          },
      );
    expect(logged).toHaveLength(1);
    expect(logged[0]!.level).toBe('error');
    expect(logged[0]!.hook).toBe('auth:require-user');
    expect(logged[0]!.err.code).toBe('unknown');
    expect(logged[0]!.err.cause.name).toBe('Error');
  });
});
