# @ax/llm-anthropic — Security Notes

This plugin registers the `llm:call` service and talks to Anthropic's API on the
kernel's behalf. We're the nervous crab: here's what we worry about, and what
we do about it.

## Output contract

| Surface              | What we do                                                                 |
| -------------------- | -------------------------------------------------------------------------- |
| Network destination  | HTTPS to `api.anthropic.com` only. Not caller-influenced.                  |
| Auth                 | `ANTHROPIC_API_KEY` read from `process.env` **at init time**, once.        |
| Missing key behavior | Fails fast with `PluginError({ code: 'init-failed' })`. No silent fallback.|
| Key in logs/errors   | Never. SDK error details are swallowed (see "Injection" below).            |
| Key forwarded        | Never. Not passed to hooks, storage, or child processes.                   |

## Threat models

### 1. Sandbox escape — N/A-ish

We don't spawn processes, write files, or open arbitrary sockets. We make a
single outbound HTTPS request to a fixed host via the official SDK. The usual
capability concerns (`exec`, `fs`, env) don't apply here.

The one capability we need: read one specific env var (`ANTHROPIC_API_KEY`).
We read it exactly once at init and never look again.

### 2. Prompt injection — yes, this plugin's output is untrusted

Anything the model says is untrusted content. The `LlmResponse` we emit flows
straight into:

- `llm:post-call` subscribers — which can veto.
- `toolCalls[]` → `tool:execute` → the relevant tool plugin.

Specifically:

- We **never** `eval`, `Function(...)`, or template-interpolate any field from
  the SDK response.
- `ToolCall.input` is passed through as `unknown`. Tool plugins are responsible
  for Zod-validating their own input before acting on it. We don't pre-parse,
  because guessing wrong here would give a false sense of safety.
- Text blocks are concatenated into a plain string. That string is not
  interpreted by this plugin in any way — it's just the assistant message.

#### Tool-calling currently disabled at the API boundary

Heads up: we do **not** forward `input.tools` to the Anthropic API right now.
`ToolDescriptor` doesn't yet carry a real `input_schema`, and sending tools
without one means the model gets a tool it can't call correctly — silently
broken tool use is worse than no tool use. We'd rather fail closed.

The decode path for `tool_use` blocks is still wired up (a model can always
surprise us), so any `tool_use` that does come back is mapped to `ToolCall[]`
and handed off for Zod-validated dispatch. Forwarding lands in a follow-up PR
once schemas are threaded through — tracked as `TODO(llm-tool-schemas)` in
`plugin.ts`.

### 3. Supply chain — new dep, pinned hard

- Added `@anthropic-ai/sdk@0.90.0`. **Exact pin**, no caret. If you see `^0.90.0`
  in package.json, something drifted — fix it, don't merge around it.
- Confirmed no `preinstall` / `postinstall` / `prepare` scripts in the SDK
  package (`npm view @anthropic-ai/sdk@0.90.0 scripts` returned only dev
  scripts: `build`, `test`, `format`, etc. — nothing that runs on install).
- `pnpm why @anthropic-ai/sdk -r` at the time of writing:

  ```text
  @ax/llm-anthropic@0.0.0 (PRIVATE)
  dependencies:
  @anthropic-ai/sdk 0.90.0
  ```

  Transitive surface: `json-schema-to-ts@^3.1.1` (production), `zod@^3.25.0 || ^4.0.0`
  (optional peer — satisfied by the repo's existing `zod@3.25.x`).

- Bumping the SDK requires a new `SECURITY.md` note. Don't skip the re-check.

## Manual smoke test (not in CI)

`scripts/smoke.ts` makes a real API call. It is **not** wired into `pnpm test`.
Run it manually when you want to confirm the live integration still works:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm tsx packages/llm-anthropic/scripts/smoke.ts
```

If this ever starts running in CI, something is wrong — it burns real tokens
and needs a real key.
