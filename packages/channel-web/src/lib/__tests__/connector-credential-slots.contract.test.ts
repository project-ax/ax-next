// @vitest-environment node
//
// TASK-767 — pin what the connector editors MINT to what the server ACCEPTS.
//
// `connector-credential-slots.ts` mints the slot names the editors store
// credentials under; @ax/credentials-admin-routes' destination route is the
// server that has to accept them. TASK-762 was those two drifting apart (the
// editors minted `header-<uuid>`, the route refused it with `400 invalid
// account slot`, and nobody could save a header key from the UI).
//
// So this test does not compare against a copy of the server's regex. It boots
// the REAL @ax/credentials-admin-routes plugin, captures the route handler it
// registers, and POSTs slots minted by the real channel-web functions through
// it. If either side changes its grammar, this goes red.
//
// Why here and not in @ax/credentials-admin-routes: CI tests "affected packages
// + dependents". channel-web devDepends on the route package, so a change to
// EITHER side runs this file. A test living in the route package that reached
// into channel-web's source by relative path would NOT run when only
// channel-web changed — the exact drift this exists to catch.
//
// Invariant 2: test files are exempt from the cross-plugin import rule
// (eslint.config.mjs), and only the plugin's public factory is imported — the
// route is reached through the bus, the way the http-server reaches it.
import { describe, expect, it } from 'vitest';
import { bootstrap, HookBus } from '@ax/core';
import {
  createCredentialsAdminRoutesPlugin,
  type RouteRequest,
  type RouteResponse,
} from '@ax/credentials-admin-routes';
import {
  OAUTH_CLIENT_SECRET_SLOT,
  newHeaderSlot,
} from '../connector-credential-slots';

type Handler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

const SETTINGS_ROUTE = '/settings/destinations/:destinationKind/credential';

async function bootRoute(): Promise<{
  post: (slot: string) => Promise<{ status: number; body: unknown }>;
  refs: string[];
}> {
  const bus = new HookBus();
  const routes = new Map<string, Handler>();
  const refs: string[] = [];
  const stub = (name: string, fn: (input: unknown) => unknown) =>
    bus.registerService(name, 'test', async (_ctx, input: unknown) => fn(input));

  stub('auth:require-user', () => ({ user: { id: 'alice', isAdmin: false } }));
  stub('http:register-route', (input) => {
    const r = input as { method: string; path: string; handler: Handler };
    routes.set(`${r.method} ${r.path}`, r.handler);
    return { unregister: () => {} };
  });
  stub('credentials:list', () => ({ credentials: [] }));
  stub('credentials:list-kinds', () => ({ kinds: [] }));
  stub('credentials:set', (input) => {
    refs.push((input as { ref: string }).ref);
    return {};
  });
  stub('credentials:delete', () => ({}));

  await bootstrap({
    bus,
    plugins: [createCredentialsAdminRoutesPlugin()],
    config: {},
  });

  const found = routes.get(`POST ${SETTINGS_ROUTE}`);
  if (found === undefined) {
    throw new Error(`credentials-admin-routes no longer registers POST ${SETTINGS_ROUTE}`);
  }
  const handler: Handler = found;

  async function post(slot: string): Promise<{ status: number; body: unknown }> {
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
    await handler(
      {
        headers: {},
        cookies: {},
        query: {},
        params: { destinationKind: 'account' },
        signedCookie: () => null,
        body: Buffer.from(
          JSON.stringify({
            destination: { kind: 'account', service: 'remote-mcp', slot },
            scope: 'user',
            ownerId: null,
            kind: 'api-key',
            payloadB64: Buffer.from('Bearer k').toString('base64'),
          }),
        ),
      },
      res,
    );
    return { status, body };
  }

  return { post, refs };
}

describe('connector credential slots vs the real destination route', () => {
  it('the route accepts every header slot the editor mints', async () => {
    const { post, refs } = await bootRoute();
    for (let i = 0; i < 20; i++) {
      const slot = newHeaderSlot();
      const out = await post(slot);
      expect({ slot, ...out }).toEqual({ slot, status: 204, body: undefined });
      expect(refs.at(-1)).toBe(`account:remote-mcp:${slot}`);
    }
  });

  it('the route accepts the OAuth client secret slot the editor mints', async () => {
    const { post, refs } = await bootRoute();
    const out = await post(OAUTH_CLIENT_SECRET_SLOT);
    expect(out).toEqual({ status: 204, body: undefined });
    expect(refs).toEqual([`account:remote-mcp:${OAUTH_CLIENT_SECRET_SLOT}`]);
  });

  // Non-vacuity: the harness above really reaches the server's slot validator.
  // If it ever stopped validating (or this harness stopped reaching it), the
  // two tests above would pass for any slot at all.
  it('the route still refuses the pre-TASK-762 shape', async () => {
    const { post, refs } = await bootRoute();
    const out = await post(`header-${crypto.randomUUID()}`);
    expect(out.status).toBe(400);
    expect(String((out.body as { error?: unknown }).error)).toMatch(/invalid account slot/);
    expect(refs).toEqual([]);
  });
});
