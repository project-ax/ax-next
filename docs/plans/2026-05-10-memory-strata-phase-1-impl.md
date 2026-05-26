# `@ax/memory-strata` Phase 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the smallest useful slice of Strata memory: **Level 0 (hot-tier markdown files in the agent's workspace) + Level 1 (Observer that writes raw observations to `memory/inbox/` on `chat:end`).** No retrieval, no Consolidator, no `recent.md` regeneration, no vector index — those are Phase 2+. The agent reads memory through normal filesystem tools (no new IPC actions); the plugin only owns initialization, the Observer subscriber, and the storage location.

**Architecture:** Adds one plugin: `@ax/memory-strata`. Subscribes to `chat:end` (Observer) and `agent:created` / equivalent (initialize memory tree). Writes to a stable path under the agent's existing workspace (`/permanent/memory/`) — the agent already has filesystem tools, so no new hook surface or IPC action is needed for *reading* memory. The plugin's job in Phase 1 is purely lifecycle: seed the directory tree, run the Observer, persist observations to `inbox/`. Phase 2 adds Consolidator + retrieval; Phase 3 adds the eval harness and decides on vectors.

**Tech Stack:** TypeScript, pnpm monorepo, Node 22+, Kysely + sqlite/pg (only for plugin metadata, not memory content), gray-matter (or equivalent) for YAML frontmatter parsing, the agent's own workspace filesystem for the markdown files. Spec: `docs/plans/memory-strata-design.md`.

---

## Source of truth

- **Design spec:** `docs/plans/memory-strata-design.md` — architecture, file system layout, frontmatter schema, the four background processes. Phase 1 implements the Observer (process #1) and provides the on-disk substrate the others will use.
- **Project conventions:** `CLAUDE.md` — six invariants, half-wired-window policy, bug-fix policy, voice & tone for any user-facing strings.
- **Workspace contract:** `packages/workspace-protocol/src/types.ts` — how plugins write to per-agent workspace storage (memory writes happen through this, not direct fs).
- **Hook surface to subscribe to:** `chat:end` event (fired by `chat-orchestrator`, see `packages/chat-orchestrator/src/orchestrator.ts:406+`); `agent:created` or its equivalent for initialization (verify in Task 1.2 — this may need a new hook if none exists).
- **Memory:** `feedback_half_wired_window_pattern.md` (every new-plugin phase loads in CLI + k8s preset same PR), `feedback_yagni_check_in_plans.md` (audit each task for "load-bearing at MVP, or pure dead code?"), `feedback_no_oauth_credentials.md` (Observer-extracted facts about credentials must be vetoed; sensitive-content gate is part of this scope even though full Consolidator is not).

## Invariants (audit trail per project pattern)

These get checked off in the PR notes. Numbered for cross-reference in review.

- **I1 — Hook surface stays transport- and storage-agnostic.** Any new hook (e.g., for memory-strata to expose the Observer's output to other plugins) carries no SQLite vocabulary, no filesystem-path field names, no kysely shapes in payloads. Boundary review checklist applied per CLAUDE.md.
- **I2 — No cross-plugin imports.** `@ax/memory-strata` does NOT import from `@ax/agents`, `@ax/conversations`, `@ax/workspace-*`, `@ax/credentials`. All cross-plugin coordination is via the bus or via per-agent workspace files (which the workspace plugin already exposes).
- **I3 — No half-wired plugins.** Phase 1 PR loads `@ax/memory-strata` in BOTH the CLI preset (`packages/cli/src/main.ts`) and the k8s preset in the same PR. PR notes contain an explicit "half-wired window: CLOSED" line.
- **I4 — One source of truth per concept.** Memory content lives ONLY under the agent's workspace at `/permanent/memory/`. Plugin metadata (last-observation-timestamp, observer config) lives in plugin-owned tables prefixed `memory_strata_v1_*`. No reach into `agents`, `conversations`, or workspace internals.
- **I5 — Capabilities explicit and minimized.** The plugin manifest declares: `chat:end` subscription, write access to `<workspace>/permanent/memory/` only, no process spawn, no network egress beyond the LLM client it already has for the Observer call. Memory content is treated as untrusted (it crosses into the agent's context next turn) — sensitive-content patterns (credentials, API keys) are filtered before write.
- **I6 — Observer is async and bounded.** The `chat:end` handler returns immediately; observation extraction runs in the background with a hard timeout (default 30s). A late observation is dropped to inbox with a `late: true` marker rather than blocking the next turn.
- **I7 — Sensitive-content gate runs before any inbox write.** Observer output is regex-filtered for credential / API-key / token patterns before it lands in `inbox/`. Filtered content is dropped with a non-sensitive marker entry. A "known-sensitive" fixture (fake API key, fake token) is in the test suite to prove the gate doesn't regress.
- **I8 — Memory tree is per-agent and isolated.** No cross-agent memory leakage. Tested: two agents in the same workspace see disjoint `memory/` trees. (Workspace already enforces isolation; we just verify our path convention respects it.)
- **I9 — Phase 1 ships only Level 0 + Level 1.** Explicitly NO retrieval (FTS5, vector, RRF), NO Consolidator (inbox→docs merge, dedup, supersession), NO `recent.md` regeneration, NO eval harness. Each is its own future phase. Test: `grep -r "FTS5\|RRF\|vector" packages/memory-strata/src/` returns zero matches in Phase 1.

---

## Open decisions (resolve in Task 1.0)

These three decisions block scaffolding. Resolve them at the start of Phase 1 — preferably with a short `AskUserQuestion` if implementing autonomously.

### Decision A: Memory storage location

| Option | Pros | Cons |
|---|---|---|
| **A1: `<workspace>/permanent/memory/`** *(recommended)* | Reuses workspace's existing per-agent isolation; agent reads via existing filesystem tools; survives restart same as workspace; bundle-wire propagates it across replicas | Couples memory's path convention to workspace plugin's directory layout |
| A2: Dedicated plugin storage path (host-mounted, separate from workspace) | Decoupled from workspace; can survive workspace teardown | Need new IPC action to expose memory to agent; doubles the storage surface; more code |

**Recommendation: A1.** Reuses what's already there.

### Decision B: Observer model

| Option | Pros | Cons |
|---|---|---|
| **B1: Same model the agent uses** *(recommended for MVP)* | Zero new credential plumbing; consistent with agent's worldview | Cost: every chat:end triggers an LLM call at agent's model price |
| B2: A configurable separate, smaller model (e.g., haiku) for extraction | Cheaper at scale | Needs separate credential entry; complicates the credentials surface |

**Recommendation: B1 for Phase 1.** Add B2 as a configuration knob in Phase 2 once we have data on Observer cost.

### Decision C: Frontmatter library

| Option | Pros | Cons |
|---|---|---|
| **C1: `gray-matter`** *(recommended)* | Battle-tested, ~50K downloads/week, supports YAML cleanly | Pulls in `js-yaml` transitively |
| C2: Custom mini-parser | Zero deps, smaller bundle | Reinvents a solved problem; bug surface |

**Recommendation: C1.** No good reason to hand-roll.

---

## File structure

### New package

```
packages/memory-strata/
  package.json
  tsconfig.json
  src/
    index.ts                 — public re-exports (createMemoryStrataPlugin, types)
    plugin.ts                — Plugin factory, registers chat:end subscriber
    types.ts                 — Observation, MemoryFrontmatter, FilteredFact
    paths.ts                 — Path helpers: workspaceMemoryRoot(agentId), inboxPath, systemFiles
    bootstrap.ts             — Seeds memory/system/{agent,user,session}.md on first run
    observer.ts              — Extracts observations from chat-end transcripts
    sensitive-gate.ts        — Regex-filters credentials / PII before inbox write
    frontmatter.ts           — Wraps gray-matter; produces canonical Strata frontmatter
    migrations.ts            — memory_strata_v1_observer_runs (audit only)
    __tests__/
      bootstrap.test.ts      — seeds + idempotent
      observer.test.ts       — extracts known facts; hits 30s timeout cleanly
      sensitive-gate.test.ts — covers I7 (fake API key fixture)
      isolation.test.ts      — covers I8 (two agents, disjoint memory)
      ship-list.test.ts      — covers I9 (no FTS5 / RRF / vector strings in src)
```

### Modified packages

```
packages/cli/src/main.ts              — register @ax/memory-strata in CLI preset (I3)
packages/preset-k8s/src/main.ts       — register @ax/memory-strata in k8s preset (I3)
                                       (verify exact preset path; may be different name)
pnpm-workspace.yaml                   — add packages/memory-strata
packages/agents/src/store.ts          — IF agent.md needs to be seeded from agent.systemPrompt,
                                       this is read-only via bus (NO direct import; I2)
```

### Files NOT touched (deliberate)

- `packages/llm-anthropic/*` — Observer runs through whatever LLM client the agent already has
- `packages/agent-*` — runners read memory via filesystem; no new runner-side code
- `packages/workspace-*` — we use the workspace's existing surface
- `packages/conversations/*` — Observer reads transcripts from the `chat:end` payload, not from the conversations DB

---

## Phase 1 — `@ax/memory-strata` plugin

### Task 1.0 — Resolve open decisions

- [ ] **Step 1: Read `docs/plans/memory-strata-design.md` end-to-end** — especially the Document Format and "1. Observer" sections. The Phase 1 contract is exactly Level 0 + Level 1 from the Progressive Enhancement Path.
- [ ] **Step 2: Confirm Decisions A, B, C above** — If running autonomously, present them to the user via `AskUserQuestion`. If decisions deviate from recommendations, record the deviation as `D1`/`D2`/`D3` in PR notes.
- [ ] **Step 3: Confirm the agent-init hook name.** Search for `agent:created`, `agent:registered`, or equivalent in `packages/agents/src/plugin.ts`. If none exists, the bootstrap step runs at `chat:start` instead — record this as deviation `D4`.

### Task 1.1 — Scaffold the package

- [ ] **Step 1: Copy `package.json` shape from a recent simple plugin** — `@ax/audit-log` or `@ax/conversation-titles` are good templates. Set `name: @ax/memory-strata`, `version: 0.0.1`, dependencies: `@ax/core`, `gray-matter` (per Decision C).
- [ ] **Step 2: Copy `tsconfig.json` shape** from the same template; update the references list to match actual deps.
- [ ] **Step 3: Add to `pnpm-workspace.yaml`** if not glob-matched.
- [ ] **Step 4: `pnpm install` + `pnpm --filter @ax/memory-strata build`** — must pass before moving on.
- [ ] **Step 5: Commit:** `feat(memory-strata): scaffold package`

### Task 1.2 — Path conventions + bootstrap

- [ ] **Step 1: Write the failing bootstrap test** (`bootstrap.test.ts`). Asserts: given a fresh agent with no `memory/` directory, calling `bootstrap(agentId)` creates `memory/system/{agent,user,session}.md` with valid frontmatter (id, type, created, summary). Idempotent: second call is a no-op.
- [ ] **Step 2: Run the test, watch it fail** at "module not found".
- [ ] **Step 3: Implement `paths.ts`** — pure helpers, no I/O:
  - `workspaceMemoryRoot(agentId): string` — returns `/permanent/memory` (relative to agent workspace root per Decision A).
  - `systemFile(name: 'agent' | 'user' | 'session'): string`
  - `inboxFile(timestamp: Date): string` — `inbox/<ISO-8601>.md`
- [ ] **Step 4: Implement `bootstrap.ts`** — seeds initial files. `agent.md` body comes from the agent's `systemPrompt` (read via the bus, NOT via direct import — see I2). `user.md` is a stub with empty profile sections. `session.md` is a stub rolling-summary template. Each file gets canonical frontmatter (`type`, `id`, `created`, `confidence: 1.0`, `pinned: true`).
- [ ] **Step 5: Run bootstrap test, expect PASS.**
- [ ] **Step 6: Commit:** `feat(memory-strata): bootstrap memory tree on agent creation`

### Task 1.3 — Sensitive-content gate

- [ ] **Step 1: Write the failing sensitive-gate test** (`sensitive-gate.test.ts`). Fixtures: a fake Anthropic API key (`sk-ant-...`), a fake AWS access key (`AKIA...`), a fake JWT, an email address, a phone number. Assertion: `filter(text)` returns `{ kept: ..., rejected: [...] }` with all sensitive patterns in `rejected`. Bonus: a known-vulnerable fixture asserting we don't accidentally let `password=hunter2` through.
- [ ] **Step 2: Run test, watch it fail.**
- [ ] **Step 3: Implement `sensitive-gate.ts`** — regex-based for Phase 1. Patterns: `sk-ant-[A-Za-z0-9-_]{20,}`, `AKIA[A-Z0-9]{16}`, generic JWT (`eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`), email, US phone, "password=", "secret=". Document each pattern with a comment naming what it catches and a link to the relevant CWE if obvious.
- [ ] **Step 4: Run test, expect PASS.**
- [ ] **Step 5: Commit:** `feat(memory-strata): sensitive-content regex gate`

### Task 1.4 — Observer

- [ ] **Step 1: Write the failing observer test** (`observer.test.ts`). Mock LLM that returns a structured list of facts given a transcript. Input: a 4-message conversation containing two factual statements ("user prefers React", "project ships next Friday") and one piece of sensitive content (a fake API key). Assertions: (a) two observations land in `inbox/`, each with valid frontmatter (id, type, confidence, source_messages, created, valid_from); (b) the API-key observation does NOT land in inbox; (c) a 30s LLM-call timeout drops the observation cleanly with a `late: true` audit row, no inbox write.
- [ ] **Step 2: Run test, watch it fail.**
- [ ] **Step 3: Implement `observer.ts`:**
  - Subscribes to `chat:end` (registered in `plugin.ts`, Task 1.5).
  - Reads transcript from the `chat:end` payload (NOT the conversations DB — I2).
  - Calls the agent's LLM (per Decision B1) with a structured-extraction prompt: "Extract durable facts from this conversation. Return JSON: `[{ fact, subject, type: entity|preference|decision|episode, confidence: 0..1, supersedes?: id }]`."
  - For each candidate, runs `sensitive-gate.filter`. Rejected facts are logged but not written.
  - Surviving facts land in `inbox/<ISO>.md`, one file per fact, with full frontmatter per the design doc.
  - Hard 30s timeout via `AbortController`.
- [ ] **Step 4: Run observer test, expect PASS.**
- [ ] **Step 5: Commit:** `feat(memory-strata): Observer extracts facts to inbox/`

### Task 1.5 — Plugin factory + hook subscription

- [ ] **Step 1: Write the failing plugin test** (`plugin.test.ts` if not already present). Asserts: registering the plugin in a test bus, firing `chat:end`, observes that the Observer ran (mock the actual LLM call). Asserts the half-wired-window: the plugin's manifest declares only the capabilities it needs.
- [ ] **Step 2: Run test, watch it fail.**
- [ ] **Step 3: Implement `plugin.ts`:**
  - `createMemoryStrataPlugin(config)` returns a `Plugin` object.
  - On registration: subscribes to `chat:end` (Observer trigger) and the agent-init hook from Task 1.0 step 3 (bootstrap trigger).
  - Manifest declares: `chat:end` subscription, write to `<workspace>/permanent/memory/`, no process spawn, no network beyond LLM client.
- [ ] **Step 4: Run all memory-strata tests, expect PASS.**
- [ ] **Step 5: Commit:** `feat(memory-strata): plugin factory + chat:end subscriber`

### Task 1.6 — Wire into CLI + k8s preset (close the half-wired window)

- [ ] **Step 1: Register `@ax/memory-strata` in `packages/cli/src/main.ts`** alongside other plugins. Ensure ordering: it must register AFTER `@ax/agents` (so `agent:created` exists) and AFTER `@ax/chat-orchestrator` (so `chat:end` exists).
- [ ] **Step 2: Register `@ax/memory-strata` in the k8s preset** (`packages/preset-k8s/src/main.ts` or equivalent — verify exact path).
- [ ] **Step 3: Run `pnpm build && pnpm test`** at the workspace root. All tests pass.
- [ ] **Step 4: Manual smoke test against `kind` cluster** — run a chat through the CLI, verify `<workspace>/permanent/memory/system/agent.md` exists and `inbox/<ISO>.md` files are created on chat:end. Use the `k8s-acceptance-loop` skill if needed.
- [ ] **Step 5: Commit:** `feat(memory-strata): wire into CLI + k8s preset (close half-wired window)`

### Task 1.7 — Isolation + ship-list tests

- [ ] **Step 1: Write `isolation.test.ts`** (covers I8): two agents in the same workspace share no memory state. Spin two agents, run a chat against each, assert their `memory/` trees are disjoint and contain only their own observations.
- [ ] **Step 2: Write `ship-list.test.ts`** (covers I9): `grep` the package source for forbidden Phase 2 strings (`FTS5`, `RRF`, `Consolidator`, `Retriever`, `vector`, `hnswlib`, `embeddings`). Zero matches expected.
- [ ] **Step 3: Run both, expect PASS.**
- [ ] **Step 4: Commit:** `test(memory-strata): isolation + Phase 1 ship-list invariants`

### Task 1.8 — PR notes + close

- [ ] **Step 1: Run full suite:** `pnpm build && pnpm test && pnpm lint`. All green.
- [ ] **Step 2: Bug-fix policy check** — if any bug was caught during Phase 1 that an existing test should have caught, a regression test was added per CLAUDE.md §"Bug Fix Policy".
- [ ] **Step 3: Boundary review** — fill in the four-question boundary review per CLAUDE.md for any new hook signature added (likely none in Phase 1, but confirm).
- [ ] **Step 4: PR notes prep:**

```markdown
## Phase 1 — `@ax/memory-strata` (Level 0 + Level 1)

### What ships
- New plugin: `@ax/memory-strata`
- Hot-tier markdown files seeded on agent creation (`memory/system/{agent,user,session}.md`)
- Observer subscribes to `chat:end`, extracts facts to `memory/inbox/<ISO>.md`
- Sensitive-content regex gate vetoes credentials/PII before inbox write
- Wired into CLI + k8s preset

### What does NOT ship (Phase 2+)
- Consolidator (inbox → docs merge, dedup, supersession)
- Retriever (FTS5 + optional vector + RRF)
- `system/recent.md` regeneration
- Eval harness (LongMemEval-S, LoCoMo)
- Vector-vs-no-vector spike

### Invariants audit
- I1 (transport-agnostic hooks): N/A — no new hook signatures added
- I2 (no cross-plugin imports): VERIFIED — `grep "from '@ax/" packages/memory-strata/src/` returns only `@ax/core`
- I3 (no half-wired plugins): VERIFIED — registered in CLI + k8s preset same PR
- I4 (one source of truth): VERIFIED — memory content under `<workspace>/permanent/memory/` only
- I5 (capabilities minimized): VERIFIED — manifest declares only `chat:end`, write to memory path, agent's existing LLM client
- I6 (Observer async + bounded): VERIFIED by observer.test.ts timeout case
- I7 (sensitive-content gate): VERIFIED by sensitive-gate.test.ts
- I8 (per-agent isolation): VERIFIED by isolation.test.ts
- I9 (Phase 1 ship-list): VERIFIED by ship-list.test.ts

### Half-wired window: CLOSED in this PR

### Deviations from plan
[list any D1..Dn from open decisions]
```

- [ ] **Step 5: Open the PR.** Title: `feat: @ax/memory-strata Phase 1 (hot tier + Observer)`.

---

## What is explicitly NOT in Phase 1

These belong to later phases, listed here so a reader knows the scope is deliberately small:

| Future feature | Phase | Why not now |
|---|---|---|
| Consolidator (inbox → docs, dedup, supersession) | Phase 2 | Needs design choices that benefit from real inbox data first (cluster-by-subject heuristics, supersession rules) |
| Retriever (FTS5, optionally vector + RRF) | Phase 2 | The vector-vs-no-vector spike (Phase 3) needs to settle before we commit to dense retrieval |
| `system/recent.md` regeneration | Phase 2 | Requires the Consolidator to exist |
| Vector-vs-no-vector eval spike | Phase 3 | Needs LongMemEval-S harness in place |
| Curator-as-patch pipeline | Deferred | Re-trigger conditions documented in design doc §"Future: Curator-as-Patch Pipeline" |
| memsearch port-to-TS vs Python sidecar | Phase 2 | Decision deferred until retrieval is actually being built |
| Multi-tenant memory scoping | Phase 4 | Workspace isolation is sufficient for now |

## Acceptance criteria for Phase 1

A user (or `k8s-acceptance-loop`) running ax-next against a kind cluster:

1. Creates a new agent.
2. `<workspace>/permanent/memory/system/agent.md` exists with the agent's persona in the body.
3. Sends a few messages mentioning a durable preference ("I prefer React over Vue").
4. After `chat:end`, `<workspace>/permanent/memory/inbox/<ISO>.md` exists with the extracted observation.
5. Sends a message containing a fake API key.
6. After `chat:end`, the inbox does NOT contain the API key — confirmed by grep.
7. Restarts the agent. Memory persists (workspace-permanent semantics).
8. Creates a second agent in the same workspace. Their `memory/` trees are disjoint.

If all eight pass, Phase 1 is done. Phase 2 picks up Consolidator + Retriever.

## Verification

```bash
pnpm --filter @ax/memory-strata build
pnpm --filter @ax/memory-strata test
pnpm test                           # full suite still green
pnpm lint
make dev-fast                       # against kind cluster
# then walk the 8-step acceptance criteria above
```

If any acceptance step fails, fix-and-add-a-test per CLAUDE.md §"Bug Fix Policy" before marking Phase 1 done.
