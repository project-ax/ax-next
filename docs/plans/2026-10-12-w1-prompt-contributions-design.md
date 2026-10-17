# W1: prompt contributions from several plugins (design)

**Status:** draft, revised after review 1 (2026-10-12). See §10 for the review log. **Owner:** Vinay.
**Work item:** W1 of the AX Work Model (`docs/plans/2026-10-11-ax-work-model-design.md`).
It unblocks W3 (projects), W6 (goals, `docs/plans/2026-10-09-agent-goals-design.md`)
and W13 (tasks), which each need to add a block to the agent's prompt.
**Code cited at:** `a730c4c6e` (unchanged at `c11b489e5`).

---

## 1. Why

Only one plugin can add to an agent's system prompt today.
`system-prompt:augment` is a service hook, and the bus allows one plugin per
service name (`registerService` throws `duplicate-service`,
`packages/core/src/hook-bus.ts:302`). `@ax/memory` holds it.

Projects, goals and tasks each need their own block. Without W1 they would have
to import memory (breaks invariant 2), or memory would have to learn about all
of them (breaks invariant 4). W1 lets any plugin add a block, while the
orchestrator decides the order and contains failures.

## 2. What exists today

- **One call, fresh spawn only.** The orchestrator calls `system-prompt:augment`
  once when it starts a new session (`packages/chat-orchestrator/src/orchestrator.ts:2693`).
  A turn routed into a live session reuses the prompt it started with.
  - It joins the bodies with a blank line into `agentConfig.systemPromptAugment`,
    and the `bootstrapSafe` ones into `agentConfig.systemPromptBootstrapAugment`
    (TASK-524).
  - If the call throws, it logs and the turn runs with no augment.
- **The output is already a list:** `{ contributions: [{ source, body, bootstrapSafe? }] }`
  (`orchestrator.ts:682`). The only limit is the single provider.
- **Memory fails closed when Rules can't be read.**
  - If `memory:rules:read` throws, the whole memory augment throws, and the turn
    runs with no injected memory at all (`packages/memory/src/augment.ts:579`).
  - "No Rules provider registered" is different: it's a configuration state, and
    the block renders without a Rules section.
  - Memory computes Rules and recall together under one 800-token cap. Rules
    never drop; recalled sections drop to fit (`augment.ts:213`, `:562`, `:740`).
- **Bus behavior that matters here:**
  - A result is checked only if the provider registered a `returns` schema
    (`hook-bus.ts:381`).
  - A service's timeout defaults to 120 s (`DEFAULT_SERVICE_TIMEOUT_MS`,
    `hook-bus.ts:55`), and a provider may set `Infinity` (`hook-bus.ts:117`).
  - Deadlines don't cancel a handler, and `callJoined` waits for every nested
    handler to settle (`hook-bus.ts:353`).
  - Routine runs call `agent:invoke` through `callJoined`
    (`packages/routines/src/fire.ts:282`).
- **Freshness.** `system-prompt:augment-changed { agentId }` bumps a per-agent
  generation, and live sessions of that agent restart at their next turn
  (TASK-612, `orchestrator.ts:1721`). Memory fires it when Rules change.
- **Downstream.** The runner prepends the joined string on top of the identity
  prompt (`packages/agent-runner-core/src/prompt-engine.ts`), and session stores
  persist it. None of that changes.
- **Precedent for finding a family of services by name prefix:**
  `credentials:login:*` (`packages/credentials/src/plugin.ts:1121`) and the
  freshness capture/check pairs (`packages/decisions/src/freshness.ts:390`).
- **A stale comment.** `augment.ts:813` says the single provider is what keeps
  `@ax/memory` and `@ax/memory-strata` from loading together. memory-strata has
  no source left (only `dist/`), so that reason is gone.

## 3. Design

### 3.1 Required and optional providers, found by prefix

Each plugin registers one service, and its name says which class of provider
it is:

| Service name | Class | May return | If it fails |
|---|---|---|---|
| `system-prompt:augment:required:<name>` | Required | `rules`, `context`, `recall` | The **whole augment is skipped** for this spawn: every provider, every section, normal and bootstrap. The turn runs with no augment. |
| `system-prompt:augment:optional:<name>` | Optional | `context`, `recall` only | Only this provider's blocks are dropped; the rest still land. |

- **Memory registers as required** (`system-prompt:augment:required:memory`),
  because it carries Rules.
- **Projects, goals and tasks register as optional.**
- **Why classes and not per-call checks:** when a provider fails, nothing comes
  back to say what it would have contained. The orchestrator therefore has to
  know in advance which providers carry the person's standing instructions. A
  failed required provider keeps today's fail-closed behavior (§2): context or
  recall without the Rules that govern them is the worst outcome. That holds for
  a project or goal block just as it does for recalled memory.
- **"Failed"** means any of: the call throws, the orchestrator's deadline passes
  (§3.4), or the output is invalid (§3.3).
- **Not failures:** a required provider that returns no `rules` (the person has
  none), and having no required provider registered at all (a preset without
  memory). In both cases the optional providers still land. This mirrors
  memory's own distinction between "no Rules provider" and "Rules provider threw".
- **Calls.** The orchestrator lists both prefixes with `bus.listServices()` and
  calls every provider in parallel. Each call runs in its own isolated step:
  call, deadline, validate. One provider's failure never touches another's
  processing. A service name with an unknown class segment is ignored and
  logged once.

Alternatives considered:

- **A `fire()` subscriber chain.** Rejected for the reason `augment.ts:804`
  already gives: `fire` swallows throws and runs without a clock. Each
  subscriber also returns the whole payload, so one plugin could rewrite or drop
  another plugin's block.
- **A registry plugin that others register into.** That adds a stateful plugin
  to do what `listServices()` already does.
- **One service per section** (`…:rules:memory`, `…:recall:memory`). Rejected:
  memory computes Rules and recall together under one cap, so it would have to
  read Rules twice and split its assembly.

The input stays empty. Providers read the context (`userId`, `agentId`,
`sessionId`, `conversationId`), as memory does today.

### 3.2 Sections set the order

A provider returns one body per section:
`{ rules?: string; brief?: string; context?: string; recall?: string }`
(`brief` was added after W3a; see §11).

| Section | What goes there | Today | Later | Bootstrap mode |
|---|---|---|---|---|
| `rules` | Text a person wrote that no agent can change (required providers only) | Memory's "Rules From Your User" | A tenant policy | Included |
| `brief` | What this session is for, built only from what people wrote plus the provider's fixed text (§11) | The project block (W3) | | Included |
| `context` | What this session is working on | (nothing) | Project instructions and memory index (W3), the goal (W6), open tasks (W13) | Left out |
| `recall` | Things remembered from earlier sessions | Memory's recalled sections | | Left out |

The orchestrator joins the bodies with a blank line:
- in section order: `rules`, `brief`, `context`, `recall`;
- within a section, by service name.

Empty bodies are skipped. The same inputs always produce the same bytes, which
keeps the model's prompt cache warm.

**The section replaces `bootstrapSafe`.** Only `rules` and `brief` bodies reach
bootstrap mode, and only required providers can produce `rules`. That's one
rule instead of a flag that has to agree with a section.

### 3.3 Validation runs inside each provider's step

The bus checks a provider's result only if it registered a `returns` schema, and
TypeScript types aren't checked at runtime. So the orchestrator validates every
resolved result itself, inside that provider's isolated step:

- **Schema.** A strict zod object (`SystemPromptAugmentOutputSchema`, exported
  from `@ax/core`), with optional string fields `rules`, `context` and `recall`
  and no other keys. `null`, a non-object, a non-string body, or an unknown key
  are all invalid.
- **Class rule.** An optional provider's result may not contain `rules`. If it
  does, the whole result is invalid; the orchestrator doesn't just strip the
  field.
- **Size.** Any single body over 32,000 characters makes the result invalid.
  That's about 8k tokens, ten times memory's whole cap, so one provider can't
  crowd out the conversation.
- **Invalid means failed.** Invalid output from a required provider skips the
  whole augment. From an optional provider, only that provider is dropped.

Each failure is logged once with the provider and the reason:
`system_prompt_contribution_failed { provider, class, reason: 'threw' | 'deadline' | 'invalid' | 'too_large' }`.
Skipping the whole augment is logged separately as
`system_prompt_augment_suppressed { provider }`.

Providers should also register the exported schema as their `returns`, so a
malformed result fails at the bus too. The orchestrator's check is the one that
counts, because a provider may leave `returns` off.

### 3.4 A finite deadline owned by the orchestrator

A provider's own `timeoutMs` can be `Infinity`, the bus default is 120 s, and
nothing limits `agent:invoke` as a whole. So the orchestrator puts its own
deadline around every provider call:

- **Default 15 s.** It's a config option on the orchestrator
  (`augmentDeadlineMs`), and the config check rejects anything that isn't a
  finite positive number, including `Infinity`.
  - Memory's normal latency is well under that, though we haven't measured it in
    production. Measure memory's p99 before tightening it.
  - 15 s is still far below the 120 s bus default that can block startup today.
- **Parallel.** All providers run at once, so the whole step waits at most one
  deadline.
- **On miss.** The provider counts as failed (`reason: 'deadline'`), and the
  timer is cleared and unref'd.
- **Known limit.** The deadline stops the wait, not the handler: bus deadlines
  never cancel an effect. Under a `callJoined` caller, such as a routine run
  (`routines/src/fire.ts:282`), a hung handler still holds that run's lifecycle
  lock until it settles. That's the bus's documented behavior
  (`hook-bus.ts:353`), and its stall diagnostics name the provider. The deadline
  unblocks session startup; it doesn't release the lock. Changing that would
  mean cancellable service handlers, a bus-wide change outside W1.

### 3.5 Changes

`system-prompt:augment-changed { agentId }` stays exactly as it is. Any provider
fires it when its content for an agent changes. For example, W3 fires it once
per member agent when a project's instructions change. The orchestrator's
generation logic doesn't change.

### 3.6 Trust rules for providers

These are checked in each provider's review, because the orchestrator can't
check who wrote a body:

- **`rules` is only for content a person wrote and no agent can write.** That's
  why only required providers may return it. It reaches bootstrap mode.
- **`brief` is only for what a session is for, built from text people wrote
  that no agent can change, plus the provider's own fixed text.** It also
  reaches bootstrap mode, which has no safety floor, so a provider that returns
  it states in its review who can write that text (§11).
- **Required is a strong commitment.** A required provider's outage removes the
  whole augment, so a plugin registers as required only if it carries `rules`.
  Projects, goals and tasks are optional.
- **`context` and `recall` can carry text written by agents or other people**
  (project memory files, synced sources, recalled facts). The provider frames
  that text as information, not instructions, and doesn't let it pass as another
  section. For example, a project memory file containing a
  "## Rules From Your User" heading must not read as Rules. W3, W6 and W13 each
  cover this in their security notes.

### 3.7 Not in W1

- **Which project or goal a session is for.** W3 adds that, and it must come
  from the host, never from the model, so providers can trust it. W1 neither
  adds nor blocks it.
- The project, goal and task blocks themselves.
- Any change to how the runner composes the prompt.
- Cancellable service handlers (§3.4).

## 4. Changes by package

- **`@ax/core`:**
  - export the two prefixes (`SYSTEM_PROMPT_AUGMENT_REQUIRED_PREFIX`,
    `SYSTEM_PROMPT_AUGMENT_OPTIONAL_PREFIX`);
  - export the output type and `SystemPromptAugmentOutputSchema`.

  Providers and the orchestrator share one definition, and plugins may import
  the kernel.
- **`@ax/chat-orchestrator`:**
  - replace the single call at `orchestrator.ts:2693` with discovery and
    per-provider isolated steps (call, deadline, validate);
  - apply the required-failure rule and section ordering;
  - add the `augmentDeadlineMs` config option;
  - update the manifest comment at `plugin.ts:123`.

  The hook family stays out of `calls`/`optionalCalls`, because its names are
  only known at runtime (the same as `credentials:login:*`), and boot doesn't
  require them.
- **`@ax/memory`:**
  - register `system-prompt:augment:required:memory` with `returns` set to the
    shared schema, instead of `system-prompt:augment`;
  - return `{ rules, recall }` from the existing `buildMemoryBlockSplit`
    (`rules` = its `rules`, `recall` = its `rest`);
  - update its manifest `registers`, and remove the stale memory-strata
    reasoning at `augment.ts:813`.

  Its internal fail-closed on a Rules read error stays: that throw now fails a
  required provider, which skips the whole augment.
- **Unchanged:** the runner, `ipc-protocol`, `sandbox-protocol` and the session
  stores. They carry the already-joined strings.

## 5. Compatibility

- **Memory-only prompts are byte-identical** in normal and bootstrap mode. A
  golden test pins this: today's output is Rules, a blank line, then recall, and
  the new section order produces exactly that.
- **Memory alone fails exactly as today.** If Rules can't be read, there's no
  augment at all.
- **The bare `system-prompt:augment` name disappears.** There are no consumers
  outside this repo, and tests that call it move to the new name.
- **Only tests read `source` and `bootstrapSafe`** besides the orchestrator and
  memory (`chat-orchestrator/src/__tests__/augment.test.ts:384` onward,
  `orchestrator.test.ts:7775`, `memory/src/__tests__/augment.test.ts:1586`).
  - The TASK-524 cases carry over: "only bootstrap-safe bodies reach bootstrap"
    becomes "only `rules` reaches bootstrap".
  - "A truthy non-boolean `bootstrapSafe` fails closed" becomes "an optional
    provider returning `rules` is invalid and dropped".

## 6. Tests

**Orchestrator: ordering and landing**
- A required and an optional provider both land, in section order, and the
  order doesn't depend on registration order.
- Bootstrap gets only `rules`.
- Zero providers is a no-op.
- A routed turn still makes no calls.
- `augment-changed` still restarts the session at its next turn.

**Orchestrator: review 1, finding 1 (Rules failure)**
- A required provider that **throws**, alongside an optional provider that
  succeeds, produces **no augment at all**: both strings empty, and
  `system_prompt_augment_suppressed` names the required provider.
- The same holds when the required provider misses the deadline or returns
  invalid output.
- A required provider that returns no `rules` is not a failure: the optional
  provider lands.
- No required provider registered: the optional provider lands.

**Orchestrator: review 1, finding 2 (validation)**
- Malformed results from an optional provider: `null`, `{ rules: … }`, a body of
  `null`, a number body, an unknown key, or an oversized body. Each is dropped
  with the right `reason`, and a valid optional provider registered beside it
  still lands.
- The same malformed results from a required provider skip the whole augment.

**Orchestrator: review 1, finding 3 (deadline)**
- A provider registered with `timeoutMs: Infinity` that never settles:
  - as optional, the session opens within `augmentDeadlineMs` and the other
    providers land;
  - as required, the session opens within `augmentDeadlineMs` with no augment.
- Fake timers make both deterministic.
- The config check rejects `augmentDeadlineMs` values of `Infinity`, `NaN`,
  `0` and negative numbers.

**Memory**
- The golden byte-for-byte check from §5.
- `rules` and `recall` are set correctly.
- A Rules read error still throws.

**Acceptance (invariant 3)**
- The `presets/memory` canary (`presets/memory/src/__tests__/canary.test.ts`)
  keeps passing, with Rules reaching the prompt through the new hook.
- `presets/k8s` preset tests boot with memory registered under the new name.

## 7. Boundary review

- **Alternate implementation:**
  - a tenant-policy plugin that adds org-wide `rules` as a required provider;
  - a personalization plugin that adds `context` as an optional one;
  - memory itself swapped for another memory plugin, with no orchestrator
    change.
- **Payload fields that might leak:** none (`rules`, `context`, `recall`). The
  `required`/`optional` class lives in the service name, not in a payload.
- **Subscriber risk:** none. These are services, not subscribers, and the
  `augment-changed` payload is unchanged.
- **Wire surface:** none. This is host-only, not an IPC action.

## 8. Security note (run `security-checklist` on the PR)

- **Sandbox escape:** no change. This only assembles prompt text on the host.
- **Prompt injection:** the risk grows as providers add text agents wrote.
  Mitigations:
  - person-written `rules` always come first;
  - a failed Rules provider removes everything rather than letting context run
    without Rules;
  - only required providers can produce `rules`, and only `rules` reach
    bootstrap mode;
  - providers must frame untrusted text (§3.6);
  - one provider can't alter another's block (§3.1);
  - results are validated and size-capped per provider (§3.3).
- **Availability:** a finite orchestrator deadline means a hung provider can't
  block session startup (§3.4).
- **Supply chain:** no new dependencies. zod is already in `@ax/core`.

## 9. Size

One PR:
- `@ax/core` types and schema;
- the orchestrator call site and config option;
- memory's registration;
- tests.

## 10. Review log

**Review 1 (2026-10-12)**, three findings, all accepted:

1. **[P1] Provider isolation could drop Rules while keeping other context.**
   Resolved by required and optional provider classes (§3.1). A failed required
   provider skips the whole augment, matching memory's existing fail-closed
   behavior.
2. **[P2] Failure isolation didn't cover malformed results.** Resolved by
   orchestrator-side validation inside each provider's isolated step: a strict
   schema, the class rule and the size limit (§3.3).
3. **[P2] A provider could disable the deadline that protects startup.**
   Resolved by a finite, orchestrator-owned `augmentDeadlineMs` (default 15 s)
   around every provider call (§3.4). The deadline doesn't release a
   `callJoined` lifecycle lock held by a hung handler; that's documented as a
   known limit.

---

## 11. After W3a: the `brief` section (2026-10-17)

**What went wrong.** The kind walk of W3a found that every agent still in its
first-run chat (`.ax/BOOTSTRAP.md` present) answered a project chat as if there
were no project. The project block was `context`, and bootstrap mode drops
`context`. All three agents the walk asked were still in their first-run chat,
so in practice a person's first project chats got no project at all, and
nothing said why.

**The change.** A fourth section, `brief`, between `rules` and `context`. Any
provider may return it, and it reaches bootstrap mode as well as normal mode.
`@ax/projects` returns its block as `brief`: the project's name and
description, quoted, plus fixed text about the folder. Only the projects
routes write those, for a person who can manage the project; no agent tool or
IPC action reaches `projects:update`.

**Trust.** Bootstrap mode has no safety floor, so `brief` is held to the same
bar as `rules`: text no agent can change. Two differences, both accepted:

- An optional provider can now put text into bootstrap mode. The orchestrator
  can't check who wrote a body (§3.6), so the bar is enforced in each
  provider's review, as it already is for `context`.
- Today the only person who can edit a project's description is someone who
  manages it, so it's their own words, like Rules. **W4 must revisit this:**
  once people share projects across owners, one person's description would
  reach another person's agent's first-run prompt. Listed in W3 §17 item 11.

Memory-only prompts are unchanged, byte for byte, in both modes.

