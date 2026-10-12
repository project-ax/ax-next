# W1: prompt contributions from several plugins (design)

**Status:** draft for review, 2026-10-12. **Owner:** Vinay.
**Work item:** W1 of the AX Work Model (https://claude.ai/artifact/VKVaYGHsUujqm4ZAE7xmSe).
It unblocks W3 (projects), W6 (goals, `docs/plans/2026-10-09-agent-goals-design.md`)
and W13 (tasks), which each need to add a block to the agent's prompt.
**Code cited at:** `a730c4c6e`.

---

## 1. Why

Only one plugin can add to an agent's system prompt today.
`system-prompt:augment` is a service hook, and the bus allows one plugin per
service name (`registerService` throws `duplicate-service`,
`packages/core/src/hook-bus.ts:302`). `@ax/memory` holds it.

Projects, goals and tasks each need their own block. Without W1, either they
import memory (breaks invariant 2), or memory learns about all of them (breaks
invariant 4). W1 lets any plugin add a block, while the orchestrator decides the
order and contains failures.

## 2. What exists today

- **One call, fresh spawn only.** The orchestrator calls `system-prompt:augment`
  once when it starts a new session (`packages/chat-orchestrator/src/orchestrator.ts:2693`).
  A turn routed into a live session reuses the prompt it started with. It joins
  the bodies with a blank line into `agentConfig.systemPromptAugment`, and the
  `bootstrapSafe` ones into `agentConfig.systemPromptBootstrapAugment`
  (TASK-524). A throw is logged and the turn runs without the block.
- **The output is already a list:** `{ contributions: [{ source, body, bootstrapSafe? }] }`
  (`orchestrator.ts:682`). Only the single provider is the limit.
- **Memory's provider** returns two contributions: Rules (bootstrap-safe) and
  the recalled sections (`packages/memory/src/augment.ts:818`). It caps its own
  block at 800 tokens (`augment.ts:213`).
- **Freshness.** `system-prompt:augment-changed { agentId }` bumps a per-agent
  generation, and live sessions of that agent restart at their next turn
  (TASK-612, `orchestrator.ts:1721`). Memory fires it when Rules change.
- **Downstream.** The runner prepends the joined string on top of the identity
  prompt (`packages/agent-runner-core/src/prompt-engine.ts`). Session stores
  persist it. None of that changes.
- **Precedent for finding a family of services by name prefix:**
  `credentials:login:*` (`packages/credentials/src/plugin.ts:1121`) and the
  freshness capture/check pairs (`packages/decisions/src/freshness.ts:390`).
- **A stale comment.** `augment.ts:813` says the single provider is what keeps
  `@ax/memory` and `@ax/memory-strata` from loading together. memory-strata has
  no source left (only `dist/`), so that reason is gone.

## 3. Design

### 3.1 One service per plugin, found by prefix

Each plugin registers its own service named `system-prompt:augment:<name>`,
for example `system-prompt:augment:memory`. The orchestrator lists services
with that prefix (`bus.listServices()`), calls each with `bus.call` in parallel
(`Promise.allSettled`), and puts the results together (3.2).

Alternatives considered:

- **A `fire()` subscriber chain.** Rejected for the reason `augment.ts:804`
  already gives: `fire` swallows throws and runs without a clock. Worse, each
  subscriber returns the whole payload, so one plugin could rewrite or drop
  another plugin's block. With separate calls, each plugin returns only its
  own block, has its own timeout, and fails on its own.
- **A registry plugin that others register into.** That adds a stateful plugin
  just to do what `listServices()` already does.

The input stays empty. Providers read the context (`userId`, `agentId`,
`sessionId`, `conversationId`), as memory does today.

### 3.2 Sections set the order

Each contribution names one section from a closed set:

| Section | What goes there | Today | Later | In bootstrap mode |
|---|---|---|---|---|
| `rules` | Text a person wrote that no agent can change | Memory's "Rules From Your User" | A tenant policy | Included |
| `context` | What this session is working on | (nothing) | Project instructions and memory index (W3), the goal (W6), open tasks (W13) | Left out |
| `recall` | Things remembered from earlier sessions | Memory's recalled sections | | Left out |

The orchestrator joins sections in that order: `rules`, `context`, `recall`.
Within a section it orders by service name, then by each provider's own order.
The same inputs always produce the same bytes, which keeps the model's prompt
cache warm.

**The section replaces `bootstrapSafe`.** A contribution reaches bootstrap mode
if and only if its section is `rules`. One field instead of two that must
agree. A contribution with a missing or unknown section is dropped with a
warning, so a sloppy provider fails closed, the same posture as TASK-524's
strict `=== true`.

New contribution shape:
`{ section: 'rules' | 'context' | 'recall', body: string }`. `source` goes away:
the orchestrator knows which service each contribution came from and uses that
in logs.

### 3.3 Failure and size

- **Failure.** A provider that throws or times out is skipped and logged as
  `system_prompt_contribution_failed { provider }`. The others still land. This
  is today's degrade-and-continue behavior, applied per provider.
- **Timeouts** stay per provider: each one sets `timeoutMs` when it registers.
  Calls run in parallel, so the wait is the slowest provider, not the sum.
- **Size.** Each provider caps its own block, as memory does. As a backstop, the
  orchestrator drops any single contribution over 32,000 characters (about 8k
  tokens, ten times memory's cap) and logs
  `system_prompt_contribution_too_large { provider, chars }`. It drops rather
  than truncates, because half a block is worse than none.

### 3.4 Changes

`system-prompt:augment-changed { agentId }` stays exactly as it is. Any
provider fires it when its content for an agent changes. For example, W3 fires
it once per member agent when a project's instructions change. The
orchestrator's generation logic doesn't change.

### 3.5 Trust rules for providers

These are checked in each provider's review, because the orchestrator can't
check who wrote a body:

- Only `rules` reaches bootstrap mode. A provider may use `rules` only for
  content a person wrote and no agent can write.
- `context` and `recall` can carry text written by agents or by other people
  (project memory files, synced sources, recalled facts). The provider frames
  that text as information, not instructions, and doesn't let it pass as
  another section. For example, a project memory file that contains a
  "## Rules From Your User" heading must not read as Rules. W3, W6 and W13
  each cover this in their security notes.

### 3.6 Not in W1

- **Which project or goal a session is for.** W3 adds that, and it must come
  from the host, never from the model, so providers can trust it. W1 neither
  adds nor blocks it.
- The project, goal and task blocks themselves.
- Any change to how the runner composes the prompt.

## 4. Changes by package

- **`@ax/core`:** export `SYSTEM_PROMPT_AUGMENT_PREFIX`, the `PromptSection`
  union and the contribution and output types, so providers and the
  orchestrator share one definition. Plugins may import the kernel.
- **`@ax/chat-orchestrator`:** replace the single call at `orchestrator.ts:2693`
  with discovery, parallel calls, section ordering, the size backstop and
  per-provider warnings. Update the manifest comment at `plugin.ts:123`. The
  hook family stays out of `calls`/`optionalCalls`, because the names are only
  known at runtime (same as `credentials:login:*`). Boot doesn't require them.
- **`@ax/memory`:** register `system-prompt:augment:memory` instead of
  `system-prompt:augment`. Rules get `section: 'rules'` and recalled sections get
  `section: 'recall'`. Remove the stale memory-strata reasoning at
  `augment.ts:813`. Update its manifest `registers`.
- **Unchanged:** the runner, `ipc-protocol`, `sandbox-protocol` and the session
  stores. They carry the already-joined strings.

## 5. Compatibility

- **Memory-only prompts are byte-identical** in normal and bootstrap mode. A
  golden test pins this: today's output is Rules, a blank line, then recall,
  and the new section order produces exactly that.
- **The bare `system-prompt:augment` name disappears.** There are no consumers
  outside this repo. Tests that call it move to the new name.
- **Only tests read `source` and `bootstrapSafe`** besides the orchestrator and
  memory (`chat-orchestrator/src/__tests__/augment.test.ts:384` onward,
  `orchestrator.test.ts:7775`, `memory/src/__tests__/augment.test.ts:1586`). The
  TASK-524 cases carry over in section terms. "A truthy non-boolean
  `bootstrapSafe` fails closed" becomes "an unknown or missing section is
  dropped", and "only bootstrap-safe bodies reach bootstrap" becomes "only
  `rules` reaches bootstrap".

## 6. Tests

- **Orchestrator:**
  - two providers both land in section order
  - the order doesn't depend on registration order
  - one provider throws or times out: the other still lands, and the warning
    names the failed one
  - an unknown or missing section is dropped
  - an oversized contribution is dropped
  - bootstrap gets only `rules`
  - zero providers is a no-op
  - a routed turn still makes no calls
  - `augment-changed` still restarts the session at its next turn
- **Memory:** the golden byte-for-byte check above, and sections set correctly
  for Rules and recall.
- **Acceptance (invariant 3):** the `presets/memory` canary
  (`presets/memory/src/__tests__/canary.test.ts`) keeps passing, with Rules
  reaching the prompt through the new hook. `presets/k8s` preset tests boot
  with memory registered under the new name.

## 7. Boundary review

- **Alternate implementation:** a tenant-policy plugin that adds org-wide
  `rules`, or a personalization plugin that adds `context`. Memory itself could
  be swapped for another memory plugin with no orchestrator change.
- **Payload fields that might leak:** none (`section`, `body`).
- **Subscriber risk:** none. These are services, not subscribers, and the
  `augment-changed` payload is unchanged.
- **Wire surface:** none. This is host-only, not an IPC action.

## 8. Security note (run `security-checklist` on the PR)

- **Sandbox escape:** no change. This only assembles prompt text on the host.
- **Prompt injection:** the risk grows as providers add text agents wrote.
  Mitigations:
  - person-written `rules` always come first
  - only `rules` reach bootstrap mode
  - providers must frame untrusted text (3.5)
  - one provider can't alter another's block (3.1)
  - the size backstop (3.3)
- **Supply chain:** no new dependencies.

## 9. Size

One PR: `@ax/core` types, the orchestrator call site, memory's registration,
and tests.
