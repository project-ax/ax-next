import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { sql } from 'kysely';
import { PluginError } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';
import { RoutineDefinitionSchema, type RoutineView, type RoutineWebhookStatus } from '@ax/routines-contract';
import { captureExpectedStderr } from './support/expected-diagnostics.js';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { systemClock } from '../clock.js';

// TASK-1026: whether a signing secret is saved decides whether app updates are
// checked; the host works out the signing format from each delivery's headers.
// TASK-1027: a signature setting saved before TASK-1026 is still stored and
// parsed, but ignored. Only a saved secret turns checks on.
let h: RoutineHarness;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await h?.close();
});
const now = new Date('2026-10-27T12:00:00Z');
const stale = new Date(now.getTime() - 301_000);
const secret = 'secret-only-fixture';
const BODY = '{"title":"from the other app"}';
type App = 'stripe' | 'slack' | 'zendesk';
type LegacySetting = { app: App } | { header: string; algorithm: 'sha256' | 'sha1'; prefix?: string };

const hex = (body: string, key = secret, algorithm: 'sha256' | 'sha1' = 'sha256') => createHmac(algorithm, key).update(body).digest('hex');
/** The app's own timestamped headers, in the mixed case apps send. */
function timestamped(app: App, body: string, at = now): Record<string, string> {
  const timestamp = app === 'zendesk' ? at.toISOString() : String(at.getTime() / 1000);
  const base = app === 'stripe' ? `${timestamp}.` : app === 'slack' ? `v0:${timestamp}:` : timestamp;
  const signature = createHmac('sha256', secret).update(base + body).digest(app === 'zendesk' ? 'base64' : 'hex');
  return app === 'stripe' ? { 'Stripe-Signature': `t=${timestamp},v1=${signature}` }
    : app === 'slack' ? { 'X-Slack-Request-Timestamp': timestamp, 'X-Slack-Signature': `v0=${signature}` }
    : { 'X-Zendesk-Webhook-Signature-Timestamp': timestamp, 'X-Zendesk-Webhook-Signature': signature };
}

async function start() {
  h = await createRoutineHarness({ clock: { now: () => now, sleep: systemClock.sleep } });
  const listening = captureExpectedStderr(message => message.startsWith('[ax/http-server] listening on http://127.0.0.1:'));
  const server = createHttpServerPlugin({ host: '127.0.0.1', port: 0, cookieKey: Buffer.alloc(32, 1), allowedOrigins: ['http://localhost'] });
  const transport = await createTestHarness({ plugins: [server] });
  cleanups.push(async () => { await transport.close(); listening.restore(); });
  const path = '/webhooks/:token/*';
  // Looked up per request, so the route follows the harness across h.restart().
  await transport.bus.call('http:register-route', h.owner, { ...h.routes.find(r => r.path === path)!, handler: (req: unknown, res: unknown) => h.routes.find(r => r.path === path)!.handler(req as never, res as never) });
  /** A real HTTP request: the adapter lowercases the header names. */
  return (url: string, headers: Record<string, string> = {}, body = BODY) => fetch(`http://127.0.0.1:${server.boundPort()}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
  });
}
/** A webhook-only repeat routine, created without signature settings unless `hmac` is given. */
async function create(name: string, hmac?: LegacySetting) {
  const row = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, { agentId: h.agentId, requestId: `create-${name}`,
    definition: RoutineDefinitionSchema.parse({ name, promptBody: 'Review {{payload.title}}', webhook: { kind: 'webhook', path: `/${name}`, ...(hmac ? { hmac } : {}) }, schedule: null }) });
  const { token } = await h.bus.call<unknown, { token: string }>('routines:webhook-address', h.owner, { agentId: row.agentId, routineId: row.routineId });
  return { row, url: `/webhooks/${token}/${name}` };
}
const secretInput = (row: RoutineView, operation: 'set' | 'delete' = 'set') => ({ agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision,
  ...(operation === 'set' ? { operation, secret: Buffer.from(secret) } : { operation }) });
const saveSecret = (row: RoutineView, operation: 'set' | 'delete' = 'set') => h.bus.call('routines:set-webhook-secret', h.owner, secretInput(row, operation));
const status = (row: RoutineView) => h.bus.call<unknown, RoutineWebhookStatus>('routines:webhook-status', h.owner, { agentId: row.agentId, routineId: row.routineId });
const queued = async (row: RoutineView) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM routines_v1_deliveries WHERE agent_id=${row.agentId} AND routine_id=${row.routineId}`.execute(h.db)).rows[0]!.n;

describe('verification decided by the saved secret, with the app detected', () => {
  it('accepts unsigned updates until a secret is saved, then only signed ones', async () => {
    const post = await start();
    const { row, url } = await create('updates');
    expect((await post(url)).status).toBe(202);
    expect(await status(row)).toMatchObject({ lastAcceptedAt: now.toISOString(), app: null, signatureChecked: false, timestampChecked: false });
    await saveSecret(row);
    expect((await post(url)).status).toBe(401);
    expect((await post(url, { 'Linear-Signature': hex(BODY, 'wrong-secret') })).status).toBe(401);
    expect((await post(url, { 'Linear-Signature': hex(BODY) })).status).toBe(202);
    expect(await status(row)).toMatchObject({ app: 'linear', signatureChecked: true, timestampChecked: false, refusals: [{ reason: 'signature', count: 2 }] });
    expect((await post(url, { 'X-Hub-Signature-256': `sha256=${hex(BODY)}` })).status).toBe(202);
    expect(await status(row)).toMatchObject({ app: 'github', signatureChecked: true, timestampChecked: false });
    await saveSecret(row, 'delete');
    expect((await post(url)).status).toBe(202);
    expect(await status(row)).toMatchObject({ app: null, signatureChecked: false, timestampChecked: false });
    await expect.poll(() => h.invokeCalls.length).toBe(4);
  });

  it('refuses unsigned and wrongly signed updates once a secret is saved on a task with no signature settings', async () => {
    const post = await start();
    const { row, url } = await create('no-settings');
    expect(row.webhook).not.toHaveProperty('hmac');
    await saveSecret(row);
    expect((await post(url)).status).toBe(401);
    expect((await post(url, { 'Linear-Signature': hex(BODY, 'wrong-secret') })).status).toBe(401);
    expect((await post(url, { 'X-Hub-Signature-256': `sha256=${hex(BODY, 'wrong-secret')}` })).status).toBe(401);
    expect(await status(row)).toMatchObject({ lastAcceptedAt: null, refusals: [{ reason: 'signature', count: 3 }] });
    expect(await queued(row)).toBe(0);
    expect(h.invokeCalls).toEqual([]);
  });

  it('refuses a present but failing Stripe header beside a valid body signature', async () => {
    const post = await start();
    const { row, url } = await create('mixed');
    await saveSecret(row);
    const bodySigned = { 'X-Hub-Signature-256': `sha256=${hex(BODY)}` };
    expect((await post(url, { ...timestamped('stripe', BODY, stale), ...bodySigned })).status).toBe(401);
    expect((await post(url, { 'Stripe-Signature': 'not a signature', ...bodySigned })).status).toBe(401);
    expect(await queued(row)).toBe(0);
    expect(h.invokeCalls).toEqual([]);
    // The body signature alone is accepted, so only the Stripe header refused those.
    expect((await post(url, bodySigned)).status).toBe(202);
  });

  it.each(['stripe', 'slack', 'zendesk'] as const)('%s works with only a secret saved', async app => {
    const post = await start();
    const { row, url } = await create(app);
    await saveSecret(row);
    expect((await post(url, timestamped(app, BODY))).status).toBe(202);
    expect(await status(row)).toMatchObject({ app, signatureChecked: true, timestampChecked: true });
    expect((await post(url, timestamped(app, BODY, stale))).status).toBe(401);
    expect((await status(row)).refusals).toEqual([{ reason: 'signature', count: 1 }]);
  });

  it('ignores every legacy signature setting', async () => {
    const post = await start();
    const settings: Array<[LegacySetting, RoutineWebhookStatus['app']]> = [
      [{ app: 'stripe' }, 'stripe'], [{ app: 'slack' }, 'slack'], [{ app: 'zendesk' }, 'zendesk'],
      [{ header: 'X-Hub-Signature-256', algorithm: 'sha256', prefix: 'sha256=' }, 'github'],
      [{ header: 'Linear-Signature', algorithm: 'sha256' }, 'linear'],
      [{ header: 'X-Signature', algorithm: 'sha1' }, 'other'],
    ];
    const tasks = [];
    for (const [i, [hmac, app]] of settings.entries()) tasks.push({ hmac, app, ...await create(`legacy-${i}`, hmac) });
    h = await h.restart();
    for (const { hmac, app, row, url } of tasks) {
      const label = JSON.stringify(hmac);
      // Still stored as saved: queued updates and receipts hash and compare it.
      const saved = await h.bus.call<unknown, RoutineView>('routines:get', h.owner, { agentId: row.agentId, routineId: row.routineId });
      expect(saved.webhook?.hmac, label).toStrictEqual(hmac);
      // With no secret saved, the setting doesn't turn checks on: an unsigned update is accepted unchecked.
      expect((await post(url)).status, label).toBe(202);
      expect(await status(row), label).toMatchObject({ app: null, signatureChecked: false });
      if ('app' in hmac && hmac.app === 'slack') {
        // A Slack URL check is answered only once it verifies as Slack, which takes a saved secret (TASK-1026 D7).
        expect((await post(url, {}, '{"type":"url_verification","challenge":"c"}')).status, label).toBe(401);
        expect((await status(row)).refusals, label).toEqual([{ reason: 'secret', count: 1 }]);
      }
      const signed = 'app' in hmac ? timestamped(hmac.app, BODY) : { [hmac.header]: `${hmac.prefix ?? ''}${hex(BODY)}` };
      await saveSecret(row);
      if (!('app' in hmac) && hmac.algorithm === 'sha1') {
        // SHA-256 only, even where SHA-1 was saved (D9a).
        expect((await post(url, { [hmac.header]: hex(BODY, secret, 'sha1') })).status, label).toBe(401);
      }
      expect((await post(url, signed)).status, label).toBe(202);
      expect(await status(row), label).toMatchObject({ app, signatureChecked: true, timestampChecked: 'app' in hmac });
      expect((await post(url)).status, label).toBe(401);
      // Removing the secret turns checks off, setting or not.
      await saveSecret(row, 'delete');
      expect((await post(url)).status, label).toBe(202);
    }
    await expect.poll(() => h.invokeCalls.length).toBe(settings.length * 3);
  });

  it('refuses when the secret can’t be read, even with no signature settings', async () => {
    const post = await start();
    const { row, url } = await create('outage');
    const warnings: Array<{ message: string; fields: unknown }> = [];
    let vault: () => Promise<string> = async () => { throw new PluginError({ plugin: '@ax/credentials', code: 'timeout', message: 'slow' }); };
    const call = h.bus.call.bind(h.bus);
    vi.spyOn(h.bus, 'call').mockImplementation(async (name, ctx, input) => {
      if (name === 'credentials:get') {
        const warn = ctx.logger.warn.bind(ctx.logger);
        ctx.logger.warn = (message, fields) => {
          if (message === 'routines_webhook_secret_fetch_failed') warnings.push({ message, fields });
          else warn(message, fields);
        };
        return vault();
      }
      return call(name, ctx, input);
    });
    // An outage is retryable: a 503 the app sends again, never a 401 it gives up on.
    expect((await post(url)).status).toBe(503);
    // A saved secret the vault can't decrypt won't fix itself on a retry: a 401 asking the owner to save it again.
    vault = async () => { throw new PluginError({ plugin: '@ax/credentials', code: 'decrypt-failed', message: 'PRIVATE vault detail' }); };
    expect((await post(url)).status).toBe(401);
    // An empty secret is unusable too: never an HMAC key anyone could reproduce.
    vault = async () => '';
    expect((await post(url, { 'Linear-Signature': hex(BODY, '') })).status).toBe(401);
    // The log names the task and the vault's error code only, never its message, a header, the body or the secret.
    expect(warnings).toEqual([
      { message: 'routines_webhook_secret_fetch_failed', fields: { agentId: row.agentId, routineId: row.routineId, code: 'timeout' } },
      { message: 'routines_webhook_secret_fetch_failed', fields: { agentId: row.agentId, routineId: row.routineId, code: 'decrypt-failed' } },
      { message: 'routines_webhook_secret_fetch_failed', fields: { agentId: row.agentId, routineId: row.routineId } },
    ]);
    expect((await status(row)).refusals).toEqual([{ reason: 'secret', count: 2 }, { reason: 'unavailable', count: 1 }]);
    expect(await queued(row)).toBe(0);
    expect(h.invokeCalls).toEqual([]);
  });

  it('fences a delivery that saw no secret when one is saved before admission', async () => {
    const post = await start();
    const { row, url } = await create('race');
    const call = h.bus.call.bind(h.bus);
    let raced = false;
    vi.spyOn(h.bus, 'call').mockImplementation(async (name, ctx, input) => {
      if (name === 'credentials:get' && !raced) {
        raced = true;
        // The secret is saved after this delivery read the vault and before it is admitted.
        await call('routines:set-webhook-secret', h.owner, secretInput(row));
        throw new PluginError({ plugin: '@ax/credentials', code: 'credential-not-found', message: 'no credential' });
      }
      return call(name, ctx, input);
    });
    expect((await post(url)).status).toBe(404);
    expect(raced).toBe(true);
    expect(await queued(row)).toBe(0);
    expect(h.invokeCalls).toEqual([]);
    expect((await status(row)).lastAcceptedAt).toBeNull();
    // The secret did land, and now decides: the same unsigned update is refused.
    expect((await post(url)).status).toBe(401);
  });

  it('refuses an unverified Slack URL check without queuing it', async () => {
    const post = await start();
    const { row, url } = await create('slack-events');
    const challenge = JSON.stringify({ type: 'url_verification', challenge: 'c' });
    expect((await post(url, {}, challenge)).status).toBe(401);
    expect(await status(row)).toMatchObject({ verifiedAt: null, lastAcceptedAt: null, refusals: [{ reason: 'secret', count: 1 }] });
    expect(await queued(row)).toBe(0);
    await saveSecret(row);
    // Signed, but not as Slack: still refused, now for its signature.
    expect((await post(url, { 'X-Hub-Signature-256': `sha256=${hex(challenge)}` }, challenge)).status).toBe(401);
    const verified = await post(url, timestamped('slack', challenge), challenge);
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ challenge: 'c' });
    expect(await status(row)).toMatchObject({ app: 'slack', verifiedAt: now.toISOString(), lastAcceptedAt: null, signatureChecked: false, refusals: [{ reason: 'signature', count: 1 }] });
    expect(await queued(row)).toBe(0);
    expect(h.invokeCalls).toEqual([]);
  });
});
