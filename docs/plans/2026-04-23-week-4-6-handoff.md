# Week 4–6 handoff — real LLM + tools

**For:** session starting Week 4–6.
**Previous slices:** Week 1–2 kernel (`docs/plans/2026-04-23-kernel-hook-bus-and-chat-loop.md`), Week 3 smallest-e2e (`docs/plans/2026-04-23-week-3-handoff.md`).

**Assumes Week 3 followed the recommended shape:**
- `@ax/llm-mock`, `@ax/storage-sqlite`, `@ax/cli` shipped.
- `@ax/sandbox-subprocess` and IPC primitives were DEFERRED.
- CLI is hardcoded-preset (no `ax.config.ts` loader yet).

If Week 3 diverged, re-read the decisions below and adjust.

---

## Goal (architecture doc Section 10)

```
Week 4-6 — Real LLM + tools
  • @ax/llm-anthropic, @ax/llm-router (port routing logic from legacy)
  • @ax/tool-bash, @ax/tool-file-io (port from legacy agent code)
  • Goal: real chat with bash + file tools, single-host. Smoke test passes.
```

Translation: real LLM, real shell + file tools, single-host. First slice where model output and tool output are actually untrusted content flowing through the hook bus.

## Deliverables

- `@ax/llm-anthropic` — calls Anthropic API. New dependency on `@anthropic-ai/sdk`. Registers `llm:call`. Reads `ANTHROPIC_API_KEY` from env (credentials plugin deferred until a second consumer exists).
- `@ax/llm-router` — **scope TBD** (see decision 3). Likely deferred.
- `@ax/tool-bash` — executes shell commands. Registers `tool:execute` for `bash` tool name (or owns its own `tool:execute:bash` — see decision 1).
- `@ax/tool-file-io` — `read_file` / `write_file`. Path validation via ported `safePath` helper.
- `@ax/sandbox-subprocess` — **finally lands.** Every `tool:execute` needs sandbox isolation. IPC primitives (length-prefixed framing + Zod wire validation) land in `@ax/core` as part of this slice.
- `@ax/cli` gains a minimal `ax.config.ts` loader (now that there's a choice between `llm-mock` and `llm-anthropic`).

## Scope decisions to make while writing the plan

1. **Tool dispatch shape.** Chat loop calls `tool:execute` as a single service hook. With multiple tool plugins, how does the bus pick? Options:
   - **(a)** One `@ax/tool-dispatcher` plugin registers `tool:execute`, looks at `input.name`, and calls `tool:execute:bash` / `tool:execute:file-io` sub-services. Each tool plugin registers its own named sub-hook.
   - **(b)** Each tool plugin registers `tool:execute` directly, and the bus picks based on... something. This conflicts with the one-producer rule.
   - **Recommendation:** (a). Matches v2's dispatch-via-hook pattern. The dispatcher is thin (~30 LOC).

2. **Sandbox granularity.** `tool:execute` needs sandbox isolation.
   - **(a)** Spawn a subprocess per tool call (Node `child_process` with cwd/env/stdio lockdown). Simple, high per-call overhead.
   - **(b)** Long-lived agent process per chat, host RPCs into it. Lower overhead, more state. Matches legacy.
   - **Recommendation:** (a) for Week 4–6. (b) lands in Week 7–9 with the k8s sandbox (pods are naturally long-lived).

3. **`@ax/llm-router`.** Do we actually need routing in Week 4–6?
   - **(a)** Ship a real router that picks between `llm-anthropic` / `llm-openai` by config. No `llm-openai` plugin yet, so router has one fallback — trivial.
   - **(b)** Defer router until there are two real LLM providers.
   - **Recommendation:** (b). One-provider-per-config is the smallest viable shape. Router is a Week 10+ plugin.

4. **`ax.config.ts` loader.** With two LLM options, the user has to pick.
   - **(a)** Full TS config file with dynamic import.
   - **(b)** CLI flag: `ax chat --llm=anthropic --sandbox=subprocess`.
   - **Recommendation:** (a). A real config file is where v2 differentiates from ad-hoc legacy config. Matches architecture doc Section 9.

5. **Credentials.** `ANTHROPIC_API_KEY`.
   - **(a)** Read from env directly in `@ax/llm-anthropic`.
   - **(b)** Ship `@ax/credentials` plugin with a `credentials:get` service hook.
   - **Recommendation:** (a). One consumer = no abstraction needed yet. `@ax/credentials` lands when a second plugin (audit, OAuth, etc.) also needs secrets.

## Kernel follow-up to fold in

From the Week 1–2 final review (still open):

- **Replace `classify()` regex** in `chat-loop.ts` with structured `hookName?: string` field on `PluginError`. The tool-execute path is about to become a real consumer; fragile regex is a real risk now.
- **Max-turns guard** on the chat loop. A real LLM with tool calls can loop indefinitely if a subscriber keeps returning tool calls. Add a config-driven max-turns (default ~50) that terminates with `reason: 'max-turns-exceeded'`.
- **Rename `detectCycles`** in `bootstrap.ts` (also does duplicate-producer detection). Five-line refactor.

Fold these into the plan as their own tasks — don't slip them in silently.

## Security — `security-checklist` required

Four new surfaces cross trust boundaries:

- **`@ax/llm-anthropic`** — new external dependency, untrusted model output.
- **`@ax/tool-bash`** — spawns processes with user-influenced input. The sandbox is the only thing preventing RCE.
- **`@ax/tool-file-io`** — caller-provided paths. `safePath` must enforce the workspace boundary.
- **`@ax/sandbox-subprocess`** — first real sandbox. Resource limits, stdout/stderr size caps, timeout, env scrubbing.
- **IPC primitives in `@ax/core`** — length-prefixed framing + Zod validation. Malformed wire messages must not crash the host.

Invoke `security-checklist` before writing each of these packages. Three threat models: sandbox escape, prompt injection, supply chain. Produces a structured PR security note.

## Legacy helpers to port (read-only `~/dev/ai/ax/`)

- `safePath` — path boundary enforcement. Find it, read it, port it as a util in `@ax/tool-file-io` or as a shared util in `@ax/core` (decide when you see it).
- LLM provider wiring from `src/providers/anthropic.ts` — port the auth + request shape, skip the orchestration.
- Bash tool from legacy agent code — port the arg marshalling, skip any multi-mode sandbox conditional (that's exactly what v2 removes).

## Acceptance test for Week 4–6

Automated smoke test: spawn the CLI, send a message like `"list files in cwd"`, assert:
- A real Anthropic response arrives (mock the API in tests — skip real network for CI).
- The LLM's `bash` tool call is intercepted, sandboxed, executed, result returned.
- Loop terminates normally with `{ kind: 'complete' }` and the final assistant message is non-empty.

Real-network smoke test (manual, not in CI): same, but against real Anthropic API. One-time manual verification per week.

## Kickoff prompt for next session

After `/clear`:

```
Write an implementation plan for Week 4–6 of docs/plans/2026-04-22-plugin-architecture-design.md
(real LLM + tools + sandbox). Read docs/plans/2026-04-23-week-4-6-handoff.md first — it captures
the starting state, scope decisions to make, and the kernel follow-up items that must fold in.
Invoke security-checklist for the sandbox / IPC / tool-bash / llm-anthropic surfaces. Branch off
the tip of the Week 3 branch (or main if Week 3 was merged). The plan should be executable via
subagent-driven-development.
```
