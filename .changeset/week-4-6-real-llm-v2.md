---
"@ax/core": minor
"@ax/sandbox-subprocess": minor
"@ax/tool-dispatcher": minor
"@ax/cli": minor
---

Week 4–6 slice: real LLM + tools + sandbox.

- `@ax/core` — IPC framing + wire schemas (4 MiB frame cap enforced before allocation; `PluginError` on all encoder/decoder failures, never raw `TypeError`). Shared `SandboxSpawn{Input,Parsed,Result}` types in core so tool plugins can import them without cross-plugin deps. `ToolDescriptor.inputSchema` now required. `ChatContext.workspace.rootPath` threaded through. `chat-loop`'s `classify(err)` replaced with structured `reasonFromError(err)` reading `PluginError.hookName` + `code`. `detectCycles` consolidated into `validateDependencyGraph`.
- `@ax/sandbox-subprocess` — subprocess-per-call sandbox. Env allowlist merged AFTER caller env (caller cannot override `PATH`, `HOME`, etc.; `ANTHROPIC_API_KEY` never forwarded — proven by unit test). `argv[0]` shape validated. `stdout`/`stderr` capped at 1 MiB each with truncation flag. SIGKILL timeout (default 30 s, cap 300 s). `child.stdin` error handler absorbs EPIPE/ECONNRESET to keep the host alive.
- `@ax/tool-dispatcher` — fan-out plugin registering `tool:execute` and routing to `tool:execute:<name>`. Tool names validated against `/^[a-z][a-z0-9_-]{0,31}$/` before the sub-hook lookup.
- `@ax/llm-anthropic` — `llm:call` via pinned `@anthropic-ai/sdk@0.91.0` (exact, no `^`/`~`). One retry on HTTP 429/5xx with 1 s backoff. API key redaction in every thrown `PluginError.message`. Constructor-injected `clientFactory` is the sanctioned test seam; no env-var dynamic-import backdoors.
- `@ax/cli` — `ax.config.ts` loader with strict Zod schema, `cwd`-relative discovery (`ax.config.ts` / `.js` / `.mjs`). Plugin list built from resolved config. `main()` gains a library entry point accepting `{ message, configOverride, workspaceRoot, sqlitePath, stdout, stderr, anthropicClientFactory }`. The AX_DB env var remains supported for binary-mode invocation.

Post-mortem of the rolled-back v1 attempt (PR #3): see `docs/plans/2026-04-23-week-4-6-real-llm-and-tools-v2.md` invariants I1–I12 — each names the v1 failure mode, the fix, and the task that closes it.
