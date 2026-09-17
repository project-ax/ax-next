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
 */
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createTestHarness, stopPostgresContainer, type TestHarness } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createToolPolicyPlugin } from '../plugin.js';
import type { EvaluateResult, ListCapabilitiesOutput, ToolPolicyPluginOptions } from '../index.js';

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
