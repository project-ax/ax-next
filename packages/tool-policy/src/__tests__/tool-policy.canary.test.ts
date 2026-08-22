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
    for (const row of caps.rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['capability', 'described', 'provenance', 'source', 'verdict'].sort(),
      );
    }
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
      },
    ]);
  });
});
