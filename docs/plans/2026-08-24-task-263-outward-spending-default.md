# TASK-263 — "unguarded by default" vs. tools that spend money or send outward

## What the card assumed, and what is actually true

The card says *"No held tool in the catalog currently spends money or sends outward, so the
'unguarded by default' policy has never been exercised against the case it would be wrong
for... a policy question for future work, not a latent bug."*

Re-derived from the tree (2026-08-24), two corrections:

1. **A money-spending tool is already unguarded.** `web_search` / `web_extract`
   (`@ax/web-tools`) work by making **billed Anthropic Messages API calls** on the operator's
   key (`plugin.ts`, `DEFAULT_MODEL = 'claude-sonnet-4-6'`) and reach live web hosts. Both are
   `verdict: 'allow'`, `provenance: 'catalog'` — and `catalog` is explicitly documented as
   *"reachable and no rule gates it… NOT a reviewed policy decision"*. The card's sentence is
   true only under a narrow reading of "held tool" (= a tool with a `hold` verdict), which
   makes it nearly vacuous. The substantive claim — that the wrong-case is hypothetical — is
   false.

2. **The larger hole is the unmatched tool, not the marked one.** Only our two in-process MCP
   servers get their prefix stripped (`agent-claude-sdk-runner/src/tool-names.ts`). A
   third-party / connector-backed tool arrives at `evaluate()` as the full
   `mcp__<server>__<tool>` string, matches no rule, and falls through to **`allow`**. So
   wiring up a Gmail-style connector at runtime yields an unguarded `send_message` today —
   reachable by configuration, not future work.

Also worth stating: `evaluate()` receives only `{ name, input }`. It cannot see
`ToolDescriptor.executesIn`, connector metadata, or MCP annotations, so **any** classification
of "outward" has to be by name in `rules.ts` — there is no field on the descriptor to read
(TASK-242 is the adjacent gap).

## The decision

### The global no-match default stays `allow`.

Not because it is ideal, but because flipping it is **not implementable today**, and the
half-built version is worse than the status quo:

- There is **no durable per-tool "always allow"**. `@ax/host-grants` grants **egress hosts**
  (`host_grants_v1_grants`: `(owner_user_id, agent_id, host)`), not tools. `DecisionStatus` is
  per-decision (`pending|executed|approved-pending-agent|dismissed|stale|expired|failed`) —
  nothing carries a standing authorisation for *the next* call of the same tool.
- So `hold`-by-default for unmatched tools means **every call to every connector tool holds,
  forever, with no way to say yes once**. That does not make anyone safer: it makes connectors
  unusable and pushes an operator to turn the gate off, which loses the guard entirely.

The blocker is therefore a missing mechanism, not a missing decision. Named as a follow-up.

### What ships instead: an outward tool cannot be added as a silent `allow`.

`PolicyRule` gains an explicit `effect`, and the distinction is the load-bearing part:

| effect | meaning | may be `allow`? |
|---|---|---|
| `'outward'` | a third party sees it, or it cannot be taken back (send, post, pay) | **no — lint-enforced** |
| `'spends'` | costs money, but no third-party-visible side effect (a metered read) | yes, but must be *declared* |
| omitted | neither | yes |

`web_search` / `web_extract` are marked `'spends'`. **Their verdict does not change**, so
nothing about today's behaviour moves — the win is that the spend is now declared in the table
rather than implied by a tool name, and greppable.

The asymmetry is the point. Conflating the two would force a choice between "every web search
needs approval" (unusable) and "sends and payments are allowed by default" (indefensible).

## Tasks

### T1 — `effect` on the rule type
`ToolEffect = 'outward' | 'spends'`, `PolicyRule.effect?: ToolEffect`, exported. Document what
each means and why omitted ≠ safe.

### T2 — `lintRuleEffect` + the CI gate
`lintRuleEffect(rule): string[]` beside `lintCapability`, returning an error when
`effect === 'outward' && verdict === 'allow'`. Wire into
`packages/tool-policy/scripts/lint-capabilities.ts`, which is already a CI gate
(`.github/workflows/ci.yml:57`) and prints the offending rule id — the reason that script
exists rather than relying on the vitest diff.

**Non-vacuity is the whole risk here.** A test that loops `BUILTIN_RULES` asserting "no
outward rule is allow" passes trivially, because no rule is `outward` today — it would be a
check that cannot fail wearing the costume of a guard. So the linter is a pure function tested
against **fixtures** (outward+allow → error; outward+hold → clean; spends+allow → clean), and
the table loop is the secondary assertion.

### T3 — mark the two spending rules
`effect: 'spends'` on `web.search` / `web.extract`. Verdict and provenance unchanged.

Considered and rejected: flipping their `provenance` from `catalog` to `rule`. `catalog` means
"no rule *gates* it", which stays true — declaring the effect is a **disclosure**, not a gate.
The existing canary in `rules.test.ts` pinning those two as `catalog` stays as it is.

### T4 — state the residual gap where a reader will hit it
A comment at `evaluate()`'s fall-through saying plainly that an unmatched third-party MCP tool
gets `allow`, that this is the known hole, and what mechanism would have to exist to close it.
The current comment justifies the default ("an exception list over a system whose baseline
reach is already bounded…") without noting the case it does not cover.

## Out of scope (carded, not silently dropped)
- **Per-tool durable "always allow"** — the blocker for guarding unmatched tools.
- **Surfacing `effect` on the rail** — "search the web" could read "costs money"; that is
  channel-web rendering, not policy.
