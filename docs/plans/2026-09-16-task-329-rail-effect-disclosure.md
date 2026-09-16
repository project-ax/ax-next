# TASK-329 — the rail says "search the web" without saying it costs money

Follow-up to TASK-263, which added `PolicyRule.effect` (`'outward' | 'spends'`) and
deliberately did not touch rendering. The rail still renders only the capability
clause, so a person reading "What it may do alone" cannot tell which rows spend
their money.

## What TASK-263 actually landed (read, not assumed)

- `ToolEffect = 'outward' | 'spends'` in `packages/tool-policy/src/types.ts`, with
  a long doc comment. `spends` is a **money-only** claim and explicitly does NOT
  mean "safe" or "not outward".
- `outward` may not be `allow` — `lintRuleEffect` (`capability-lint.ts`) enforces
  it in the CI capability gate. **So an `outward` row is always `hold` or `deny`,
  never `allow`.** This is load-bearing for the render tests.
- `web.search` / `web.extract` carry `effect: 'spends'`, `verdict: 'allow'`,
  `provenance: 'catalog'`. No rule declares `outward` today.
- `effect` is on `PolicyRule` only. It is **not** on `CapabilityRow`, not on
  `EvaluateResult`, and nothing renders it.

## Out of scope (stated so it is not drifted into)

- **TASK-330 owns hold-vs-label for `web_extract`.** That card is in Needs Input
  for a human. This card labels; it does not change any verdict, does not touch
  `lintRuleEffect`, and does not reclassify `web.extract` as `outward`. The
  consequence is worth naming out loud: `web_extract` will render *only*
  "Costs money", disclosing the bill and not the fact that the URL's owner sees
  the request. That is the deferral, not a defect in the marker.
- `EvaluateResult.effect` / the approval card. `effect` is not on the evaluate
  surface, and putting it there is a second hook-surface change with its own
  reviewer (the approval copy already has `irreversible`). Follow-up.

## The mirror sites (the card asked for every one; this is the audit)

`CapabilityRow` is declared three times and rows are built at two places:

| # | File | Shape | Change |
|---|---|---|---|
| 1 | `packages/tool-policy/src/types.ts` | `CapabilityRow` + `CapabilityRowSchema` (zod `returns`) | add `effect?: ToolEffect`, declare it in the schema |
| 2 | `packages/tool-policy/src/plugin.ts` | `indexRules()` builds the row | copy `rule.effect` |
| 3 | `packages/channel-web/src/server/routes-workspace.ts` | `PolicyCapabilityRow` (duck-typed, I2) | add `effect?: string` and **validate** it |
| 4 | `packages/channel-web/src/server/routes-workspace.ts` | `toWirePermission()` + the catalog/MCP row push | normalise to `CapabilityEffect \| null` |
| 5 | `packages/channel-web/src/lib/workspace-types.ts` | `PermissionRow` | add `CapabilityEffect` union + `effect: CapabilityEffect \| null` |
| 6 | `packages/channel-web/src/components/workspace/__tests__/rail-fixture.ts` | test fixtures | `effect: null` default |

Negative audit, verified by grep: `packages/ipc-protocol/src/actions.ts` contains
the word "provenance" but no rail shape; there is **no** fourth copy and **no**
client-side zod parse of the rail response (`workspace-rail.ts` is a fetch hook).
`GrantRow` is a different type and gets no `effect`.

## Decisions

### D1 — `effect` is VALIDATED at the BFF, not copied

`toWirePermission` is the trust boundary: it duck-types a hook answer and fences
every string that survives. The renderer switches on `effect` to choose authored
copy, so an impl answering `effect: 'harmless'` must land as `null` (no claim),
not as an unrendered-but-present value. Allow-list of exactly two values.

### D2 — `spends` and `outward` render DIFFERENTLY

The card asks. TASK-263 split the marker precisely because the risks differ, and
collapsing them in the renderer would throw away the distinction the type exists
to preserve. Two entries in one authored table; no shared phrasing.

### D3 — the marker is SUPPRESSED on `deny` rows

A `deny` row says "Cannot X". There is no spend and no outward action to
disclose, because the call does not happen. "Cannot pay an invoice — Costs money"
reads to a scanner as a row where the agent spends money, which is a false
positive on a surface whose whole premise is that the sentence is true.
Suppressing it cannot understate reach (design H4's one forbidden direction) —
the row asserts zero reach, so there is nothing to understate. The **data** still
carries the declared effect faithfully; only the renderer declines to draw it.
Independently confirmed by the `ux-design` pass.

### D4 — the copy lives in `permission-frames.ts`, not in JSX

Same argument the file's own header makes for the verdict frames: the claim is
authored, and a claim assembled by whoever happens to be rendering is one that
can be assembled wrong. `permission-frames.ts` is the pure, React-free module a
second renderer would need. `effectDisclosure(effect)` returns authored parts.

### D5 — `Popover`, not `Tooltip`

`Tooltip` is installed but needs a `TooltipProvider` the rail does not have, and
it is hover-only — unreliable on touch, auto-dismissing, awkward for AT.
`PermissionLine` already puts its other explanatory affordance
(`TheirDescription`) behind a `Popover`, deliberately, for that reason. A
cost/consent disclosure a person cannot open on a phone is not a disclosure.
The `ux-design` pass raised this as its one implementation caveat and landed the
same way.

### D6 — the trigger is a real `<button>` wearing `badgeVariants`

Invariant 6 wants the installed primitive. `Badge` renders a `<div>`, and
`PermissionLine`'s content sits inside a `<span>` — a `div` there is invalid
nesting, and `PopoverTrigger asChild` over a `div` is not a keyboard-reachable
control. Applying the exported `badgeVariants` to a `<button>` is shadcn's own
documented escape hatch (their docs do it for `<a>`), keeps the design language,
and yields a real button. `variant="outline"` and muted foreground — explicitly
NOT `destructive`: a red badge would out-shout the verdict glyph, which is the
more important claim, and `spends` is a cost, not a danger. Hierarchy stays
glyph > badge > `source` id.

### D7 — authored copy (voice: direct, no jokes — it is a cost/consent disclosure)

| effect | badge | popover body |
|---|---|---|
| `spends` | `Costs money` | "Every time the agent does this, it makes a paid request on this AX deployment's account — so it costs money on each use, not just the first. Whoever set up this deployment pays the bill; we can't tell you the amount from here." |
| `outward` | `Affects the outside world` | "This does something out in the world beyond AX — like sending a message, posting where others can see it, or making a payment. Other people see the result, not just the agent." |

`Costs money` beats `Paid per use` because "paid" nudges toward "*I* am paying",
which the body then has to walk back; the badge stays neutral on who pays and the
body says so honestly. `Affects the outside world` beats `Others can see it`
because the latter misses "a payment made" — understating an outward action is
the wrong direction to be wrong in here. Neither body claims irreversibility;
that is `irreversible`'s separate job and its own UI.

## Tasks

### T1 — `@ax/tool-policy` carries `effect` on the rail row
Load-bearing: without it the field cannot leave the plugin.

- `types.ts`: `CapabilityRow.effect?: ToolEffect | undefined`, with a doc note
  that omitted means UNCLASSIFIED (not harmless) and that the row's effect is a
  DISCLOSURE, not a gate — the verdict is the gate.
- `types.ts`: `ToolEffectSchema = z.enum(['outward','spends'])`; add
  `effect: ToolEffectSchema.optional()` to `CapabilityRowSchema`. **A `z.object`
  strips undeclared keys**, so without this line the field vanishes silently on
  the way out of the bus.
- `plugin.ts` `indexRules()`: set the key only when the rule declares one
  (`...(rule.effect !== undefined && { effect: rule.effect })`), matching how
  `theirDescription` / `mechanicalLabel` are left absent rather than
  `undefined`, and keeping `exactOptionalPropertyTypes` happy.
- Tests (`plugin.test.ts`): a rule declaring `spends` produces a row carrying it;
  a rule declaring nothing produces a row with **no `effect` key** (assert
  `'effect' in row === false` — `toBeUndefined()` cannot tell an absent key from
  a present-and-undefined one); the existing "never exposes the tool it filtered
  on" key-shape assertion extended with a case that DOES declare an effect.
- Test: the declared effect survives `CapabilityRowSchema.parse` — through the
  real schema, so the test reddens if the schema line is removed.
- Test (`rules.test.ts`): `BUILTIN_RULES`' two `spends` rows arrive on the rail
  rows as `spends`. The card's literal complaint, asserted inside the plugin.

### T2 — the BFF validates it onto the wire row
Load-bearing: the renderer cannot see what the BFF does not forward.

- `routes-workspace.ts`: `PolicyCapabilityRow.effect?: string` (duck-typed —
  this is an unvalidated hook answer, so it is typed as the wide thing).
- `toWirePermission()`: `effect: row.effect === 'outward' || row.effect === 'spends' ? row.effect : null`,
  with a comment saying why an allow-list rather than a cast (D1). Survives the
  clause-fence demotion for the same reason `conditional` does — losing OUR
  SENTENCE does not unspend the money.
- The catalog/MCP row push: `effect: null`. A third-party tool we cannot describe
  is also one whose effect nobody has classified; `null` is the honest answer and
  the existing trust line already says we cannot tell them what it does.
- `workspace-types.ts`: `CapabilityEffect` mirrored (invariant 2 — mirror, never
  import) + `PermissionRow.effect: CapabilityEffect | null`, normalised to `null`
  like the other optionals so the renderer never sorts `undefined` from
  "not applicable".
- `rail-fixture.ts`: `effect: null` in `describedRow` and `mcpRow`.
- Tests (`routes-workspace-rail.test.ts`, `rail projections`): a declared
  `spends` reaches the wire row; an **unrecognised** `effect` lands as `null`
  (reddens against a plain copy-through, so it is not vacuous); an MCP row is
  `null`; a described row that DEMOTES (clause fences to nothing) keeps its
  effect.

### T3 — render the disclosure
Load-bearing: this is the card.

- `permission-frames.ts`: `effectDisclosure(effect: CapabilityEffect)` →
  `{ label, srLabel, detail }`, one authored entry per member, `Record`-typed so
  adding a member is a compile error (the review moment, same as `FRAMES`).
- `bits.tsx` `PermissionLine`: render the marker when
  `row.effect !== null && row.verdict !== 'deny'` (D3), as a `<button>` carrying
  `badgeVariants({ variant: 'outline' })` inside a `Popover`, in the DOM after
  the frame suffix and before the source id so the row reads as one sentence.
  The badge is a claim, so it is in the a11y tree — `aria-label` carries the
  standalone clause, never `aria-hidden`.
- Tests (`AgentRail.test.tsx`): `spends` marker on an `allow` row; `outward`
  marker on a `hold` row (the first outward row renders with no further work —
  the card asks for this, and the lint means it can never be `allow`); **no**
  marker on a `deny` row that declares one; the popover body opens and names the
  per-use cost; the two effects do NOT render the same string.

## YAGNI audit

| Task | Load-bearing at MVP? |
|---|---|
| T1 | Yes — the field cannot leave the plugin without it. |
| T2 | Yes — nothing renders what the BFF drops. |
| T3 | Yes — this is the card. |
| `effect` on `EvaluateResult` / approval card | **Cut.** Different hook surface, different reviewer, no card asks for it. Handoff follow-up. |
| Array-valued `effect` (a tool that is both) | **Cut.** `types.ts` already says to do that when a SECOND tool needs both; one does not make an array. |

## Boundary review

The only hook surface touched is `tool-policy:list-capabilities`' **return**
shape (`CapabilityRow`), by one optional field.

- **Alternate impl this hook could have:** the per-tenant DB-backed rule table
  named in AW-3's own boundary review (`EvaluateInput.agentId` exists for it). It
  would store an effect column and answer the same union.
- **Payload field names that might leak:** none. `effect`, `outward`, `spends`
  are claims about what a call does in the world — no git/sqlite/k8s/HTTP
  vocabulary, nothing that names a backend or a provider.
- **Subscriber risk:** the one subscriber is the BFF, and it **allow-lists** the
  value rather than switching on an open string, so an impl answering an effect
  we do not know renders as no claim rather than as a crash or a wrong claim.
  Adding a third member later is a renderer change (the `Record` makes it a
  compile error), not a silent mis-render.
- **Wire surface:** `CapabilityRowSchema` stays in
  `packages/tool-policy/src/types.ts`, this plugin's own directory. The HTTP
  shape stays in `channel-web`.

## Security note (invariant 5 / untrusted content)

`effect` crosses from a duck-typed hook answer into a security claim a human
reads. Handled: allow-listed at the boundary (D1), and never interpolated as
markup — by the time any copy is chosen the value is one of two authored
constants, and the copy comes from OUR table keyed by the validated value, so no
third-party string can reach the label. No new dependency, no new sandbox or IPC
surface, no filesystem or network reach, no process spawn. This PR grants nothing
and changes no verdict.

## Did a stale line generate this card?

No. The card was filed off TASK-263's deliberate scope note ("added
`PolicyRule.effect` but deliberately did not touch rendering"), which was and is
true. Nothing in `.claude/memory/` or the code overstated the rendering state.
One loose sentence found and left alone deliberately: `rules.ts`' "a metered read
with no third-party-visible effect" reads as a general claim about the class, and
the same comment corrects it explicitly for `web_extract` twenty lines below —
the correction is louder than the looseness, and rewording it here would churn
the file TASK-330 is about to revisit.
