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
import type { Logger } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryEgressAllowlistStore,
  type EgressAllowlistStore,
} from '../egress-allowlist.js';
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

/**
 * The list, or a thrown test failure — never a silent `[]` (TASK-464).
 *
 * NARROWING HERE IS THE POINT, not ceremony. Every `expect(await list(...))
 * .toEqual([])` below is an assertion that somebody has nothing remembered,
 * and before this hook could say `status: 'unknown'` those assertions also
 * passed over a read that never reached the store. They cannot now: an
 * unreadable list stops the test at this line with a sentence about it, rather
 * than handing back the same empty array a happy read produces.
 */
async function list(h: TestHarness, userId: string): Promise<EgressAllowlistSite[]> {
  const out = await h.bus.call<unknown, EgressListOutput>(
    'egress-allowlist:list',
    h.ctx({ userId }),
    {},
  );
  if (out.status !== 'ok') {
    throw new Error(`expected a readable list for ${userId}, got status=${out.status}`);
  }
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

/**
 * TASK-464 — "you have allowed nothing" and "we could not read your list" are
 * two facts, and only one of them is reassuring.
 *
 * This hook used to answer `{ sites: [] }` on a store throw, so the two facts
 * arrived as the SAME VALUE and every caller downstream drew the reassuring
 * one. The settings panel said "Nothing here yet" over an unread allowlist;
 * the Postgres canary's `expect(sites).toEqual([])` passed over a read that
 * never reached the table (TASK-469's mutant M13).
 *
 * WHAT MAKES THESE TESTS NON-VACUOUS. Each one asserts the failing read against
 * the succeeding read of the same shape — an empty-but-read list next to an
 * unread one — so an implementation that collapsed them again would have to
 * make two different assertions true with one value. It cannot. The `logger`
 * assertions are the second half of that: `{ status: 'unknown' }` alone could
 * in principle be produced by some future quiet path, but the catch is the only
 * thing that logs `tool_policy_egress_allowlist_list_failed`, so the pair pins
 * WHICH branch ran and not merely what it returned.
 */
describe('egress-allowlist:list — empty is not unknown (TASK-464)', () => {
  /** A logger that records what it was told, for asserting which branch ran. */
  function recorder(): { logger: Logger; errors: string[] } {
    const errors: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string) => void errors.push(msg),
      child: () => logger,
    };
    return { logger, errors };
  }

  /** A store that cannot be read. Everything else behaves. */
  function unreadableStore(): EgressAllowlistStore {
    const inner = createMemoryEgressAllowlistStore();
    return {
      ...inner,
      listFor: async () => {
        throw new Error('storage unreachable');
      },
    };
  }

  async function bootWith(egressStore: EgressAllowlistStore): Promise<TestHarness> {
    const h = await createTestHarness({
      plugins: [createToolPolicyPlugin({ egressStore })],
    });
    harnesses.push(h);
    return h;
  }

  async function raw(
    h: TestHarness,
    userId: string,
    logger?: Logger,
  ): Promise<EgressListOutput> {
    return h.bus.call<unknown, EgressListOutput>(
      'egress-allowlist:list',
      h.ctx(logger === undefined ? { userId } : { userId, logger }),
      {},
    );
  }

  it('answers `unknown` when the store throws — and `ok` with an empty list when it does not', async () => {
    // THE PAIR IS THE TEST. Run the same call against a store that cannot be
    // read and against one that simply has nothing in it, and demand two
    // different answers. Against the old implementation both of these were
    // `{ sites: [] }`, so no assertion could tell them apart.
    const broken = await bootWith(unreadableStore());
    const empty = await bootWith(createMemoryEgressAllowlistStore());

    expect(await raw(broken, 'alice')).toEqual({ status: 'unknown' });
    expect(await raw(empty, 'alice')).toEqual({ status: 'ok', sites: [] });
  });

  it('carries NO `sites` key at all on `unknown`, even after the returns re-parse', async () => {
    // `[]` has to be unreachable, not merely discouraged. A caller doing
    // `out.sites.length === 0` must fail to compile and, if it got there
    // anyway, must not find an empty array waiting for it — which is exactly
    // what `{ sites: [], unknown: true }` would have handed it.
    //
    // AFTER the bus's zod re-parse, deliberately: `discriminatedUnion` picks
    // the `unknown` member, and that member does not declare `sites`, so a
    // producer that smuggled one in has it stripped here rather than in front
    // of a reader.
    const h = await bootWith(unreadableStore());
    const out = await raw(h, 'alice');
    expect(Object.keys(out)).toEqual(['status']);
    expect('sites' in out).toBe(false);
  });

  it('took the failure branch to get there — the logger says so', async () => {
    // `{ status: 'unknown' }` is a value; this is the proof of the PATH. The
    // catch is the only line in the hook that logs this event, so a green
    // assertion above plus a silent logger would mean the answer came from
    // somewhere we did not intend.
    const broken = await bootWith(unreadableStore());
    const { logger, errors } = recorder();
    expect(await raw(broken, 'alice', logger)).toEqual({ status: 'unknown' });
    expect(errors).toEqual(['tool_policy_egress_allowlist_list_failed']);
  });

  it('stays quiet on a healthy read — the log line means what it says', async () => {
    // The other half of the previous test. A hook that logged the failure
    // event unconditionally would pass that one while meaning nothing.
    const h = await bootWith(createMemoryEgressAllowlistStore());
    const { logger, errors } = recorder();
    await remember(h, 'alice', 'docs.example.com');
    const out = await raw(h, 'alice', logger);
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' ? out.sites.map((s) => s.host) : null).toEqual([
      'docs.example.com',
    ]);
    expect(errors).toEqual([]);
  });

  it('still refuses to throw at its caller', async () => {
    // The soft-fail posture is unchanged and that is deliberate: this hook sits
    // in front of a settings panel, and a throw turns a degraded panel into a
    // broken one. What changed is the VALUE it fails with, not whether it fails
    // loudly. If this ever rejects, every caller's error path becomes reachable
    // and the panel's three states become four.
    const h = await bootWith(unreadableStore());
    await expect(raw(h, 'alice')).resolves.toBeDefined();
  });

  it('does not stop the allowlist ENFORCING while its list is unreadable', async () => {
    // The bound on the exposure, asserted rather than assumed (#618 inferred
    // it; this pins it). `listFor` and `allowedFor` are two reads, and only the
    // first one is broken here — so a site alice remembered is still silent,
    // and one she did not is still held, while the panel can say nothing about
    // either. The panel going blind must not take the gate with it.
    const h = await bootWith(unreadableStore());
    await remember(h, 'alice', 'docs.example.com');
    expect(await verdict(h, 'alice', 'https://docs.example.com/x')).toBe('allow');
    expect(await verdict(h, 'alice', 'https://elsewhere.example.com/x')).toBe('hold');
    expect(await raw(h, 'alice')).toEqual({ status: 'unknown' });
  });
});
