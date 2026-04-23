# @ax/tool-bash — Security

This plugin lets the model run shell commands. Yes, we know how that sounds.
It's a bash-shaped hole by design — the whole point is "let the model run
`grep`, `ls`, `cat`" — but every byte of isolation comes from the sandbox
underneath, not from this plugin. Here's what we're trusting, and what we're
not.

## Security review

- **Sandbox:** We don't spawn anything ourselves. We call `sandbox:spawn` with
  `argv: ['/bin/bash', '-c', command]`, `env: {}` (empty, so the sandbox's
  allow-list applies cleanly), the workspace root, and a 30-second default
  timeout (override up to 5 minutes). The `-c` form is a full shell — glob
  expansion, pipes, subshells, the works. That IS the bash tool; if we
  stripped the shell out, we'd just be a worse `sandbox:spawn`. Isolation
  (env scrubbing of parent secrets like `ANTHROPIC_API_KEY`, stdout/stderr
  byte caps, `SIGKILL` timeout, no IPC channel) is the sandbox's job, and
  it's covered by `@ax/sandbox-subprocess`'s tests. We just pass the command
  through as one argv element so no caller-side `argv` manipulation can
  sneak in extra args. The working directory is now explicit: we read
  `ctx.workspace.rootPath` from `ChatContext` and pass that as `cwd:`. No
  implicit `process.cwd()` grant — the CLI (or whatever constructs the
  context) has to declare the workspace root up front.
- **Injection:** `command` is model output. We treat it as untrusted string
  data — it's validated by Zod (non-empty, max 16 KiB), then handed to the
  sandbox as a single argv element. No string concatenation into other
  shells, no interpolation into prompts, no dynamic code evaluation of any
  kind. The command's stdout and stderr come back to the model as tool
  result content; the model can see its own output, which is the point.
- **Supply chain:** No new dependencies. `zod` is already workspace-pinned
  via `@ax/core`. The runtime dep on `@ax/sandbox-subprocess` is intentional
  — the manifest declares `calls: ['sandbox:spawn']`, so the sandbox plugin
  needs to be loaded whenever we are.

## What this plugin does NOT do

- It does not sanitize the command. We don't try to outsmart `rm -rf /` by
  pattern-matching. That's a losing game. The sandbox caps what any command
  can reach; bash itself is assumed hostile.
- It does not pick argv[0]. It's always `/bin/bash`. The model cannot swap
  the binary.
- It does not add env vars. The caller (us) passes `env: {}`; the sandbox
  decides the child's environment from its own allow-list.
- It does not route stdout elsewhere. The captured strings go back to the
  calling chat loop, and nowhere else.

If you want stronger isolation (container sandbox, network cutoff, FS jail),
that's a different `sandbox:*` plugin. This tool doesn't change — it just
picks up the better sandbox for free.
