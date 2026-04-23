# @ax/sandbox-subprocess — Security

This plugin is the first real sandbox in ax-next. It registers the
`sandbox:spawn` service hook, which any tool plugin can call to run a
subprocess. Because a sandbox is exactly the wrong place to be sloppy, here's
what it does and, more importantly, what it refuses to do.

## Security review

- **Sandbox:** Spawns the child with `child_process.spawn` in argv-array form
  and `shell: false` — no shell, no expansion, no `bash -c`. `cwd` comes from
  the caller. The child env is built from scratch (never `{ ...process.env }`):
  only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ` are copied from the parent, plus
  `NODE_OPTIONS=''` to neutralize any parent-set `--require` injection.
  Parent secrets — including `ANTHROPIC_API_KEY` and anything else not in the
  allowlist — never reach the child. Caller-provided env merges last (declared
  by the tool plugin, not by the model). Stdout/stderr are byte-capped at
  1 MiB by default, reported via `truncated.{stdout,stderr}`. A 30s default
  `SIGKILL` timeout keeps runaway children from pinning the host. Stdio is
  `['pipe','pipe','pipe']` — no IPC channel, no inherited FDs.
- **Injection:** Child output is treated as bytes. We return captured strings
  to the host and never interpolate them into a shell, a prompt, or another
  argv. The `sandbox:spawn` payload is validated by a Zod schema; per-action
  validation (what argv is safe for *this* tool) is the calling tool plugin's
  job — e.g. `@ax/tool-bash` is responsible for not letting the model
  hand-craft argv[0]. Covered by tests: the env-scrubbing test sets
  `ANTHROPIC_API_KEY=SHOULDNOTLEAK` in the parent, runs a child that prints
  that variable, and asserts the child saw `GONE`. The no-shell test passes
  `$HOME` as a literal argv element and asserts the child receives the
  literal `$HOME`, not the expanded path.
- **Supply chain:** No new runtime dependencies. The implementation uses only
  Node built-ins (`node:child_process`, `node:fs`, `node:os`, `node:path`).
  `zod` is already a workspace dependency used by `@ax/core` for schema
  validation; we pin through the root lockfile like everything else.

## What this sandbox does NOT do (yet)

This is process-level isolation only. It does not give you:

- a chroot, a container, a VM, or any filesystem jail — the child can read
  anything the parent user can read;
- a seccomp filter — the child can make any syscall the kernel allows;
- network isolation — the child can reach the network if `PATH`-resolved
  binaries can.

That's fine for the first cut (the threat model here is "the model tricks a
tool into running the wrong command," not "the child is a malicious binary").
Stronger isolation lands when we add a container-backed sandbox plugin;
this hook surface is designed so that swap should be drop-in.
