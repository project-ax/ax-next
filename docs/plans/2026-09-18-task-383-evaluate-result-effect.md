# TASK-383 — `EvaluateResult` carries no effect, so a conditional rule's base row cannot disclose one

2026-09-18. Follows TASK-329 (#554) and TASK-330 (#574).

## What the card said, and what re-reading found

The card's premise holds: `EvaluateResult` (`packages/tool-policy/src/types.ts`) has
only `verdict` / `ruleId` / `capability` / `irreversible`, and the rail's mechanical
base row in `packages/channel-web/src/server/routes-workspace.ts` hardcodes
`effect: []`. Both the in-code comment at that site and TASK-329's tripwire in
`rules.test.ts` name the same fix: *carry `effect` onto `EvaluateResult` and read it
in the base-row builder.*

Two corrections to the card as filed.

**1. The type is a set now.** #574 (TASK-330) widened `PolicyRule.effect` and
`CapabilityRow.effect` to `ToolEffect[]`, and `web.extract` ships `['spends',
'outward']`. So this card's field is `ToolEffect[]`, not a single value — exactly the
re-scope the TASK-330 follow-up list called for.

**2. The obvious implementation does not actually fix the base row.** This is the
load-bearing finding. `fullyDescribedTools` excludes a tool only when *every* rule
naming it carries a `when` predicate. The base-row builder then asks
`tool-policy:evaluate` with `input: {}` — the one input no `PredicateSpec` can match.
So for precisely the tools that get a base row, **no rule matches**, `evaluate` returns
its fall-through, and "the matched rule's effect" is empty by construction. Carrying
the matched rule's set alone would ship a field that is `[]` at the one call site the
card exists to fix. The tripwire would still be honest and the disclosure would still
be silent.

## The design

`EvaluateResult.effect: ToolEffect[]` — **required**, `[]` meaning "the table declares
nothing about this call".

Its value:

- **A rule matched** → that rule's declared set (`[]` when it declared none). The rule
  that answered the verdict is the thing speaking, same as `ruleId` / `capability` /
  `irreversible`.
- **No rule matched** → the **union**, in table order, of the effects declared by every
  rule whose `match.tool` is this call's tool.

One principle, two branches: *never answer silence where the table has spoken about
this tool.* A predicate gates the **verdict**, not what the call does in the world — a
call that slips past `when: { field: 'url', equals: … }` still spends the money and
still hands the URL to its owner. Design H4 forbids understating reach; the union is
the non-understating answer, and it is scoped exactly to the gap:

| shape | fall-through union |
|---|---|
| tool with an unconditional rule | unreachable — an unconditional rule always matches |
| tool with no rules at all (MCP, unmapped) | `[]` — nothing to union |
| tool with only `when` rules, none matched | the `when` rules' effects — **the base-row case** |

So the union branch fires only where a rule exists but none spoke. It cannot mark a
benign `Bash` call outward on the strength of a `curl`-predicated sibling, because such
a tool also has a broad rule, which matches.

Precision about the blast radius, because an earlier draft of this paragraph said the
union answers "the base row and nothing else" and that is narrower than the behaviour:
the union also answers any *other* caller evaluating a real call that misses every
`when` predicate. Consequence-free today — `@ax/decisions` is the only other consumer
and it never reads `effect` — but the sentence to hold in mind is "a rule exists for
this tool and none of them spoke", not "the rail asked".

**Why `irreversible` does not get the same treatment.** Asked in review before it is
asked here. `irreversible` changes *behaviour*: AW-5 defers the replay of an approval
by the undo window. Claiming it off a rule that did not answer would alter approval
timing on the strength of a rule that said nothing about this call. `effect` changes
*nothing* — it is disclosure only. Different risk, different default.

**Why required rather than optional.** `EvaluateResult` has no optional fields;
`irreversible: false` on a no-match sets the precedent that the answer is always
present and "nothing claimed" is the empty value. `ruleId: null` already carries "no
rule spoke", so `[]` needs no second spelling — and this repo has now spent two cards
on absent-vs-empty ambiguity in this exact field. Required also means the `returns`
schema rejects a non-conforming impl loudly instead of under-disclosing quietly.

Note the contrast with `CapabilityRow.effect`, which is *absent* when unclassified and
never present-and-empty. That row has no `ruleId`, so absence is the only way it can
say "there was never a rule". Both spellings are deliberate; both get a doc comment.

**The duck-typed mirror stays `unknown`.** `ToolPolicyEvaluateOutput` in
`routes-workspace.ts` cannot import the union (invariant 2), and #574's lesson is that
a `string`-typed mirror kept `tsc` green while the rail went quiet. It is typed
`unknown` and earns its type through the existing per-member allow-list filter
`toWireEffects`, which already drops unknown members, collapses duplicates, preserves
rule order and maps a non-array to `[]`.

## Not in scope, deliberately

The card's acceptance says the first `outward` rule must also set `irreversible: true`.
**#574 already answered that, the other way, on purpose** — `rules.test.ts` records the
decision in full: `irreversible` is a claim about approval *timing*, not
classification, and flipping it for `web.extract` was "left for a follow-up rather than
smuggled in here". That decision predates this card's acceptance text and is not mine
to reverse in a disclosure patch. Task 2 below turns it into an armed tripwire instead.
Reported as a follow-up.

TASK-384 (the `outward` copy is narrower than the type) is untouched.

## Tasks

### Task 1 — `@ax/tool-policy`: carry the effect (load-bearing)

`types.ts`, `evaluate.ts`, `plugin.ts`, `__tests__/evaluate.test.ts`.

1. `EvaluateResult.effect: ToolEffect[]`, documented per the design above.
2. `EvaluateResultSchema.effect: z.array(ToolEffectSchema)` — required. A `z.object`
   strips undeclared keys, so omitting the line is the silent-vanish failure mode.
3. `evaluate()` returns the matched rule's `effect ?? []`; the fall-through return
   returns the union over rules naming `call.name`, in table order, deduped.
   Still pure, total, no throw.
4. `plugin.ts`'s malformed-call deny path returns `effect: []`.
5. Tests, all non-vacuous — each must fail against the unfixed code:
   - matched unconditional rule → its set, in declared order;
   - matched conditional rule (real `when` fixture) → its set;
   - `when`-only tool, empty input → the union (the card's case);
   - two `when` rules on one tool with different effects → both, deduped, table order;
   - tool with no rules → `[]`;
   - matched rule declaring nothing → `[]`;
   - egress-relaxed verdict still carries the rule's effect (relaxation is verdict-only).

### Task 2 — `@ax/tool-policy`: rework TASK-329's tripwire deliberately

`__tests__/rules.test.ts`.

The `no CONDITIONAL rule declares an effect` tripwire guarded a gap this PR closes,
and it executes zero assertions today. Retire it *with its reasoning*, not by deletion:
rewrite the block to state that the gap is closed, name the tests that now cover it,
and replace the assertion with the **next uncovered case** — a rule declaring `outward`
that does not pair it with `irreversible: true`. `web.extract` is the documented
deferral, so it goes in a named allow-list of one; the test is non-vacuous today (it
loops over a real rule and evaluates a real assertion) and reds on the second outward
rule, which is the review moment the card's third acceptance bullet asks for.

### Task 3 — `@ax/tool-policy`: canary the wire

`__tests__/tool-policy.canary.test.ts`.

`list-capabilities` already has a key-shape assertion guarding `effect` against the
`z.object` strip. `evaluate` has none. Add one: call `tool-policy:evaluate` through the
real bus and assert `effect` arrives with its value intact. Mutant: delete the schema
line and it must red.

### Task 4 — `@ax/channel-web`: read it on the base row

`server/routes-workspace.ts`, `__tests__/server/routes-workspace-rail.test.ts`.

1. `ToolPolicyEvaluateOutput.effect?: unknown`, with the mirror-hazard reasoning.
2. Base row: `effect: toWireEffects(ev.effect)` in place of the hardcoded `[]`.
3. Rewrite the long comment at that site — the gap it describes is closed; it must not
   be widened again.
4. The fake `tool-policy:evaluate` in the rail test answers an effect.
5. The `TASK-329 … shows the base-row gap` test: its own comment says to update the
   second assertion to expect the declared set. Do that, and rename it for TASK-383.
6. A test that the mirror still refuses junk end to end: a fake answering
   `effect: 'spends'` (bare string) or `['spends', 'harmless']` lands as `[]` /
   `['spends']` on the base row.

No renderer *code* change: `PermissionLine` draws `disclosedEffects(...)` outside both
`!row.described` branches, and `disclosedEffects` already suppresses on `deny`.

But it does need a renderer **test**, and the plan missed this until the implementing
agent caught it. Every existing effect-render test builds a `described` row, because
before this patch an undescribed row with a non-empty effect was *unproducible* — the
hardcoded `[]` made "undescribed" and "unclassified" the same row. This patch makes it
shippable, so "the renderer already handles it" stopped being a tautology and became an
unasserted claim. `components/workspace/__tests__/AgentRail.test.tsx` gets one test that
reds if the badge map is ever gated on `row.described`.

## Boundary review (for the PR body)

- **Alternate impl:** the per-tenant DB-backed rule table already named in
  `EvaluateInput.agentId`'s doc — rules loaded from storage per `agentId` rather than
  from `rules.ts`. It answers `effect` the same way: read the rows, union the ones
  naming the tool when none match.
- **Payload field names that might leak:** none. `effect`'s members are `outward` and
  `spends` — statements about what a call does in the world, with no git/sqlite/k8s/
  transport vocabulary and nothing tied to the in-repo table being a TS constant.
- **Subscriber risk:** low, and it is the *widening* direction. Today's callers
  (`@ax/decisions`, `@ax/agent-aisdk-runner`'s policy wrap, `channel-web`'s rail) all
  duck-type the result; a new required field is additive for every one of them. The
  real risk is the one #574 taught: a consumer that duck-types `effect` as a string.
  Grepped — `channel-web` is the only consumer that reads it, and it types the mirror
  `unknown` and filters per member.
- **Wire surface:** `PermissionRow.effect` on the rail response, whose schema lives in
  `channel-web`'s own directory. Unchanged by this patch — it has been
  `CapabilityEffect[]` since #574. Only its *source* for mechanical rows changes.
