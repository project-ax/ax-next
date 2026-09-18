import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolPolicyPlugin } from '../plugin.js';
import { BUILTIN_RULES } from '../rules.js';
import type { EvaluateResult, ListCapabilitiesOutput } from '../types.js';

/**
 * The canary: both hooks reachable through a real bus, with the real `returns`
 * zod applied. That last part is the point — a `z.object` STRIPS keys it does
 * not declare, so this is the test that fails if a field is added to the
 * interface and not to the schema.
 *
 * No database: the rule table is in-repo.
 */
const harnesses: TestHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
});

async function boot(): Promise<TestHarness> {
  const h = await createTestHarness({ plugins: [createToolPolicyPlugin()] });
  harnesses.push(h);
  return h;
}

const VERDICT_ORDER = ['allow', 'hold', 'deny'];

describe('tool-policy canary', () => {
  it('evaluate and list-capabilities are reachable through the bus', async () => {
    const h = await boot();
    const holdRule = BUILTIN_RULES.find((r) => r.verdict === 'hold')!;

    const verdict = await h.bus.call<unknown, EvaluateResult>(
      'tool-policy:evaluate',
      h.ctx(),
      { call: { name: holdRule.match.tool, input: {} }, agentId: 'a1' },
    );
    expect(verdict).toEqual({
      verdict: 'hold',
      ruleId: holdRule.id,
      capability: holdRule.capability,
      irreversible: holdRule.irreversible === true,
      // Derived, not hard-coded: the hold rule this picks up is whichever one
      // `rules.ts` lists first, and today it declares no effect. `?? []`
      // because `EvaluateResult.effect` is REQUIRED and spells "nothing
      // declared" `[]`, while a rule spells it by omission — the two spellings
      // are deliberate and documented on both types.
      effect: holdRule.effect ?? [],
    });

    const caps = await h.bus.call<unknown, ListCapabilitiesOutput>(
      'tool-policy:list-capabilities',
      h.ctx(),
      { agentId: 'a1' },
    );
    expect(caps.rows.length).toBe(BUILTIN_RULES.length);
    const order = caps.rows.map((r) => VERDICT_ORDER.indexOf(r.verdict));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('applies outOfReach ACROSS THE BUS, keeping every deny', async () => {
    /*
      The unit test pins the filter; this pins that the filter survives the hook
      boundary. `outOfReach` is an INPUT, and an input silently dropped on the
      way in fails exactly like no filter at all — the rail would go back to
      asserting reach an agent does not have, with every test still green.
    */
    const h = await boot();
    const reachClaims = BUILTIN_RULES.filter((r) => r.verdict !== 'deny');
    const denies = BUILTIN_RULES.filter((r) => r.verdict === 'deny');

    const caps = await h.bus.call<unknown, ListCapabilitiesOutput>(
      'tool-policy:list-capabilities',
      h.ctx(),
      { agentId: 'a1', outOfReach: reachClaims.map((r) => r.match.tool) },
    );
    expect(caps.rows.map((r) => r.source)).toEqual(denies.map((r) => `rule:${r.id}`));

    // …and the rows are unchanged for a caller that proved nothing.
    const all = await h.bus.call<unknown, ListCapabilitiesOutput>(
      'tool-policy:list-capabilities',
      h.ctx(),
      { agentId: 'a1' },
    );
    expect(all.rows.length).toBe(BUILTIN_RULES.length);
  });

  it('survives the returns schema with every declared field intact', async () => {
    const h = await boot();
    const caps = await h.bus.call<unknown, ListCapabilitiesOutput>(
      'tool-policy:list-capabilities',
      h.ctx(),
      { agentId: 'a1' },
    );
    /*
      `effect` (TASK-329) is declared PER RULE, so the key is present on some
      rows and absent on others, and the expected key list is DERIVED from the
      live table rather than fixed.

      That derivation is the point, not a weakening. A `z.object` STRIPS what
      it does not declare, so this loop — which goes through the real `returns`
      parse — is the only thing standing between `effect` and vanishing
      silently on the way out of the bus, and the rail would render no
      disclosure with every unit test on the row object still green. A
      hard-coded list could not express it: it would have to either demand the
      key on rows whose rule declares nothing or forbid it on the rows that
      carry one.
    */
    const declaredEffect = new Map(BUILTIN_RULES.map((r) => [`rule:${r.id}`, r.effect]));
    const BASE_KEYS = [
      'capability',
      'conditional',
      'described',
      'provenance',
      'source',
      'verdict',
    ];
    for (const row of caps.rows) {
      const effect = declaredEffect.get(row.source);
      expect(Object.keys(row).sort(), row.source).toEqual(
        [...BASE_KEYS, ...(effect === undefined ? [] : ['effect'])].sort(),
      );
      // The VALUE crossed too, not just the key — this is the assertion that
      // reddens if `effect` is dropped from `CapabilityRowSchema`.
      // `toEqual` since TASK-330 made `effect` a SET — `toBe` on two arrays
      // compares references and fails even when the values match, which is how
      // this line read when the change landed.
      expect(row.effect, row.source).toEqual(effect);
    }
    /*
      NON-VACUITY GUARD. Everything above passes identically against a schema
      with no `effect` line IF no effect-bearing row reaches the loop — the
      branch that expects the key would simply never be taken.

      Asserted on the ROWS, not on `BUILTIN_RULES`. The first version of this
      guard pinned that the TABLE declares an effect somewhere, which coincides
      with "a row carrying one arrived" only because this call sends no
      `outOfReach`. Add a subtraction here that happened to drop the two web
      rules and a table-level guard would still pass while the loop went quiet
      again — re-vacuizing silently, which is the whole failure mode this
      guard exists to prevent. Caught in review.
    */
    expect(caps.rows.some((r) => r.effect !== undefined)).toBe(true);
  });

  it('carries fullyDescribedTools ACROSS THE BUS, naming every tool an unconditional rule covers', async () => {
    /*
      Same hazard as the `outOfReach` canary above, in the other direction: a
      `z.object` STRIPS what it does not declare, so a field the handler returns
      and the schema forgets vanishes silently on the way out. The caller then
      sees NO tool as described and re-lists every ruled tool as an undescribed
      one — a second, mechanical `allow` row for a tool a rule holds or denies,
      with every unit test still green.

      Asserted against the LIVE table, so it also pins the shipped table's own
      shape: no builtin rule carries a `when` today (`rules.ts` says so), so
      every tool it names is fully described, and the day one does the two sets
      stop matching and this test says which tool went conditional-only.
    */
    const h = await boot();
    const caps = await h.bus.call<unknown, ListCapabilitiesOutput>(
      'tool-policy:list-capabilities',
      h.ctx(),
      { agentId: 'a1' },
    );
    expect(new Set(caps.fullyDescribedTools)).toEqual(
      new Set(
        BUILTIN_RULES.filter((r) => r.match.when === undefined).map((r) => r.match.tool),
      ),
    );
  });

  it('hands each caller its own rows — one caller cannot rewrite another’s', async () => {
    // The rows carry a security claim and the plugin caches them. If a caller
    // could edit one in place, every later reader would be told something a
    // human never reviewed.
    const h = await boot();
    const first = await h.bus.call<unknown, ListCapabilitiesOutput>(
      'tool-policy:list-capabilities',
      h.ctx(),
      { agentId: 'a1' },
    );
    const original = first.rows[0]!.capability;
    first.rows[0]!.capability = 'do absolutely anything';
    first.rows.length = 0;

    const second = await h.bus.call<unknown, ListCapabilitiesOutput>(
      'tool-policy:list-capabilities',
      h.ctx(),
      { agentId: 'a1' },
    );
    expect(second.rows[0]!.capability).toBe(original);
    expect(second.rows.length).toBe(BUILTIN_RULES.length);
  });

  it('answers allow with a null rule for a tool no rule mentions', async () => {
    const h = await boot();
    const verdict = await h.bus.call<unknown, EvaluateResult>(
      'tool-policy:evaluate',
      h.ctx(),
      { call: { name: 'no_such_tool', input: {} }, agentId: 'a1' },
    );
    // No rule matching is allow: the table is an exception list over a system
    // whose baseline reach is already bounded by the tool catalog, the egress
    // allowlist and the connector scoping (AW-1).
    expect(verdict).toEqual({
      verdict: 'allow',
      ruleId: null,
      capability: null,
      irreversible: false,
      // Nothing to union: no rule names this tool, so the table has said
      // nothing about it. Contrast the when-only tool below, where rules DO
      // name the tool and none of them matched.
      effect: [],
    });
  });

  it('answers allow with a CATALOG rule for a sandbox builtin (AW-14)', async () => {
    const h = await boot();
    const verdict = await h.bus.call<unknown, EvaluateResult>(
      'tool-policy:evaluate',
      h.ctx(),
      { call: { name: 'Bash', input: { command: 'ls' } }, agentId: 'a1' },
    );
    // AW-1 declined to seed the six sandbox builtins because a HOLD on Bash
    // fires on every command. AW-14 seeded them as `catalog` ALLOW rows
    // instead: the verdict is unchanged (allow either way) and the rail gains
    // the sentence it was otherwise silent about, which design H4 forbids.
    expect(verdict).toMatchObject({ verdict: 'allow', ruleId: 'sandbox.bash' });
  });

  it('answers deny for a disabled builtin as a rail row, not as enforcement', async () => {
    const h = await boot();
    const verdict = await h.bus.call<unknown, EvaluateResult>(
      'tool-policy:evaluate',
      h.ctx(),
      { call: { name: 'WebFetch', input: {} }, agentId: 'a1' },
    );
    // NOTE what this does NOT prove: the claude-sdk runner denies WebFetch
    // before `tool:pre-call` is ever fired, so this rule can never fire in
    // production. It is a rail row. `DISABLED_BUILTINS` is the enforcement.
    expect(verdict.verdict).toBe('deny');
    expect(verdict.ruleId).toBe('builtins.web-fetch');
  });

  it('a second plugin instance can be given its own rule table', async () => {
    // The seam AW-4's tests need: a canary that wants a predictable table
    // must not have to mutate the shipped one.
    const h = await createTestHarness({
      plugins: [
        createToolPolicyPlugin({
          rules: [
            {
              id: 'test.only',
              match: { tool: 'only' },
              verdict: 'deny',
              capability: 'do the one thing',
              subject: 'agent',
            },
          ],
        }),
      ],
    });
    harnesses.push(h);
    const caps = await h.bus.call<unknown, ListCapabilitiesOutput>(
      'tool-policy:list-capabilities',
      h.ctx(),
      { agentId: 'a1' },
    );
    expect(caps.rows).toEqual([
      {
        verdict: 'deny',
        capability: 'do the one thing',
        source: 'rule:test.only',
        provenance: 'rule',
        described: true,
        conditional: false,
      },
    ]);
    expect(caps.fullyDescribedTools).toEqual(['only']);
  });

  it('carries effect ACROSS THE BUS, key and value intact (TASK-383)', async () => {
    /*
      `list-capabilities` has had a key-shape guard against the `z.object`
      strip since TASK-329; `evaluate` had none, and it is the surface the rail
      builds its MECHANICAL rows from. Same hazard, worse blast radius: a field
      on the interface that the schema forgets vanishes silently on the way out
      of the bus, the rail draws no disclosure, and every unit test on the
      object `evaluate()` RETURNS stays green because they run before the parse.

      Mutant to re-run if you touch this: delete the `effect` line from
      `EvaluateResultSchema` and both assertions below must red.
    */
    const h = await boot();
    const extract = BUILTIN_RULES.find((r) => r.id === 'web.extract')!;
    // NON-VACUITY. Everything below would pass against a schema with no
    // `effect` line if the rule it reads declared nothing — `undefined` on both
    // sides, agreeing about nothing. Pinned here rather than hard-coded so the
    // assertion cannot outlive the rule that makes it meaningful.
    expect(extract.effect?.length ?? 0).toBeGreaterThan(0);

    const out = await h.bus.call<unknown, EvaluateResult>(
      'tool-policy:evaluate',
      h.ctx(),
      { call: { name: extract.match.tool, input: { url: 'https://example.test/' } }, agentId: 'a1' },
    );
    expect(Object.keys(out).sort()).toEqual(
      ['capability', 'effect', 'irreversible', 'ruleId', 'verdict'].sort(),
    );
    // The VALUE crossed, not just the key, and `toEqual` because it is a SET:
    // `toBe` compares array references and `not.toBe('outward')` on an array is
    // vacuously true, which is how a disclosure guard stops being one.
    expect(out.effect).toEqual(extract.effect);
  });

  it('unions a when-only tool ACROSS THE BUS — the base row the card is about', async () => {
    /*
      The shipped table has no conditional rule (`rules.ts` says so and
      `fullyDescribedTools` proves it), so the case this field exists for cannot
      be reached through `BUILTIN_RULES`. Planting a fake conditional rule in
      the shipping table to make it reachable would be worse — the table is a
      reviewed security document, not a fixture — so this uses the same
      own-rule-table seam AW-4's canaries use.

      What it proves that the unit test cannot: the union survives the `returns`
      parse. That matters because the union is the ONLY branch the rail's
      mechanical base row ever takes, and an empty array is exactly what a
      silently-stripped field looks like from the other side.
    */
    const h = await createTestHarness({
      plugins: [
        createToolPolicyPlugin({
          rules: [
            {
              id: 'test.charge.usd',
              match: { tool: 'charge', when: { field: 'currency', equals: 'usd' } },
              verdict: 'hold',
              capability: 'charge a card in dollars',
              subject: 'agent',
              effect: ['spends'],
            },
            {
              id: 'test.charge.eur',
              match: { tool: 'charge', when: { field: 'currency', equals: 'eur' } },
              verdict: 'hold',
              capability: 'charge a card in euros',
              subject: 'agent',
              effect: ['spends', 'outward'],
            },
          ],
        }),
      ],
    });
    harnesses.push(h);

    const caps = await h.bus.call<unknown, ListCapabilitiesOutput>(
      'tool-policy:list-capabilities',
      h.ctx(),
      { agentId: 'a1' },
    );
    // The precondition the base row is built on, asserted rather than assumed:
    // `charge` is named by the table and NOT fully described, which is what
    // makes the caller ask `evaluate` about an empty input in the first place.
    expect(caps.fullyDescribedTools).toEqual([]);

    const out = await h.bus.call<unknown, EvaluateResult>(
      'tool-policy:evaluate',
      h.ctx(),
      { call: { name: 'charge', input: {} }, agentId: 'a1' },
    );
    expect(out).toEqual({
      verdict: 'allow',
      ruleId: null,
      capability: null,
      irreversible: false,
      effect: ['spends', 'outward'],
    });
  });
});
