import { describe, expect, it } from 'vitest';
import { lintCapability } from '../capability-lint.js';
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
    // These four cannot be derived from `DISABLED_BUILTINS` (it lives in the
    // runner package, whose entrypoint is the runner binary — a cross-plugin
    // runtime import, invariant 2). This assertion is the drift guard the
    // derivation would have been: if the runner's disallow list changes, this
    // list has to change with it.
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
