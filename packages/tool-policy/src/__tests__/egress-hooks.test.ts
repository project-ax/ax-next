/**
 * TASK-406 — `egress-allowlist:list` and `egress-allowlist:revoke` over the bus.
 *
 * The store tests next door prove the data rules. This file proves the HOOK
 * surface, which is a different set of failures and two of them are invisible
 * from inside the store:
 *
 *   - the `returns` zod re-parse, which STRIPS any key the schema does not
 *     declare. Drop `scope` from `EgressAllowlistSiteSchema` and every store
 *     test stays green while the panel loses the one field that tells a
 *     personal entry from the operator's.
 *   - the owner, which comes from `ctx.userId` and from nowhere else. There is
 *     no owner on either payload, so the tests that matter here are the ones
 *     that send somebody else's host and expect to be told no.
 *
 * NO DATABASE PLUGIN, so no testcontainer and no Docker: the plugin takes the
 * memory store through `egressStore`, and the loop these tests walk —
 * remember → list → revoke → evaluate — is the same loop either store backs.
 * `egress-allowlist.canary.test.ts` runs the real-Postgres version, which is
 * where the delete's SQL shape gets proved.
 */
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryEgressAllowlistStore } from '../egress-allowlist.js';
import { createToolPolicyPlugin } from '../plugin.js';
import type {
  EgressAllowlistSite,
  EgressListOutput,
  EgressRevokeOutput,
  EvaluateResult,
} from '../types.js';

const harnesses: TestHarness[] = [];

async function boot(globalEgressHosts: string[] = []): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [
      createToolPolicyPlugin({
        egressStore: createMemoryEgressAllowlistStore(),
        globalEgressHosts,
      }),
    ],
  });
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
});

async function remember(h: TestHarness, userId: string, host: string): Promise<unknown> {
  return h.bus.call('egress-allowlist:remember', h.ctx({ userId }), { host });
}

async function list(h: TestHarness, userId: string): Promise<EgressAllowlistSite[]> {
  const out = await h.bus.call<unknown, EgressListOutput>(
    'egress-allowlist:list',
    h.ctx({ userId }),
    {},
  );
  return out.sites;
}

async function revoke(h: TestHarness, userId: string, host: unknown): Promise<EgressRevokeOutput> {
  return h.bus.call<unknown, EgressRevokeOutput>('egress-allowlist:revoke', h.ctx({ userId }), {
    host,
  });
}

async function verdict(h: TestHarness, userId: string, url: string): Promise<string> {
  const out = await h.bus.call<unknown, EvaluateResult>(
    'tool-policy:evaluate',
    h.ctx({ userId }),
    { call: { name: 'web_extract', input: { url } }, agentId: 'a1' },
  );
  return out.verdict;
}

describe('egress-allowlist:list', () => {
  it('shows a host the caller just remembered, tagged and dated', async () => {
    const h = await boot();
    expect(await list(h, 'alice')).toEqual([]);
    await remember(h, 'alice', 'docs.example.com');

    const sites = await list(h, 'alice');
    expect(sites).toHaveLength(1);
    expect(sites[0]!.host).toBe('docs.example.com');
    expect(sites[0]!.scope).toBe('user');
    expect(Number.isNaN(Date.parse(sites[0]!.rememberedAt))).toBe(false);
  });

  it('never shows one person the list of another', async () => {
    const h = await boot();
    await remember(h, 'alice', 'docs.example.com');
    // The isolation the whole scope design exists for, asserted at the surface
    // a UI actually calls. There is no owner field on the payload, so the only
    // way this could fail is a read that forgot to name its owner.
    expect(await list(h, 'bob')).toEqual([]);
  });

  it('keeps the scope tag through the bus returns re-parse', async () => {
    // THE z.object-STRIPS TRAP. `EgressAllowlistSiteSchema` declares three
    // fields; delete `scope` from it and this is the only test that reddens —
    // the host is still there, the panel still renders, and the revoke button
    // beside the operator's entry silently becomes a no-op.
    const h = await boot(['intranet.example.com']);
    await remember(h, 'alice', 'docs.example.com');

    const sites = await list(h, 'alice');
    expect(sites.map((s) => s.host)).toEqual(['docs.example.com', 'intranet.example.com']);
    for (const site of sites) {
      expect(Object.keys(site).sort()).toEqual(['host', 'rememberedAt', 'scope']);
    }
    expect(sites.find((s) => s.host === 'docs.example.com')!.scope).toBe('user');
    expect(sites.find((s) => s.host === 'intranet.example.com')!.scope).toBe('global');
  });

  it('shows a host the operator ALSO allows exactly once, as global', async () => {
    // The shape a real deployment produces, walked over the bus. `web_extract`
    // remembers every successful fetch — including the silent one the global
    // entry permitted — so `remember` returning `true` here is the bug's
    // starting condition, not a test artefact.
    const h = await boot(['example.com']);
    expect(await verdict(h, 'alice', 'https://example.com/x')).toBe('allow');
    await remember(h, 'alice', 'example.com');

    const sites = await list(h, 'alice');
    // One row, and the one that tells the truth: while the operator's entry
    // stands, alice cannot take this host back, so the panel must not offer to.
    expect(sites.map((s) => [s.host, s.scope])).toEqual([['example.com', 'global']]);
    // And the revoke she is no longer offered would indeed not have helped —
    // proof the row we hid was the one that could not deliver on its label.
    await revoke(h, 'alice', 'example.com');
    expect(await verdict(h, 'alice', 'https://example.com/x')).toBe('allow');
  });

  it('gives a context with no real user the operator list and nothing personal', async () => {
    const h = await boot(['intranet.example.com']);
    await remember(h, 'alice', 'docs.example.com');
    const sites = await list(h, 'system');
    expect(sites.map((s) => s.host)).toEqual(['intranet.example.com']);
    expect(sites[0]!.scope).toBe('global');
  });
});

describe('egress-allowlist:revoke', () => {
  it('closes the loop: the site stops being listed AND evaluate holds it again', async () => {
    // The whole user-visible point of this card. Each half alone is a lie the
    // other half would expose: a revoke that only emptied the list would leave
    // the site silently reachable, and one that only changed the verdict would
    // leave a row somebody cannot get rid of.
    const h = await boot();
    await remember(h, 'alice', 'docs.example.com');
    expect(await verdict(h, 'alice', 'https://docs.example.com/guide')).toBe('allow');

    expect(await revoke(h, 'alice', 'docs.example.com')).toEqual({ revoked: true });

    expect(await list(h, 'alice')).toEqual([]);
    expect(await verdict(h, 'alice', 'https://docs.example.com/guide')).toBe('hold');
  });

  it("will not touch a host somebody else remembered", async () => {
    const h = await boot();
    await remember(h, 'bob', 'docs.example.com');
    // Bob's grant, named by alice. `false` and unchanged — and deliberately
    // the same `false` alice would get for a host that does not exist, because
    // a different answer would tell her what is on bob's list.
    expect(await revoke(h, 'alice', 'docs.example.com')).toEqual({ revoked: false });
    expect((await list(h, 'bob')).map((s) => s.host)).toEqual(['docs.example.com']);
    expect(await verdict(h, 'bob', 'https://docs.example.com/x')).toBe('allow');
  });

  it('will not touch an operator-seeded global entry', async () => {
    // An operator's list applies to the whole deployment. `revoke` hard-codes
    // `scope: 'user'` in the store so no payload can express this request at
    // all — if this ever answers `true`, one person can quietly narrow (or, on
    // the next seed, re-widen) what everybody else reaches.
    const h = await boot(['intranet.example.com']);
    expect(await revoke(h, 'alice', 'intranet.example.com')).toEqual({ revoked: false });

    const sites = await list(h, 'alice');
    expect(sites.map((s) => s.host)).toEqual(['intranet.example.com']);
    expect(sites[0]!.scope).toBe('global');
    expect(await verdict(h, 'alice', 'https://intranet.example.com/x')).toBe('allow');
    expect(await verdict(h, 'bob', 'https://intranet.example.com/x')).toBe('allow');
  });

  it('refuses a context that names no person', async () => {
    const h = await boot();
    await remember(h, 'alice', 'docs.example.com');
    for (const notAUser of ['system', '', 'has space']) {
      expect(await revoke(h, notAUser, 'docs.example.com'), notAUser).toEqual({ revoked: false });
    }
    // And alice still has it — a non-person context must not be able to clear
    // somebody's list by accident.
    expect((await list(h, 'alice')).map((s) => s.host)).toEqual(['docs.example.com']);
  });

  it('answers a malformed or missing host instead of throwing', async () => {
    const h = await boot();
    await remember(h, 'alice', 'docs.example.com');
    for (const bad of [
      'https://docs.example.com/x',
      '*.example.com',
      '',
      'a b',
      undefined,
      null,
      42,
      { host: 'docs.example.com' },
    ]) {
      expect(await revoke(h, 'alice', bad), JSON.stringify(bad ?? null)).toEqual({
        revoked: false,
      });
    }
    // A payload with no `host` key at all — the panel's bug, not the model's,
    // but this is a bus surface and a throw here would surface as a 500.
    expect(
      await h.bus.call<unknown, EgressRevokeOutput>(
        'egress-allowlist:revoke',
        h.ctx({ userId: 'alice' }),
        {},
      ),
    ).toEqual({ revoked: false });
    expect((await list(h, 'alice')).map((s) => s.host)).toEqual(['docs.example.com']);
  });

  it('files under the caller whatever the payload claims', async () => {
    const h = await boot();
    await remember(h, 'bob', 'docs.example.com');
    // There is no `ownerId` / `scope` on the payload. This is the test that
    // fails if somebody adds one back and starts honouring it.
    expect(
      await h.bus.call<unknown, EgressRevokeOutput>(
        'egress-allowlist:revoke',
        h.ctx({ userId: 'alice' }),
        { host: 'docs.example.com', ownerId: 'bob', scope: 'global', userId: 'bob' },
      ),
    ).toEqual({ revoked: false });
    expect(await verdict(h, 'bob', 'https://docs.example.com/x')).toBe('allow');
  });
});
