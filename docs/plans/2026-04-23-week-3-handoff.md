# Week 3 handoff — smallest viable end-to-end

**For:** next session, after clearing context.
**Previous slice:** Week 1–2 kernel, shipped on branch `feat/kernel-hook-bus` (17 commits, not yet merged). Plan: `docs/plans/2026-04-23-kernel-hook-bus-and-chat-loop.md`.

---

## Starting state

- Branch `feat/kernel-hook-bus` is ahead of `main` by 17 commits. Not merged — Week 3 should branch off of it (`git checkout -b feat/week-3-smallest-e2e feat/kernel-hook-bus`), not `main`. Week 1–2 and Week 3 can merge together later as a stack.
- Test totals: `@ax/core` 40/40, `@ax/test-harness` 5/5. `pnpm build` + `pnpm lint` clean.
- Acceptance test from Week 1–2: `chat:run` with no LLM plugin returns `{ kind: 'terminated', reason: 'no-service:llm:call' }`.
- Kernel public API (what Week 3 plugins consume from `@ax/core`):
  - `HookBus` — `registerService`, `hasService`, `call` (service) / `subscribe`, `fire` (subscriber).
  - `registerChatLoop(bus)` — registers `chat:run` as a service hook.
  - `makeChatContext`, `createLogger`, `makeReqId`.
  - `PluginError`, `reject`, `isRejection`.
  - `Plugin`, `PluginManifest`, `PluginManifestSchema`, `bootstrap`.
  - Types: `ChatMessage`, `ToolCall`, `LlmRequest`, `LlmResponse`, `ChatOutcome`, `FireResult`.
- `@ax/test-harness` exports `createTestHarness` and `MockServices.basics`.

## Week 3 goal (from architecture doc Section 10)

```
Week 3 — Smallest viable end-to-end
  • @ax/llm-mock (always returns "hello"), @ax/sandbox-subprocess
    (just spawns node + IPC), @ax/storage-sqlite, @ax/cli
  • Goal: send a message, get a fake response. Full loop runs.
```

Plain-English version: four new packages, one acceptance test where a real CLI process sends a message and gets back a canned LLM response. No real LLM, no real tools beyond the subprocess sandbox spawning, no real DB usage yet beyond demonstrating the storage service contract.

## Scope clarifications to resolve while writing the plan

Nothing in the architecture doc fully pins these. The plan for Week 3 needs to decide:

1. **Does `@ax/sandbox-subprocess` get exercised by the Week 3 acceptance test?** The minimal "send a message, get a response" path doesn't need sandbox spawning if the LLM is mocked and there are no tool calls. Options:
   - **(a)** Ship `@ax/sandbox-subprocess` as a plugin that registers `sandbox:spawn` but isn't touched by the happy-path test. Acceptable only if a unit test for `@ax/sandbox-subprocess` in isolation covers it — otherwise it's half-wired per CLAUDE.md invariant 3.
   - **(b)** Defer the sandbox to Week 4 when real tools arrive and actually need it.
   - **Recommendation:** (b) unless there's a reason the IPC primitives need to land in Week 3. Week 1–2 explicitly deferred IPC primitives; Week 3 is a natural place to add them, but "sandbox-subprocess with no caller" is the exact trap invariant 3 forbids.

2. **`@ax/storage-sqlite` — what does it actually store in Week 3?** The chat loop doesn't touch storage. Options:
   - **(a)** Ship it registering the `storage:get` / `storage:set` service hooks, with a tiny test-only key-value table, and have the CLI log the final message to it as a "chats" record. That gives storage a real consumer.
   - **(b)** Defer to Week 4 when audit / memory plugins actually write data.
   - **Recommendation:** (a) — a key-value store with a `{ key TEXT PRIMARY KEY, value BLOB }` table is ~20 LOC and gives the service hook a real subscriber, avoiding the half-wired trap.

3. **`@ax/cli` shape.** The architecture doc (Section 9) imagines `@ax/cli` as a bundled entry point that reads an `ax.config.ts` to decide which plugins to load. Week 3 needs to pick a minimal form. Options:
   - **(a)** Full `ax.config.ts` loader: discover config file, dynamic-import plugin modules listed by name.
   - **(b)** Hardcoded preset: `@ax/cli` imports the Week-3 plugin set directly, boots them, sends one message, prints the response. No config file. Simpler, less surface, matches "smallest viable."
   - **Recommendation:** (b) for Week 3. Move to (a) when there are two or more presets to pick between.

4. **Known issues deferred from Week 1–2 that Week 3 should fold in.** From the final code review:
   - **Replace `classify()` regex** in `chat-loop.ts` with a structured `hookName?: string` field on `PluginError`. Fragile today; cheap to fix before more branches touch the loop.
   - **Max-turns guard** on the chat loop (cheap insurance before a real LLM is wired up). Low priority since `@ax/llm-mock` always returns no tool calls → loop exits after one turn anyway, but worth putting in while adding the first real consumer.
   - **Rename `detectCycles`** in `bootstrap.ts` (it also does duplicate-producer detection). Five-line refactor; easy to slip in.
   - **Tool-result message shape** (`[tool <name>] <JSON>`). Placeholder. Defer until a real LLM provider API shape forces the decision.

5. **IPC primitives (deferred from Week 1–2).** Needed if Week 3 ships `@ax/sandbox-subprocess`. Tied to scope decision (1). If (1b), also defer IPC; if (1a), write IPC primitives in `@ax/core`.

## Security note

Week 3 touches two places that require `security-checklist`:
- `@ax/sandbox-subprocess` if shipped (sandbox boundary + IPC transport).
- `@ax/storage-sqlite` (external-system boundary — SQL injection, file path handling for the db file).

The `security-checklist` skill produces the structured PR note; invoke it before writing those packages.

## Expected deliverables for Week 3

If scope recommendations (1b), (2a), (3b) are followed:
- `@ax/llm-mock` — tiny LLM plugin that always returns `{ assistantMessage: { role: 'assistant', content: 'hello' }, toolCalls: [] }`.
- `@ax/storage-sqlite` — SQLite-backed key-value store implementing `storage:get` / `storage:set`. Single table, Kysely-based.
- `@ax/cli` — hardcoded preset: imports the four plugins (`@ax/core` + `@ax/llm-mock` + `@ax/storage-sqlite` + a tiny `audit` subscriber that writes the final message to storage), boots them via `bootstrap`, sends a hardcoded user message through `chat:run`, prints the response.
- Acceptance test: spawns the CLI as a subprocess, asserts stdout contains "hello" and the SQLite file has the logged chat.
- Deferred: `@ax/sandbox-subprocess`, IPC primitives, full config loader. These land in Week 4 when the motivation is clearer.

## Kickoff prompt for the next session

After running `/clear`, paste this:

```
Write an implementation plan for Week 3 of docs/plans/2026-04-22-plugin-architecture-design.md
(smallest viable end-to-end). Read docs/plans/2026-04-23-week-3-handoff.md first — it
captures the starting state, scope decisions to make, and kernel API surface Week 3 consumes.
Branch policy: the new work branches off feat/kernel-hook-bus, not main (Week 1–2 is still
unmerged). The plan should be executable task-by-task via subagent-driven-development, same
as the Week 1–2 plan at docs/plans/2026-04-23-kernel-hook-bus-and-chat-loop.md.
```

That will trigger `writing-plans` on a clean context with everything it needs.
