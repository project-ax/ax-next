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
    //
    // `web.extract` USED TO BE ON THIS LIST and is deliberately no longer
    // (TASK-330). Its permission is now a reviewed decision — held unless the
    // person has allowed that host — and `catalog` means precisely "no rule
    // gates it", which stopped being true the moment one did.
    const CATALOG_FACTS = new Set([
      'web.search',
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
    //
    // `.includes` and not `===` since TASK-330 made `effect` a SET: `web.extract`
    // declares `['spends', 'outward']`, and a test that still asked for equality
    // with the string would quietly answer "nothing spends money" — green, and
    // wrong in the understating direction.
    const spending = BUILTIN_RULES.filter((r) => r.effect?.includes('spends') === true).map(
      (r) => r.id,
    );
    expect(spending.sort()).toEqual(['web.extract', 'web.search']);
  });

  it('declares outward on exactly web.extract, and never allows an outward rule', () => {
    // THIS TEST USED TO READ "marks nothing outward yet", and it was a tripwire
    // armed for the first outward tool. TASK-330 is that tool, so the tripwire
    // fired and this is what it was fired at: the rule now DECLARES `outward`,
    // and the assertion moved from "nobody does" to "exactly this one does, and
    // it is not allowed".
    //
    // WHY IT IS NOT SIMPLY DELETED. The old version was also a prompt to check
    // three things when the day came, and the answers belong here rather than
    // in a commit message:
    //
    //   - THE RAIL. `web.extract`'s row now carries BOTH members and reads
    //     `conditional` (the verdict depends on whether the person has allowed
    //     that host). Pinned by the TASK-329 propagation test below and by
    //     channel-web's rail tests.
    //   - THE UNDO WINDOW. `irreversible` is still NOT set, and the test below
    //     still pins that. An outward call is USUALLY irreversible, and a page
    //     fetch genuinely cannot be unmade — but `irreversible` is specifically
    //     the claim that AW-5 must defer the replay by the undo window, which
    //     is a change to approval TIMING and not to classification. Left for a
    //     follow-up rather than smuggled in here.
    //   - THE COPY. `permission-frames.ts`' `outward` detail spells out only
    //     the "a third party sees it" half of what `outward` means. That half
    //     IS the true half for `web_extract`, so nothing is misstated today —
    //     but the copy is still narrower than the type, and TASK-384 owns
    //     broadening it.
    //
    // `.includes` and not `===`: `effect` is a SET, and after TASK-330 the
    // string comparison this test used to make is one an array silently passes.
    // That is precisely how a guard becomes a check that cannot fail while
    // still wearing the costume of one.
    const outward = BUILTIN_RULES.filter((r) => r.effect?.includes('outward') === true);
    expect(outward.map((r) => r.id)).toEqual(['web.extract']);

    // The lint's rule, asserted against the shipped table rather than against
    // fixtures. `capability-lint.test.ts` proves the function fires; this
    // proves the table obeys it, and it is NON-VACUOUS now that a member
    // exists — which is exactly what the old version could not claim.
    for (const rule of outward) {
      expect(rule.verdict, rule.id).not.toBe('allow');
    }
  });

  it('gates web.extract on the target host, with the effect and verdict that implies', () => {
    // The TASK-330 decision, pinned where it is enforced. Each line is a
    // separate way the decision could be quietly undone:
    const rule = BUILTIN_RULES.find((r) => r.id === 'web.extract');
    expect(rule).toBeDefined();
    // ...by dropping the contingency and going back to a flat allow;
    expect(rule!.egress).toEqual({ urlField: 'url' });
    // ...by holding without the disclosure that says why;
    expect(rule!.effect).toEqual(['spends', 'outward']);
    // ...or by relaxing the fall-through, which is the verdict for every host
    // nobody has allowed and is the only thing standing between a fresh
    // install and "any public URL the agent names".
    expect(rule!.verdict).toBe('hold');
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
    expect(bySource.get('rule:web.search')?.effect).toEqual(['spends']);
    // BOTH members reach the row, in the rule's order. Carrying only the
    // strictest one would stop telling anybody the call costs money; carrying
    // only the first would drop the outward disclosure, which is the direction
    // design H4 forbids.
    expect(bySource.get('rule:web.extract')?.effect).toEqual(['spends', 'outward']);

    // And the negative: a catalog fact that costs nothing must NOT pick up a
    // stray effect key. This is what keeps the test about PROPAGATION rather
    // than "everything on the rail is spends" — if `indexRules()` ever set
    // `effect` unconditionally, this line would catch it even though the two
    // assertions above would still pass.
    const memorySearch = bySource.get('rule:memory.search');
    expect(memorySearch).toBeDefined();
    expect('effect' in memorySearch!).toBe(false);
  });

  it('TASK-383: an outward rule pairs with irreversible: true — except the one deferral', () => {
    /*
      THIS SLOT USED TO HOLD "no CONDITIONAL rule declares an effect", TASK-329's
      tripwire for a gap that is now CLOSED, and it is reworked rather than
      deleted because the reasoning is worth more than the assertion was.

      THE GAP IT GUARDED. A tool named only by `when`-predicated rules gets a
      MECHANICAL BASE ROW, built by the caller from `evaluate`'s fall-through —
      and `EvaluateResult` carried no `effect`, so that row could not disclose
      one. TASK-383 carries it: a matched rule answers its own set, and a
      fall-through answers the UNION of every rule naming the tool, which is
      precisely the base-row case. Now covered by `evaluate.test.ts`'s
      "unions the declared effects when NO rule matched — the base-row case"
      and "dedupes the union and keeps table order", by
      `tool-policy.canary.test.ts`'s "unions a when-only tool ACROSS THE BUS",
      and end to end by channel-web's rail tests. The old assertion would now
      forbid the very rule shape the fix exists to serve.

      IT ALSO EXECUTED ZERO ASSERTIONS, which its own comment admitted: no
      builtin rule carries a `when`, so the loop body never ran. A green that
      proves nothing is worse than no test, because it reads like coverage in a
      diff. Its replacement runs against real rules today.

      WHAT THE NEW ASSERTION IS ARMED FOR: the SECOND outward rule. #574 decided
      deliberately that `web.extract` would NOT set `irreversible` — that flag
      is a claim about approval TIMING (AW-5 defers the replay by the undo
      window), not about classification, and flipping it was left for a
      follow-up rather than smuggled into a classification patch. That decision
      is one rule wide, and it is spelled here as an allow-list of one so the
      next `outward` rule cannot inherit it silently. An outward call is
      normally irreversible — you cannot unsend a message — and a rule that
      declares `outward` while offering a 10-second undo is promising something
      the system cannot honour (design H1). When this reds, the question is
      whether AW-5 can honour undo for THAT rule, not whether the allow-list
      has room for one more.
    */
    const IRREVERSIBLE_DEFERRED = new Set(['web.extract']);
    const outward = BUILTIN_RULES.filter((r) => r.effect?.includes('outward') === true);
    // NON-VACUITY, stated as an assertion rather than as a hope. The loop below
    // is the whole test, and it runs zero times the moment nothing declares
    // `outward` — the exact way its predecessor went quiet. The count is NOT
    // pinned here (the test above owns the exact list); this only insists the
    // loop has something to say.
    expect(outward.length, 'nothing declares outward — this test went vacuous').toBeGreaterThan(0);
    for (const rule of outward) {
      if (IRREVERSIBLE_DEFERRED.has(rule.id)) {
        // The deferral, pinned where somebody would trip over it. If this reds
        // because `web.extract` now sets the flag, that is the follow-up
        // landing: delete the id from the set rather than the assertion.
        expect(rule.irreversible, `${rule.id} is the documented deferral`).toBeUndefined();
        continue;
      }
      expect(rule.irreversible, `${rule.id} declares outward`).toBe(true);
    }
  });

  it('every rule names an agent subject — there is no other subject yet', () => {
    for (const rule of BUILTIN_RULES) {
      expect(rule.subject, rule.id).toBe('agent');
    }
  });
});
