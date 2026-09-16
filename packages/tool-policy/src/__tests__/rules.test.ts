import { describe, expect, it } from 'vitest';
import { lintCapability } from '../capability-lint.js';
import { BUILTIN_RULES } from '../rules.js';
import { capabilityRows } from '../plugin.js';

describe('BUILTIN_RULES', () => {
  it('every rule has a lint-clean capability clause', () => {
    for (const rule of BUILTIN_RULES) {
      expect(lintCapability(rule.capability), rule.id).toEqual([]);
    }
  });

  it('rule ids are unique', () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a narrow rule never sits behind a broad rule for the same tool', () => {
    const seenBroad = new Set<string>();
    for (const rule of BUILTIN_RULES) {
      if (rule.match.when === undefined) {
        seenBroad.add(rule.match.tool);
      } else {
        expect(seenBroad.has(rule.match.tool), `${rule.id} is unreachable`).toBe(false);
      }
    }
  });

  it('no two broad rules share a tool — the second would be dead', () => {
    const broad = BUILTIN_RULES.filter((r) => r.match.when === undefined).map(
      (r) => r.match.tool,
    );
    expect(new Set(broad).size).toBe(broad.length);
  });

  it('contains at least one hold rule — AW-4 cannot be tested without one', () => {
    expect(BUILTIN_RULES.some((r) => r.verdict === 'hold')).toBe(true);
  });

  it('holds request_capability, the one hold tool that is always in the catalog', () => {
    // @ax/skill-broker is pushed unconditionally into the k8s preset, so this
    // is the rule AW-4's canary can rely on firing. The other two hold rules
    // are behind AX_ALLOW_USER_INSTALLED_SKILLS and are inert by default.
    const rule = BUILTIN_RULES.find((r) => r.match.tool === 'request_capability');
    expect(rule).toBeDefined();
    expect(rule!.verdict).toBe('hold');
  });

  it('marks the catalog-fact allows as catalog, never as deliberated rules', () => {
    // AW-1 §3.3: today's `allow` rows assert only "this tool is reachable and
    // no rule gates it". Filing one as `provenance: 'rule'` would tell a human
    // we deliberated a permission we did not.
    //
    // Note what this does NOT assert: that `allow` implies `catalog`. A
    // genuinely reviewed allow is legitimate and is the design's own §4.3.2
    // example ("Can reply to scheduling requests — on its own"). The invariant
    // is one-directional: the seven catalog facts below must stay `catalog`.
    const CATALOG_FACTS = new Set([
      'web.search',
      'web.extract',
      'memory.search',
      'memory.read-section',
      'memory.note',
      'skills.search-catalog',
      'artifacts.publish',
    ]);
    for (const rule of BUILTIN_RULES) {
      if (CATALOG_FACTS.has(rule.id)) {
        expect(rule.provenance, rule.id).toBe('catalog');
      }
      // Every rule declares provenance explicitly. The type defaults it to
      // 'rule' when omitted, and a silent default on a claim about how much
      // review a permission got is not a default worth having.
      expect(rule.provenance, rule.id).toBeDefined();
    }
  });

  it('declares the spend on exactly the two tools that bill an API call', () => {
    // @ax/web-tools implements both by making a billed Anthropic Messages call
    // per invocation. Nothing else in the table costs money: the memory tools,
    // the sandbox six and the catalog reads are all local, and the three holds
    // are consent flows. If a third tool starts spending, it belongs here — and
    // if one of these two stops, this fails rather than leaving a stale claim
    // that the agent's web search costs money when it no longer does.
    const spending = BUILTIN_RULES.filter((r) => r.effect === 'spends').map((r) => r.id);
    expect(spending.sort()).toEqual(['web.extract', 'web.search']);
  });

  it('marks nothing outward yet — the enforcement exists before the case does', () => {
    // Not an aspiration: TASK-263 shipped `effect: 'outward'` and its lint
    // BEFORE any outward tool exists, precisely so the first one cannot be
    // added as a quiet `allow`. When one arrives this test is the prompt to
    // check the rail and the undo window (`irreversible`) handle it, the same
    // way the irreversible test below is a tripwire rather than a preference.
    //
    // TASK-329 ADDED A THIRD THING TO CHECK when that day comes: the rail's
    // authored `outward` copy in channel-web's `permission-frames.ts` spells
    // out only the "a third party sees it" half of what `outward` means, not
    // the "cannot be taken back" half. That file carries the reasoning; this
    // is the test that sends you to it.
    //
    // DELIBERATELY STRICTER THAN THE LINT, which permits `outward` + hold/deny.
    // A correctly-held outward rule will red this test even though the shipped
    // enforcement is happy — that is the intent: the first one should stop and
    // make someone look, not slide in green.
    //
    // This also subsumes the table-wide `lintRuleEffect` loop an earlier draft
    // had beside it: if nothing is `outward`, "no outward rule is allowed" is
    // trivially implied, and two tests asserting one fact is how a reader comes
    // to believe there are two guards. `lintRuleEffect` itself is proven by
    // fixtures in capability-lint.test.ts, and enforced in CI by
    // scripts/lint-capabilities.ts.
    for (const rule of BUILTIN_RULES) {
      expect(rule.effect, rule.id).not.toBe('outward');
    }
  });

  it('marks nothing irreversible — every seeded approval can be taken back', () => {
    // A guard, not a preference: AW-5 offers a 10-second undo window unless a
    // rule opts out, and offering undo on something irreversible is a claim
    // the system cannot honour (design H1). If a rule here starts setting
    // `irreversible: true`, this test is the prompt to check AW-5 honours it.
    for (const rule of BUILTIN_RULES) {
      expect(rule.irreversible, rule.id).toBeUndefined();
    }
  });

  it('the disabled-builtin denies name exactly the four SDK builtins we disable', () => {
    // This pins the four names in place so a change to the rail's deny rows is
    // never a silent one-line diff. It is NOT a drift guard against the runners:
    // it compares the table against a literal in this same file, so it cannot
    // notice a runner's list moving underneath it. That guard is a separate test
    // that reads both runners' sources —
    // `scripts/__tests__/disabled-builtin-rail-drift.test.js` (TASK-245), which
    // CI runs unconditionally via `pnpm test:scripts`. If it fails, the rail has
    // fallen behind a runner and BOTH lists move together.
    const denied = BUILTIN_RULES.filter((r) => r.id.startsWith('builtins.')).map(
      (r) => r.match.tool,
    );
    expect([...denied].sort()).toEqual(
      ['AskUserQuestion', 'Task', 'WebFetch', 'WebSearch'].sort(),
    );
    for (const rule of BUILTIN_RULES) {
      if (rule.id.startsWith('builtins.')) expect(rule.verdict).toBe('deny');
    }
  });

  it('TASK-329: the two spending rules reach the rail rows as effect: spends', () => {
    // The card's literal complaint ("the rail says 'search the web' without
    // saying it costs money") asserted end-to-end INSIDE the plugin: build the
    // real rail rows off the real built-in table, the same way
    // `tool-policy:list-capabilities` does, and check the two known-spending
    // rules carry the disclosure a caller could render. `plugin.test.ts`
    // proves the mechanism (`indexRules()` copies `effect`) with tiny
    // fixtures; this proves it fires for the actual rules that motivated the
    // card, via `source`, which is how a caller matches a row back to a rule.
    const rows = capabilityRows(BUILTIN_RULES);
    const bySource = new Map(rows.map((r) => [r.source, r]));
    expect(bySource.get('rule:web.search')?.effect).toBe('spends');
    expect(bySource.get('rule:web.extract')?.effect).toBe('spends');

    // And the negative: a catalog fact that costs nothing must NOT pick up a
    // stray effect key. This is what keeps the test about PROPAGATION rather
    // than "everything on the rail is spends" — if `indexRules()` ever set
    // `effect` unconditionally, this line would catch it even though the two
    // assertions above would still pass.
    const memorySearch = bySource.get('rule:memory.search');
    expect(memorySearch).toBeDefined();
    expect('effect' in memorySearch!).toBe(false);
  });

  it('TASK-329: no CONDITIONAL rule declares an effect — the rail cannot disclose one yet', () => {
    /*
      A TRIPWIRE for a gap that is real but not reachable today. Found in
      review; it is cheaper to fail here than to under-disclose on the rail.

      The rail emits two kinds of row. Described rows come from
      `tool-policy:list-capabilities` and now carry `effect`. But a tool named
      ONLY by `when`-predicated rules also gets a MECHANICAL BASE ROW, built
      by the caller from `evaluate`'s fall-through verdict — and `evaluate`
      answers `EvaluateResult`, which has no `effect` (deliberately: adding it
      is a second hook-surface change). So that base row hardcodes no effect
      and has no rule to read one from.

      Harmless while every effect-bearing rule is unconditional, which is why
      this is a guard and not a fix: `web.search` and `web.extract` are both
      unconditional, so they are fully described and never take the mechanical
      path. The day a CONDITIONAL rule declares `spends` or `outward`, its base
      row — the one covering every call the predicate misses — would render
      with no marker while the call still spends the money or acts outward.
      Understating reach is the one direction design H4 forbids.

      If you are here because this test just went red: you have added exactly
      that rule, and the fix is to carry `effect` on `EvaluateResult` (and
      through the caller's base-row builder) rather than to relax this
      assertion.

      IT EXECUTES ZERO ASSERTIONS TODAY, and that is stated rather than left for
      the next reader to discover. `BUILTIN_RULES` contains no `when`-predicated
      rules at all (`grep -c 'when:' rules.ts` → 0), so the `continue` skips
      every rule and the loop body never runs. Its green is therefore NOT
      evidence of active coverage — it is a guard armed for a rule shape that
      does not exist yet. Unlike the canary's key-list loop, this one cannot be
      made non-vacuous without planting a fake conditional rule in the shipping
      table, which would be worse: the table is the thing under test.
    */
    for (const rule of BUILTIN_RULES) {
      if (rule.match.when === undefined) continue;
      expect(rule.effect, rule.id).toBeUndefined();
    }
  });

  it('every rule names an agent subject — there is no other subject yet', () => {
    for (const rule of BUILTIN_RULES) {
      expect(rule.subject, rule.id).toBe('agent');
    }
  });
});
