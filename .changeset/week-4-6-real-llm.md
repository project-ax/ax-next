---
'@ax/core': minor
'@ax/sandbox-subprocess': minor
'@ax/tool-dispatcher': minor
'@ax/tool-bash': minor
'@ax/tool-file-io': minor
'@ax/llm-anthropic': minor
'@ax/cli': minor
---

Week 4–6 slice: real LLM, real tools, real sandbox, all single-host.

- `@ax/core` gains IPC primitives — `WireRequestSchema`, `WireResponseSchema`, `encodeFrame`, `FrameDecoder`, `MAX_FRAME` (4 MiB cap). Length-prefixed framing rejects oversize frames before body allocation. Chat loop forwards `err.hookName` on `no-service` termination reasons so dispatcher errors surface cleanly.
- `@ax/sandbox-subprocess` — new. First real sandbox. `sandbox:spawn` service hook spawns short-lived children with argv-array (no shell interpolation), env allow-list (`PATH/HOME/LANG/LC_ALL/TZ` + empty `NODE_OPTIONS`, parent secrets like `ANTHROPIC_API_KEY` stripped), SIGKILL timeout (default 30 s), stdout/stderr caps (default 1 MiB each).
- `@ax/tool-dispatcher` — new. Thin plugin that owns `tool:execute` and fans out to `tool:execute:<name>` sub-services. Dynamic sub-service resolution documented under the boundary-review section of the PR.
- `@ax/tool-bash` — new. Registers `tool:execute:bash`. Runs `['/bin/bash', '-c', command]` through `sandbox:spawn`. Zod caps command at 16 KiB; default per-call timeout 30 s.
- `@ax/tool-file-io` — new. Registers `tool:execute:read_file` and `tool:execute:write_file`. Uses `fs/promises` directly with `safePath` realpath-based boundary check (rejects symlink escapes, absolute paths, traversals). 1 MiB caps on both read and write.
- `@ax/llm-anthropic` — new. Registers `llm:call` backed by `@anthropic-ai/sdk@0.90.0` (pinned exact). Reads `ANTHROPIC_API_KEY` at init, fails fast if missing, never echoes the key into errors. Tool forwarding deliberately disabled until `ToolDescriptor` gains an input-schema field (follow-up PR).
- `@ax/cli` gains an `ax.config.ts`/`.js`/`.mjs` loader with Zod-validated schema and builds its plugin list from the parsed config. Default config preserves the Week-3 mock-based behavior.
- New e2e test drives a real bash subprocess through the real sandbox via a mocked Anthropic fixture (`AX_TEST_ANTHROPIC_FIXTURE`). Week-3 e2e still green.
