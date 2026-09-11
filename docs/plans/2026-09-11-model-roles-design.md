# Model roles — one place to say which model does which job

**Status:** design, not yet decomposed into cards
**Date:** 2026-09-11
**Prompted by:** TASK-348 (#514) and TASK-349 (#515), both of which were symptoms
rather than causes — see "Why now".

## The problem

The system uses a model in eight distinct jobs. Each one picks its model a
different way, and two of them use string conventions that look identical and
mean opposite things.

| job | model comes from | convention |
|---|---|---|
| agent chat turn | `agents.model` row, allow-listed | `provider/model-id` **ref** |
| conversation title | `storage:get('settings:fast-model')` → preset → `DEFAULT_TITLE_MODEL` | ref |
| retrieval orchestrator | `memory.orchestratorModel` chart value → `DEFAULT_ORCHESTRATOR_MODEL` | **bare** |
| memory extraction (observer) | inherits the calling agent's `agent.model` | ref |
| map densify | plugin config | ref |
| rollup stage B | `DEFAULT_ROLLUP_STAGE_B_MODEL` | **bare** |
| skill safety scan | plugin config, hard-wired to `llm:call:anthropic` | bare |
| web tools | `DEFAULT_MODEL` in the plugin | **bare** |

Four configuration mechanisms — a storage key, a chart value, plugin config,
and "inherit whatever the agent uses" — plus compiled-in defaults underneath
each.

### The trap that makes this urgent

These two constants look like the same kind of thing. They are not:

```ts
// @ax/memory-strata — a BARE OpenRouter model id. `anthropic/` is part of the
// vendor slug. Routed by the hook name (`llm:call:openrouter`), not by parsing.
export const DEFAULT_ORCHESTRATOR_MODEL = 'anthropic/claude-haiku-4.5';

// @ax/conversation-titles — a REF. `anthropic/` is the provider and gets
// parsed off by `parseModelRef`, which then picks `llm:call:anthropic`.
export const DEFAULT_TITLE_MODEL = 'anthropic/claude-haiku-4-5-20251001';
```

Same shape, opposite meaning, and no type distinguishes them. Paste one into
the other's config and it is wrong in a way that produces a 404 at call time,
not a type error at build time — and a 404 in the orchestrator's case degrades
silently to BM25.

### Why now

Two cards in one day were both symptoms of having no single place to say this:

- **TASK-348** had to plumb a normalized `reasoningEffort` through
  `LlmCallInput` and two provider translate layers, per-call, because there was
  nowhere to express "this *job* wants minimal deliberation". The field is
  right — see "How reasoning composes" — but every caller now has to remember
  to set it.
- **TASK-349** found `x-ai/grok-4.1-fast` had been 404ing in the accuracy bench
  for four months: default model of a client factory, a `PRICING` key, and a
  cost-meter key. Nothing checked whether a configured model still exists.

Neither is fixed by being more careful. Both are fixed by having one registry
that can be validated.

## Goals

1. One place to see, and change, which model does which job.
2. Model **and reasoning level** chosen together, provider-agnostically, because
   they are chosen together for a job.
3. Per-agent override where that makes sense — and explicitly *not* where it
   does not.
4. A configured model that no longer exists fails **at boot, loudly**, not at
   call time, silently.

## Non-goals

- Per-user model selection. Credentials are per-user; model policy is
  operator-level. No use case yet.
- Replacing `parseModelRef`, `llm:call:<provider>`, or the allow-list in
  `@ax/agents`. This layers on all three.
- Changing `LlmCallInput`. The mechanism shipped in TASK-348 is right as-is.
- A model *router* (pick a model per request by content/cost). Different
  problem, much bigger, not this.

## Design

### Roles are named for the job, not the tier

`settings:fast-model` is the existing antipattern and the first thing to
migrate. "Fast" is a claim about a moving frontier — today's fast model is last
year's frontier model — so a tier name goes stale while the config it labels
stays put. A job name does not.

| role | the job | agent-overridable |
|---|---|---|
| `chat-turn` | the agent's own conversational turns | yes — see Open question 1 |
| `title-generation` | name a conversation from its first turns | yes |
| `memory-extraction` | observer: turn transcript → candidate facts | yes |
| `memory-densify` | map: doc → one-line summary | yes |
| `memory-rollup` | rollup stage B naming | yes |
| `retrieval-planning` | `memory_search` orchestrator op list | yes |
| `web-research` | `web_search` / `web_extract` synthesis | yes |
| `safety-scan` | skill-manifest safety check | **NO** |

Eight job-named roles is not proliferation. The leverage comes from several
roles *defaulting* to the same model, not from forcing different jobs to share
a name.

### A role is (model, reasoning)

```ts
interface ModelRoleBinding {
  /** `provider/model-id` ref. Always a ref here — never a bare id. */
  model: string;
  /** Normalized ladder from @ax/core (TASK-348). Omit to take the model's default. */
  reasoningEffort?: ReasoningEffort;
}
```

**Refs only, at this layer.** The bare-vs-ref ambiguity above is resolved by
making the registry speak refs exclusively and doing the bare-id conversion at
the edge, where the hook name is already known. `resolveAllowedModels` in
`@ax/agents` already takes exactly this posture — `assertModelRefs` refuses to
boot on a bare id with a message naming the value, because "a bare id can never
be routed … an agent that selected it would fail every turn."

This is not a new pattern to introduce, it is an existing one to finish.
`@ax/memory-strata`'s observer path already does exactly the split proposed
here: `resolveAgent` parses the agent's ref into `{ provider, model }`,
`buildAgentLlmCall` turns `provider` into the hook name
(`llm:call:${agent.provider}`) and warns-and-degrades when no such provider is
registered, and the bare `model` is what reaches `LlmCallInput`. The registry
generalizes that from one caller to eight. The three roles still holding bare
ids in compiled-in defaults (`retrieval-planning`, `memory-rollup`,
`web-research`) are the ones that never got this treatment.

### Resolution is one function, and the chain is stated once

Most specific wins:

```
per-agent override        (only if the role is agentOverridable)
  ↓
runtime setting           (storage:*, admin UI — what settings:fast-model is today)
  ↓
operator config           (chart value / env, via the preset)
  ↓
role default              (the registry's own table)
  ↓
plugin compiled-in floor  (what each plugin ships with today)
```

Five layers is a lot, which is exactly why it needs to be written down once and
implemented once rather than re-derived per plugin. Today's eight paths already
have four of these layers in inconsistent combinations; this does not add
complexity so much as name the complexity that exists.

**The compiled-in floor stays.** A plugin must still work when the registry
plugin is not loaded — the CLI preset is the live case. `models:resolve-role`
is an *optional* call with a documented degradation, the same posture
`@ax/conversation-titles` already uses for `storage:get` (no storage service →
use the fallback, don't fail).

### The hook

```
models:resolve-role   (service)
  in:  { role: string; agentId?: string }
  out: { model: string; reasoningEffort?: ReasoningEffort; source: string }
```

`source` names which layer won, so an operator asking "why is this model being
used?" gets an answer without reading five config files. That field is cheap
now and is the thing people will actually want in a bug report.

Boundary-review answers belong in the implementing PR, but the short version:
the payload carries no backend vocabulary, the alternate impl is a static
config-file registry vs. a database-backed one with an admin UI, and the
subscriber risk is nil because it is a service hook with one resolver.

### Not every role is agent-overridable

`safety-scan` is the reason this flag exists on day one. Letting an agent point
its own skill-safety scan at a weaker model is a capability escalation wearing
configuration's clothes — invariant 5, and the kind of thing that is nearly
free to prevent now and needs a migration later.

There is precedent for exactly this asymmetry. `@ax/agents` deliberately makes
`allowedModels` operator-configurable while `SUPPORTED_RUNNERS` is not, and
says why: *"a model id is routed to a provider at runtime; a runner id must map
to a binary the host already has."* Same shape of reasoning, different axis —
here it is trust, not capability.

### Boot validation

Both providers already register `models:list-supported:<provider>`. At startup
the registry resolves every role, parses the ref, and checks the model id
against the owning provider's list. A miss refuses to boot with a message
naming the role, the model, and the provider.

This is the part that would have caught TASK-349 four months earlier, and it is
only possible because the models are in one table. Per-call validation cannot
do it — by then you are in a fallback path, and the orchestrator's fallback is
silent.

Caveat, stated honestly: this validates that a model *exists*, not that it
accepts a given reasoning level. Those differ per endpoint — TASK-348 measured
`reasoning:{effort:'none'}` returning 400 on two of four models, which is why
the `ReasoningEffort` ladder has no `'none'` rung. Level compatibility stays a
runtime concern.

### How reasoning composes with TASK-348

Nothing shipped in TASK-348 gets undone. `LlmCallInput.reasoningEffort` is the
**mechanism** — per-call, because the `llm:call:<provider>` hook is shared by
callers that want opposite things. A role is the right granularity for the
**policy**, because the role *is* the caller's identity. Roles fill in the
field; the field stays where it is.

This also dissolves an open follow-up from #514. "Do the other four
`LlmCallInput` callers want `'minimal'`?" becomes "what is the reasoning level
for the `safety-scan` role?" — answered once in config instead of four times in
code. Worth noting the concrete hazard that question was really about:
`safety-scan` caps output at **64 tokens** and `title-generation` at **32**, and
a model that reasons by default burned 250–580 reasoning tokens per call in the
TASK-348 benchmark. Point either role at such a model today and it does not slow
down, it returns nothing usable — a `degraded: true` safety scan, or a
permanently untitled conversation.

## Migration

One PR per role, and **each PR deletes the old path**. A registry that coexists
with the eight existing mechanisms is strictly worse than either alone — that is
invariant 4, and it is how a "migration" becomes permanent.

1. **Vocabulary + hook + resolver plugin**, with the role table and boot
   validation. No callers yet, which means this PR is half-wired on its own —
   so it lands *with* step 2.
2. **`retrieval-planning`** first. It is the freshest code, it has the tightest
   feedback loop, and it is the one role where a wrong answer is already known
   to be silent. Deletes `DEFAULT_ORCHESTRATOR_MODEL` and the
   `memory.orchestratorModel` chart plumbing.
3. **`title-generation`**, which retires `settings:fast-model` and is the one
   with an existing admin UI to re-point — the migration that proves the
   registry can carry a runtime-editable setting.
4. **`safety-scan`**, first non-overridable role; proves the flag.
5. The four remaining memory/web roles, one PR each.
6. **`chat-turn`** last, or never — see Open question 1.

## Open questions

1. **Does `chat-turn` belong in the registry at all?** `agents.model` is
   already the canonical, allow-listed, admin-UI-backed source of truth for it.
   Putting it in the registry too would be two places storing the same concept —
   invariant 4, precisely the thing this design invokes elsewhere. Current lean:
   the registry *defines* the role and delegates resolution to `@ax/agents`
   rather than storing a second copy. This is the biggest unresolved question
   and should be settled before step 1, not during step 6.
2. **Where does the registry live?** Not `@ax/core` — the kernel holds the
   vocabulary (`parseModelRef`, `ReasoningEffort`) but not runtime config or
   storage. A new `@ax/model-roles` plugin is the default answer; the case
   against is that it adds a plugin every preset must load for anything to
   resolve above the compiled-in floor.
3. **Does `memory-extraction` keep inheriting the agent's model?** Today it
   does, which is a quiet form of per-agent override that predates this design.
   Making it an explicit role with `agentOverridable: true` and a default of
   "inherit `chat-turn`" preserves the behaviour, but "inherit another role" is
   a feature the registry would otherwise not need.
4. **Is `reasoningEffort` per-role enough, or does it need per-role-per-model?**
   A level that is right for a reasoning model is a no-op on Anthropic, which
   does not reason unless asked. Probably fine — "minimal" degrading to "no
   change" is the intended semantics — but worth a second look when
   `retrieval-planning` migrates.

## What this does not fix

An operator can still choose a slow or bad model for a role. Roles make the
choice visible, validated, and changeable in one place; they do not make it
correct. The orchestrator's 5-second budget and its silent BM25 fallback are
unchanged by this design, and remain the sharpest edge in the system — see the
2026-09-11 addendum in
`docs/plans/2026-05-13-memory-strata-phase-3c-config-d-report.md` for what that
costs when the model is wrong.
