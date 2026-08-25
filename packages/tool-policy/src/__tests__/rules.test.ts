import { describe, expect, it } from 'vitest';
import { lintCapability, lintRuleEffect } from '../capability-lint.js';
import { BUILTIN_RULES } from '../rules.js';

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

  it('no rule in the table declares an outward effect it also allows', () => {
    // The table-wide half of the TASK-263 guard. Deliberately paired with the
    // fixture tests in capability-lint.test.ts, because this loop is VACUOUS on
    // its own: no rule is `outward` today, so it would pass unchanged if
    // `lintRuleEffect` returned [] for everything. The fixtures prove the
    // linter fires; this proves the shipped table is clean.
    for (const rule of BUILTIN_RULES) {
      expect(lintRuleEffect(rule), rule.id).toEqual([]);
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

  it('every rule names an agent subject — there is no other subject yet', () => {
    for (const rule of BUILTIN_RULES) {
      expect(rule.subject, rule.id).toBe('agent');
    }
  });
});
