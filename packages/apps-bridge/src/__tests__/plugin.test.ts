import { request as httpRequest } from 'node:http';
import type { ServiceHandler } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  createSharedPostgres,
  createTestHarness,
  startFakeOidcIssuer,
  startTestContainer,
  type FakeOidcIssuer,
  type TestHarness,
} from '@ax/test-harness';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { AppsBridgeDeployConfig } from '../config.js';
import { createAppsBridgePlugin, type AppsBridgePlugin } from '../plugin.js';

/*
  The plugin's lifecycle on a real bus and a real Postgres: with no bridge
  config nothing listens; with one, startAdmission() binds the listener,
  stopAdmission() closes the door to new connections, and shutdown() closes
  the rest, as often as it is called. One request goes end to end (a real
  OIDC token, the real limiter, store and answer) to show it is all wired.
*/

const server = createSharedPostgres(() => startTestContainer(new PostgreSqlContainer('postgres:16-alpine')));
afterAll(() => server.stop(), 60_000);

const AUD = 'https://ax.test/api/apps-bridge/v1';
const SUB = 'platform@example.test';

/** The hooks the bridge calls besides the database; none is reached by these tests' requests. */
const unreached: ServiceHandler = async () => {
  throw new Error('not expected in this test');
};
const SERVICES: Record<string, ServiceHandler> = {
  'auth:find-user-by-email': unreached,
  'agents:resolve': unreached,
  'agents:can-manage-connectors': unreached,
  'connectors:list': unreached,
  'connectors:describe-tools': unreached,
  'tool-policy:evaluate': unreached,
  'connectors:call-tool-result': unreached,
  'connectors:list-effective': unreached,
};

let harness: TestHarness | undefined;
let issuer: FakeOidcIssuer | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await issuer?.close();
  issuer = undefined;
});

async function boot(bridge?: AppsBridgeDeployConfig): Promise<AppsBridgePlugin> {
  const connectionString = await server.database();
  const plugin = createAppsBridgePlugin({ publicOrigin: 'https://ax.test/', ...(bridge !== undefined ? { bridge } : {}) });
  harness = await createTestHarness({
    services: SERVICES,
    plugins: [createDatabasePostgresPlugin({ connectionString }), plugin],
  });
  return plugin;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: text === '' ? undefined : JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('apps-bridge plugin lifecycle', () => {
  it('declares every hook it calls', () => {
    expect(createAppsBridgePlugin({ publicOrigin: 'https://ax.test' }).manifest.calls).toEqual([
      'database:get-instance',
      'auth:find-user-by-email',
      'agents:resolve',
      'agents:can-manage-connectors',
      'connectors:list',
      'connectors:list-effective',
      'connectors:describe-tools',
      'tool-policy:evaluate',
      'connectors:call-tool-result',
    ]);
  });

  it('refuses a bad config at construction', () => {
    expect(() => createAppsBridgePlugin({ publicOrigin: 'not a url' })).toThrow(/publicOrigin/);
  });

  it('with the bridge off nothing listens and bridgeBoundPort() is undefined', async () => {
    const plugin = await boot();
    expect(plugin.bridgeBoundPort()).toBeUndefined();
    await plugin.stopAdmission?.();
    await plugin.shutdown?.();
    expect(plugin.bridgeBoundPort()).toBeUndefined();
  });

  it('startAdmission binds, stopAdmission refuses new connections, shutdown closes and is idempotent', async () => {
    issuer = await startFakeOidcIssuer();
    const plugin = await boot({
      platformId: 'canopy',
      host: '127.0.0.1',
      port: 0,
      caller: { issuer: issuer.issuer, jwksUrl: issuer.jwksUrl, audience: AUD, subject: SUB },
      viewer: { issuer: issuer.issuer, jwksUrl: issuer.jwksUrl, audience: 'viewer-aud', maxAgeSeconds: 600 },
    });
    const port = plugin.bridgeBoundPort();
    expect(port).toEqual(expect.any(Number));
    expect(port).toBeGreaterThan(0);

    // End to end: no token is refused; a real token for an app nobody linked
    // reaches the store and answers app_not_linked.
    expect(await get(port!, '/api/apps-bridge/v1/apps/app_1/grants')).toEqual({ status: 401, json: { code: 'unauthenticated' } });
    const now = Math.floor(Date.now() / 1000);
    const token = issuer.mint({ iss: issuer.issuer, aud: AUD, sub: SUB, iat: now, exp: now + 300 });
    expect(await get(port!, '/api/apps-bridge/v1/apps/app_1/grants', { authorization: `Bearer ${token}` })).toEqual({
      status: 404,
      json: { code: 'app_not_linked' },
    });
    const wrongSub = issuer.mint({ iss: issuer.issuer, aud: AUD, sub: 'someone-else', iat: now, exp: now + 300 });
    expect(await get(port!, '/api/apps-bridge/v1/apps/app_1/grants', { authorization: `Bearer ${wrongSub}` })).toEqual({
      status: 401,
      json: { code: 'unauthenticated' },
    });

    await plugin.stopAdmission?.();
    await expect(get(port!, '/api/apps-bridge/v1/apps/app_1/grants')).rejects.toThrow(/ECONNREFUSED/);

    await plugin.shutdown?.();
    await plugin.shutdown?.();
    // harness.close() in afterEach runs both again: still a no-op.
  });
});
