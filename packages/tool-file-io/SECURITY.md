# Security — `@ax/tool-file-io`

This package registers `tool:execute:read_file` and `tool:execute:write_file`. Both accept caller-provided paths and UTF-8 content; file I/O is the plugin's trust boundary, not a subprocess sandbox.

## Security review

- **Sandbox:** Caller-provided `path` is validated via `safePath(ctx.workspace.rootPath, path)`. `safePath` (a) rejects null bytes, backslashes, colons, and absolute paths on the raw input string (before any splitting), (b) rejects any segment equal to `..` (exact match — segment-aware, so `..foo.txt` is legitimate and accepted, per invariant I3), (c) resolves the path under a realpath'd root and asserts the resolved path stays within `rootReal + path.sep`, (d) walks up existing ancestors and `realpath`s each one, re-checking the boundary after each canonicalization to catch symlinks that point outside the root. Every rejection throws `PluginError({ code: 'invalid-payload', hookName: 'safePath' })`. `read_file` stats the resolved path and refuses files larger than 1 MiB (`MAX_FILE_BYTES`) before calling `fs.readFile`. `write_file` rejects content exceeding 1 MiB via `Buffer.byteLength(content, 'utf8')` — NOT Zod `.max()` on strings, because Zod counts UTF-16 code units and a multi-byte-character string can slip past a naive cap (invariant I4; the emoji test enforces this). File I/O bypasses `sandbox:spawn` by design: the path boundary is the isolation primitive here, and a subprocess-per-read would be wasteful. This is a conscious deviation called out in the boundary review below.

- **Injection:** File bytes returned by `read_file` flow back to the model as tool-result content. The model is the expected downstream sink — `tool:post-call` subscribers (future content scanners) are the designed veto / rewrite lever for anything sensitive that shouldn't reach the model. Paths are never interpolated into shell commands, SQL queries, or HTTP URLs inside this plugin.

- **Supply chain:** No new runtime dependencies. Runtime `dependencies` are `@ax/core` + `zod`. Everything else is Node built-ins (`node:fs/promises`, `node:path`).

## Known scope limits

- **TOCTOU between `fs.stat().size` and `fs.readFile()`** — a concurrent local actor could swap the file between checks. Acceptable for Week 4–6: the attacker model is the model's own tool calls, not a concurrent local attacker inside the workspace. Revisit for untrusted multi-tenant scenarios.
- **TOCTOU inside `safePath`'s ancestor walk** — the realpath check runs at `safePath` call time; a local actor could introduce an escaping symlink between `safePath` and the subsequent `fs.readFile` / `fs.writeFile`. Same acceptance as above.
- **POSIX-only.** `path.resolve` assumes POSIX semantics; `safePath` has not been audited for Windows drive letters, UNC paths, or 8.3 short names. Week 4–6 targets Linux and macOS.
- **No CLI cancellation.** Long reads / writes aren't interruptible. Acceptable — the 1 MiB cap makes the worst-case bounded.

## Boundary review

- **Alternate impl this hook could have:** `@ax/tool-file-io-via-sandbox` (hypothetical, future) — same hook surface, executes file ops inside a subprocess for extra isolation. Same input/output shapes. Rejected for Week 4–6 per the rationale above.
- **Payload field names that might leak:** `path`, `content`, `bytes`. All filesystem-agnostic in the sense that a GCS-backed workspace could satisfy the same contract with `path` = manifest key, `bytes` = blob size. No git / sqlite / http vocabulary.
- **Subscriber risk:** None — both are service hooks (one producer each), not subscriber hooks.
- **Wire surface:** NOT exposed as IPC actions this week. In-process consumers only. Week 7+ may expose these for agent-side tool-local execution.
