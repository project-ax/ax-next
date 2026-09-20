/**
 * TASK-330 canary — the egress allowlist end to end, against a real database.
 *
 * The other tool-policy tests exercise the pure halves. This one is the only
 * thing that proves the whole loop actually closes in a deployment:
 *
 *   `egress-allowlist:remember` over the bus  ->  a row in Postgres
 *     ->  `tool-policy:evaluate` reads it back  ->  the hold becomes a silent allow
 *
 * Every step of that crosses a boundary where the answer could quietly go the
 * other way — the returns zod, the `null` ↔ `''` owner sentinel, a query that
 * forgot to name the owner — and the failure mode of each is an allow somebody
 * did not grant. Hence a canary rather than a unit test with a fake store.
 *
 * ---------------------------------------------------------------------------
 * VACUITY LEDGER (TASK-469, 2026-09-19) — why this green is worth believing
 *
 * #618 left this suite green at 12/12 with its vacuity never demonstrated: the
 * one mutant that mattered died on a Docker flap. A canary that has never been
 * made to go red is decoration, so every claim below was mutated and RUN, on a
 * daemon proved alive by starting a container rather than by reading `rc=0`.
 * Each mutant was restored with `git checkout --` and the file re-hashed to
 * confirm the restore was byte-identical.
 *
 * Counts are against THIS suite as it now stands, 14 tests:
 *
 *   mutant (what was broken)                          result   counts
 *   M1  db revoke returns true over an UNTOUCHED table KILLED   3 red / 11 pass
 *   M2  revoke may also delete the GLOBAL row          KILLED   1 red / 13 pass
 *   M3  revoke stops naming the owner                  KILLED   1 red / 13 pass
 *   M4  the read stops naming its owner                KILLED   3 red / 11 pass
 *   M5  listFor stops deduping                         KILLED   1 red / 13 pass
 *   M6  normalizeHost accepts anything non-empty       KILLED   1 red / 13 pass
 *   M7  a non-person id may own an entry               KILLED   1 red / 13 pass
 *   M8  the plugin falls back to the in-memory store   KILLED   1 red / 13 pass
 *   M9  an unreadable payload stops being a deny       KILLED   1 red / 13 pass
 *   M10 remember files under the payload's ownerId     KILLED   1 red / 13 pass
 *   M11 the database is unreachable                    KILLED  14 red /  0 pass
 *   M12 every read returns zero rows                   KILLED   9 red /  5 pass
 *   M13 listFor throws (hook swallows -> { sites: [] })KILLED   4 red / 10 pass
 *
 * M1 here is the mutant TASK-469's card calls M4 — the one #618 could not run.
 * It dies, so the DELETE really does reach Postgres. The total never shrank in
 * any round either: every mutant reddened tests rather than removing them,
 * which is the failure mode that makes a mutation run lie.
 *
 * M2, M3 and M13 tell a second story, and it is the reason this card existed
 * rather than a footnote to it. Against the suite AS #618 LEFT IT, M2 and M3
 * SURVIVED — all 167 tests in `@ax/tool-policy` stayed green with a `revoke`
 * that could delete the operator's deployment-wide row, or anybody else's —
 * and M13 was caught only by the overlap case, leaving `revoke`'s own list
 * assertion blind to a read that never happened. M2 and M3 produced the two
 * cases titled TASK-469 below; M13 produced the `sites()` read added INSIDE
 * the TASK-406 revoke case, which is commented there.
 *
 * WHICH DIRECTION DOES THE CANARY ITSELF FAIL IN? Red, on all three of the
 * shapes worth fearing: an unreachable database (M11), a table that answers
 * nothing (M12), and a read that throws into a soft-fail `{ sites: [] }`
 * (M13). It does NOT silently pass on the in-memory store either (M8) — the
 * restart case is what holds that door, which is worth knowing before anyone
 * "simplifies" it away.
 *
 * Re-proving any of this is a local job, not a CI-only one: mutate,
 * `npx vitest run src/__tests__/egress-allowlist.canary.test.ts` from this
 * package, `git checkout --` the file. ~6 s a round on a warm image.
 * ---------------------------------------------------------------------------
 */
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createTestHarness, stopPostgresContainer, type TestHarness } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createToolPolicyPlugin } from '../plugin.js';
import type {
  EgressListOutput,
  EvaluateResult,
  ListCapabilitiesOutput,
  ToolPolicyPluginOptions,
} from '../index.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function boot(opts: ToolPolicyPluginOptions = {}): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [createDatabasePostgresPlugin({ connectionString }), createToolPolicyPlugin(opts)],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    await c.query('DROP TABLE IF EXISTS tool_policy_v1_egress_allowlist');
  } finally {
    await c.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const EXTRACT = (url: string) => ({
  call: { name: 'web_extract', input: { url } },
  agentId: 'a1',
});

async function verdict(h: TestHarness, userId: string, url: string): Promise<string> {
  const out = await h.bus.call<unknown, EvaluateResult>(
    'tool-policy:evaluate',
    h.ctx({ userId }),
    EXTRACT(url),
  );
  return out.verdict;
}

/** What the settings panel would show this person, as `[host, scope]` pairs. */
async function sites(h: TestHarness, userId: string): Promise<[string, string][]> {
  const out = await h.bus.call<unknown, EgressListOutput>(
    'egress-allowlist:list',
    h.ctx({ userId }),
    {},
  );
  return out.sites.map((s) => [s.host, s.scope]);
}

describe('egress allowlist canary', () => {
  it('holds an unknown site on a fresh install, and remembering it makes the next read silent', async () => {
    const h = await boot();

    // The fresh-install default is EMPTY, and it is only safe because a miss is
    // a hold rather than a refusal. If this ever comes back `allow`, the tool
    // is back to fetching any public URL the model names.
    expect(await verdict(h, 'alice', 'https://docs.example.com/guide')).toBe('hold');

    expect(
      await h.bus.call('egress-allowlist:remember', h.ctx({ userId: 'alice' }), {
        host: 'docs.example.com',
      }),
    ).toEqual({ remembered: true });

    // A different page on the same site, to prove the grant is the HOST and not
    // the one URL that was approved.
    expect(await verdict(h, 'alice', 'https://docs.example.com/another?q=1')).toBe('allow');
  });

  it('never widens anybody else — one person answering is not everybody answering', async () => {
    const h = await boot();
    await h.bus.call('egress-allowlist:remember', h.ctx({ userId: 'alice' }), {
      host: 'docs.example.com',
    });
    // The card's whole reason for excluding an agent tier, asserted against a
    // real table: an entry is a personal decision and stays one.
    expect(await verdict(h, 'bob', 'https://docs.example.com/guide')).toBe('hold');
  });

  it('files the entry under the CALLER, whatever the payload says', async () => {
    const h = await boot();
    // There is no owner field on the payload — this is the test that fails if
    // somebody adds one back, because a caller could then grant silent
    // outbound reach on a person's behalf without them ever being asked.
    await h.bus.call('egress-allowlist:remember', h.ctx({ userId: 'alice' }), {
      host: 'docs.example.com',
      ownerId: 'bob',
      scope: 'global',
      userId: 'bob',
    });
    expect(await verdict(h, 'bob', 'https://docs.example.com/x')).toBe('hold');
    expect(await verdict(h, 'alice', 'https://docs.example.com/x')).toBe('allow');
  });

  it('survives a restart — the entry is in the database, not in the process', async () => {
    const first = await boot();
    await first.bus.call('egress-allowlist:remember', first.ctx({ userId: 'alice' }), {
      host: 'docs.example.com',
    });
    await harnesses.pop()!.close({ onError: () => {} });

    const second = await boot();
    expect(await verdict(second, 'alice', 'https://docs.example.com/x')).toBe('allow');
  });

  it('applies an operator-seeded global list to everybody, and only what it was given', async () => {
    const h = await boot({ globalEgressHosts: ['intranet.example.com', 'NOT a host'] });
    expect(await verdict(h, 'alice', 'https://intranet.example.com/x')).toBe('allow');
    expect(await verdict(h, 'bob', 'https://intranet.example.com/x')).toBe('allow');
    // A malformed entry is skipped, not fatal — one typo in a deployment's
    // config must not take the host down — and it certainly grants nothing.
    expect(await verdict(h, 'alice', 'https://not-a-host.test/x')).toBe('hold');
  });

  it('answers remembered: false for a host it will not store, and never throws', async () => {
    const h = await boot();
    // A URL rather than a hostname is the shape mistake that would make the
    // list bypassable, so it is refused — but a tool call that already
    // succeeded must not FAIL because a convenience did, so it is an answer
    // rather than an error.
    for (const host of ['https://docs.example.com/x', '*.example.com', '', 'a b']) {
      expect(
        await h.bus.call('egress-allowlist:remember', h.ctx({ userId: 'alice' }), { host }),
      ).toEqual({ remembered: false });
    }
    expect(await verdict(h, 'alice', 'https://docs.example.com/x')).toBe('hold');
  });

  it('refuses to file anything under a context with no real user', async () => {
    const h = await boot();
    expect(
      await h.bus.call('egress-allowlist:remember', h.ctx({ userId: 'system' }), {
        host: 'docs.example.com',
      }),
    ).toEqual({ remembered: false });
    expect(await verdict(h, 'system', 'https://docs.example.com/x')).toBe('hold');
  });

  it('reads the global list — and only that — for an id it would never write under', async () => {
    // A REGRESSION TEST, and the bug it pins was invisible in behaviour.
    //
    // The first cut asked the database for `owner_user_id = '\u0000'` when the
    // caller's id was one this store refuses to file under, on the theory that a
    // sentinel cannot match a row. Two things were wrong with it. Postgres
    // REJECTS a NUL byte in a text parameter, so the read threw and the plugin's
    // catch turned it into "we do not know what is allowed" — fail-closed, but
    // by accident, and it would also have swallowed the operator's global list.
    // And the escape was written into the source as a raw NUL byte, which makes
    // the file invisible to plain grep; `scripts/__tests__/no-raw-nul-bytes` is
    // what caught THAT half.
    //
    // The behaviour this asserts: the personal half of the query is dropped, the
    // operator's half still answers, and nothing throws.
    const h = await boot({ globalEgressHosts: ['intranet.example.com'] });
    await h.bus.call('egress-allowlist:remember', h.ctx({ userId: 'alice' }), {
      host: 'docs.example.com',
    });
    for (const notAUser of ['system', '', 'has space', '_leading']) {
      expect(await verdict(h, notAUser, 'https://intranet.example.com/x')).toBe('allow');
      expect(await verdict(h, notAUser, 'https://docs.example.com/x')).toBe('hold');
    }
  });

  it('denies a payload it cannot read a call out of, instead of throwing', async () => {
    // Raised in review. `evaluate` reads `call.name`, so a missing `call` would
    // raise a TypeError inside `@ax/decisions`' `tool:pre-call` subscriber —
    // where `HookBus.fire` CATCHES a subscriber's throw and continues, making it
    // a SILENT ALLOW. Unreachable through today's one caller, which always sends
    // a well-formed call; asserted anyway, because the cost of being wrong on
    // this path is the whole gate.
    //
    // `deny` and not `hold`: a hold invites a person to say yes to a call
    // nothing could describe.
    const h = await boot();
    for (const bad of [{}, { call: null }, { call: {} }, { call: { name: '' } }, { call: { name: 7 } }]) {
      const out = await h.bus.call<unknown, EvaluateResult>(
        'tool-policy:evaluate',
        h.ctx({ userId: 'alice' }),
        bad,
      );
      expect(out, JSON.stringify(bad)).toEqual({
        verdict: 'deny',
        ruleId: null,
        capability: null,
        irreversible: false,
        // `[]` and not a missing key (TASK-383): `effect` is REQUIRED on
        // `EvaluateResult`, so a deny that omitted it would fail the bus's
        // `returns` parse and this deliberated refusal would leave as an
        // exception instead — `@ax/decisions` would swap it for its generic
        // gate-failure sentence, and the rail would drop the row entirely.
        // This assertion is what noticed: it reddens with a ZodError, not with
        // a diff, which is worth knowing before you read the failure.
        //
        // The VALUE is `[]` because there is nothing to disclose about a call
        // we could not read — no tool name means nothing to union.
        effect: [],
      });
    }
  });

  it('takes a site back out — the DELETE reaches the table, and the hold returns (TASK-406)', async () => {
    // The revoke half of the loop, against a real database, for the same
    // reason the remember half is here: every hop between the hook and the row
    // is somewhere the answer can quietly go the other way. In particular a
    // `revoke` that returned `true` over an UNTOUCHED table would pass every
    // in-memory test in this package — `numDeletedRows` is a bigint, and
    // reading it wrong is a cheerful lie rather than an error.
    const h = await boot();
    await h.bus.call('egress-allowlist:remember', h.ctx({ userId: 'alice' }), {
      host: 'docs.example.com',
    });
    expect(await verdict(h, 'alice', 'https://docs.example.com/guide')).toBe('allow');

    // READ THE LIST BEFORE THE REVOKE, and this is not ceremony (TASK-469).
    //
    // The `toEqual([])` below was vacuous on its own, proved by construction:
    // mutant M13 made `listFor` THROW, `egress-allowlist:list` swallowed it
    // into its deliberate `{ sites: [] }` soft-fail, and the assertion passed
    // over a read that never reached the table. That is the same shape a
    // sibling panel shipped — a store throw rendered as a reassuring "nothing
    // here yet". With this line first, `[]` afterwards means the ROW WENT
    // AWAY, because the identical read returned it a moment ago.
    expect(await sites(h, 'alice')).toEqual([['docs.example.com', 'user']]);

    expect(
      await h.bus.call('egress-allowlist:revoke', h.ctx({ userId: 'alice' }), {
        host: 'docs.example.com',
      }),
    ).toEqual({ revoked: true });

    // Both halves. The verdict is what the agent experiences; the list is what
    // the person sees, and a panel that still shows a revoked site is a panel
    // nobody can trust.
    expect(await verdict(h, 'alice', 'https://docs.example.com/guide')).toBe('hold');
    expect(await sites(h, 'alice')).toEqual([]);

    // Nothing to delete the second time — and no error either.
    expect(
      await h.bus.call('egress-allowlist:revoke', h.ctx({ userId: 'alice' }), {
        host: 'docs.example.com',
      }),
    ).toEqual({ revoked: false });
  });

  it('cannot revoke the operator’s global entry, whoever asks (TASK-469)', async () => {
    // A HOLE THE CANARY HAD, found by mutation rather than by reading.
    //
    // `revoke` hard-codes `scope: 'user'` inside the store, and the interface
    // calls that "the security decision rather than a simplification" — a
    // scope parameter would put every caller one typo away from deleting the
    // deployment-wide list. Nothing asserted it. Mutant M2 rewrote the DELETE
    // to `owner_user_id in [ownerId, '']` with the scope filter dropped, so a
    // person's revoke also took out the operator's row, and ALL 167 TESTS IN
    // THIS PACKAGE STAYED GREEN. The in-memory store cannot be asked this
    // question at all — its only global bucket lives under a key `revoke`
    // cannot produce — so the db store is the one that needs the test, and
    // this is the file that has a db.
    const h = await boot({ globalEgressHosts: ['intranet.example.com'] });
    expect(await verdict(h, 'alice', 'https://intranet.example.com/x')).toBe('allow');

    // Nothing of hers to take back: `false` is the whole answer, and she is
    // deliberately not told that a row she cannot delete exists.
    //
    // THIS is the line M2 reddens, and it reddens first —
    // `expected { revoked: true } to deeply equal { revoked: false }`, because
    // the mutant's DELETE matched the operator's row and reported success.
    expect(
      await h.bus.call('egress-allowlist:revoke', h.ctx({ userId: 'alice' }), {
        host: 'intranet.example.com',
      }),
    ).toEqual({ revoked: false });

    // The operator's list is untouched — for her and for everybody else. These
    // are the consequence of the same mutant rather than a second finding: with
    // the global row deleted, both verdicts fall back to `hold`. They are here
    // because `revoked: false` alone would also be satisfied by a revoke that
    // did nothing at all for the wrong reason.
    expect(await verdict(h, 'alice', 'https://intranet.example.com/x')).toBe('allow');
    expect(await verdict(h, 'bob', 'https://intranet.example.com/x')).toBe('allow');
    expect(await sites(h, 'alice')).toEqual([['intranet.example.com', 'global']]);

    // And the same once she ALSO has a personal row for that host — the
    // routine overlap, since `web_extract` remembers even the silent fetches.
    // Her revoke takes hers; the operator's still stands.
    expect(
      await h.bus.call('egress-allowlist:remember', h.ctx({ userId: 'alice' }), {
        host: 'intranet.example.com',
      }),
    ).toEqual({ remembered: true });
    expect(
      await h.bus.call('egress-allowlist:revoke', h.ctx({ userId: 'alice' }), {
        host: 'intranet.example.com',
      }),
    ).toEqual({ revoked: true });
    expect(await verdict(h, 'alice', 'https://intranet.example.com/x')).toBe('allow');
    expect(await verdict(h, 'bob', 'https://intranet.example.com/x')).toBe('allow');
  });

  it('cannot revoke somebody else’s entry — the DELETE names its owner (TASK-469)', async () => {
    // The second hole, same method. Mutant M3 dropped
    // `.where('owner_user_id', '=', ownerId)` from the DELETE, leaving the
    // host match and the scope filter, and all 167 tests stayed green — one
    // person's revoke would have reached into everybody's list for that host.
    //
    // Deleting a grant fails CLOSED for egress, so this is not a way to widen
    // anybody's reach. It is still somebody else's decision being thrown away
    // without them asking, on the one surface whose job is to tell a person
    // what they agreed to.
    const h = await boot();
    for (const who of ['alice', 'bob']) {
      expect(
        await h.bus.call('egress-allowlist:remember', h.ctx({ userId: who }), {
          host: 'docs.example.com',
        }),
      ).toEqual({ remembered: true });
    }

    expect(
      await h.bus.call('egress-allowlist:revoke', h.ctx({ userId: 'bob' }), {
        host: 'docs.example.com',
      }),
    ).toEqual({ revoked: true });

    // Bob's is gone; Alice's is exactly as she left it.
    expect(await verdict(h, 'bob', 'https://docs.example.com/x')).toBe('hold');
    expect(await sites(h, 'bob')).toEqual([]);
    expect(await verdict(h, 'alice', 'https://docs.example.com/x')).toBe('allow');
    expect(await sites(h, 'alice')).toEqual([['docs.example.com', 'user']]);
  });

  it('reports a host on BOTH lists once, as global, against a real database (TASK-406)', async () => {
    // The in-memory version of this lives next door; it is here as well
    // because the db store answers it with a UNION over two exact keys and a
    // dedupe in TypeScript, and "did the SQL really return both rows" is not
    // a question the memory store can be asked. The overlap itself is routine:
    // `web_extract` remembers every successful fetch, the silent ones
    // included, so the first read of an operator-seeded host writes a personal
    // row beside the global one.
    const h = await boot({ globalEgressHosts: ['example.com'] });
    expect(await verdict(h, 'alice', 'https://example.com/x')).toBe('allow');
    expect(
      await h.bus.call('egress-allowlist:remember', h.ctx({ userId: 'alice' }), {
        host: 'example.com',
      }),
    ).toEqual({ remembered: true });

    const out = await h.bus.call<unknown, EgressListOutput>(
      'egress-allowlist:list',
      h.ctx({ userId: 'alice' }),
      {},
    );
    expect(out.sites.map((s) => [s.host, s.scope])).toEqual([['example.com', 'global']]);
  });

  it('leaves the rail row honest about the contingency', async () => {
    const h = await boot();
    const caps = await h.bus.call<unknown, ListCapabilitiesOutput>(
      'tool-policy:list-capabilities',
      h.ctx({ userId: 'alice' }),
      { agentId: 'a1' },
    );
    const row = caps.rows.find((r) => r.source === 'rule:web.extract');
    expect(row).toBeDefined();
    // "Asks you first" flat would promise a gate that is not there for every
    // site this person has already allowed; `conditional` is what stops the
    // renderer making that claim.
    expect(row!.conditional).toBe(true);
    // And BOTH disclosures survive the returns zod. A `z.object` strips what it
    // does not declare, so an `effect` line that still said `ToolEffectSchema`
    // instead of an array would drop this silently.
    expect(row!.effect).toEqual(['spends', 'outward']);
    expect(row!.verdict).toBe('hold');
    // Still fully described: the rule has no `when` predicate, so the caller
    // does NOT add a second mechanical base row beside this one.
    expect(caps.fullyDescribedTools).toContain('web_extract');
  });
});
