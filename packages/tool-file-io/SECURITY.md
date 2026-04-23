# @ax/tool-file-io — Security

This plugin gives the model two tools: `read_file` and `write_file`. Both
take a path relative to the workspace root. Both could be catastrophic if we
got path handling wrong. So we're going to be very clear about what we do
and what we refuse to do.

## Security review

- **Sandbox:** This plugin DELIBERATELY does not call `sandbox:spawn`. A
  subprocess per file read is wasteful, and we already have a stronger
  boundary: `safePath(root, candidate)` canonicalizes both sides with
  `realpath` before the containment check, so symlink escapes and `..`
  segments both get caught. Absolute paths are rejected outright — tool args
  are relative to the workspace, full stop. Read and write payloads are both
  capped at 1 MiB: `write_file` enforces the cap via Zod before we touch the
  filesystem (defense-in-depth), `read_file` enforces it by `stat`-ing
  before reading so a pointer at `/dev/zero` or a giant log file can't
  exhaust memory. The workspace root is currently `process.cwd()` with a
  `TODO(workspace-abstraction)` — an implicit capability grant that will
  become explicit when `ChatContext` (or a workspace service hook) gains a
  proper root field.
- **Injection:** File content is untrusted. When the model reads a file, the
  bytes flow back as a tool result and into the next model turn — same
  pattern as bash tool output. We pass it through as-is; no shell, no
  template, no eval. The consumer (the LLM plugin) is responsible for
  treating tool results as data, not instructions. The `path` argument is
  structurally constrained: Zod caps length at 4096 chars, `safePath` rejects
  anything that escapes the root, and we never interpolate `path` into a
  shell command — `fs.readFile` / `fs.writeFile` take it as a literal.
- **Supply chain:** No new runtime dependencies. `fs/promises`, `path`, and
  `node:buffer` are Node built-ins; `zod` is already a workspace dep pinned
  via the root lockfile.

## What this plugin does NOT do

- It does not respect `.gitignore`, `.dockerignore`, or any other "please
  don't touch this" convention. If the model asks for `node_modules/...`
  and it's inside the workspace, the plugin will happily read it.
- It does not version, back up, or diff writes. `write_file` overwrites.
  That's the whole contract.
- It does not check MIME types or refuse binary content. `utf8` decode will
  produce replacement characters for non-text, which is ugly but not
  dangerous.

That's all fine for the first cut — the threat model is "the model tricks
the tool into reading or clobbering something outside the workspace," and
`safePath` is the answer to that. If you find a way past it, please tell
us immediately.
