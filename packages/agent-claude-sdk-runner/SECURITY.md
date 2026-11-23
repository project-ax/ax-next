# Security — `@ax/agent-claude-sdk-runner`

This package is the sandbox-side runner that wraps `@anthropic-ai/claude-agent-sdk`. It spawns the `claude` CLI as a subprocess, bridges the SDK's tool hooks into our host-side IPC (`tool.pre-call`, `event.tool-post-call`), and serves host-mediated tools via an in-process MCP server. Everything it does runs **inside** the sandbox boundary — this process is the untrusted one. This note captures the `security-checklist` walk for the Week 6.5d landing.

## Security review

- **Sandbox:** The runner is on the sandbox side of the trust boundary. Its only reach OUT of the sandbox is (a) the IPC endpoint it was handed via `AX_RUNNER_ENDPOINT` + `AX_AUTH_TOKEN`, which carries auth-gated service calls, and (b) the credential-proxy endpoint — either `AX_PROXY_ENDPOINT` (subprocess sandbox: TCP loopback, set as `HTTPS_PROXY`) or `AX_PROXY_UNIX_SOCKET` (k8s sandbox: the runner starts a local TCP-to-unix bridge so off-the-shelf libraries can dial it). In both modes the SDK calls `api.anthropic.com` directly; the credential-proxy intercepts the request and substitutes the `ax-cred:<hex>` placeholder for the real Anthropic key (held only on the host) mid-flight. The runner never sees the real key. The runner does NOT spawn processes directly — that's the SDK's job — and the CLI's descendant tree (the `claude` CLI, its Bash / Read / Edit tool subprocesses, anything those spawn) stays inside the sandbox filesystem and process namespace. Isolation holds because the sandbox-provider plugin (subprocess today, k8s / docker later) owns the fence, not this runner. Tool reach is constrained two ways: SDK built-ins are an allowlist (`ALLOWED_SDK_BUILTINS`, passed as the SDK's `tools` option — TASK-1200), every other known built-in is ALSO named in `disallowedTools`, and the tool-name classifier refuses any built-in name outside the allowlist as defense in depth; enabled built-ins (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `TodoWrite`, `ToolSearch`, and — as of Phase 0 of the skill-install workflow, I-P0-1 — `Skill`) run with `cwd` = `HOME` = the agent's home (`AX_USERFILES_ROOT`, `/files` in k8s), plus the session scratch root and, when mounted, the read-only memory root as `additionalDirectories`. `settingSources: ['user']` is passed explicitly, so the SDK discovers user skills only under `$CLAUDE_CONFIG_DIR/skills/` (the host's read-only installed-skills projection). The CLI also ships skills inside its binary. Two are switched off at the source: `loop` (it would steer recurring tasks at `CronCreate`, which the allowlist keeps out) and `claude-api`. The `PreToolUse` hook refuses a `Skill` call for any other name that isn't a folder in the projection (`update-config`, `init`, …; see "Only AX's own skills can be invoked" below). `CLAUDE_CONFIG_DIR` is runner-private and outside the agent's home (the runner refuses to start otherwise). Nothing the agent writes in its home loads as configuration (see "Newly enabled with caveats — `Skill`" below). EVERY tool call (built-in AND MCP-host) fires `tool.pre-call` via the SDK's `PreToolUse` hook, giving the host veto / rewrite authority before any execution. Every call also fires `event.tool-post-call` for observation.

- **Injection:** LLM output flows through our proxy, not directly to Anthropic — host-side subscribers on `llm:pre-call` / `llm:post-call` can intercept. Tool output — the raw stdout/stderr / return values from `Bash`, `Read`, an MCP tool result — is untrusted (invariant I5) and flows back into the SDK's model context via the SDK's internal transcript. Our host sees that output via `event.tool-post-call` on the IPC bus; subscribers there treat it as untrusted and scan / scrub / veto accordingly. Inside THIS package, tool output from the SDK is never interpolated into a shell command, file path, SQL query, or URL before it crosses back into the host via IPC — we forward the argument object and result as opaque `unknown` through the structured IPC channel, which serializes as JSON. Host MCP tool arguments arrive from the SDK as an object and are forwarded to the host as-is — the host's own tool handler is what ultimately decides what to do with them, and it already treats its input as untrusted.

- **Supply chain:** One new runtime dependency: `@anthropic-ai/claude-agent-sdk`, exact-pinned to `0.2.119`. `npm view @anthropic-ai/claude-agent-sdk@0.2.119 scripts` returned empty — no `preinstall` / `postinstall` / `prepare` / `install` hooks run at `pnpm install` time. Direct deps: `@anthropic-ai/sdk@^0.81.0`, `@modelcontextprotocol/sdk@^1.29.0`. Maintainers are all `*-anthropic` npm accounts (plus long-standing contributors with anthropic.com emails). Platform-specific optional binaries (`claude-agent-sdk-{darwin,linux,win32}-{arm64,x64}[-musl]`) carry the `claude` CLI binary per platform — same integrity-hashed `.tgz` shape as the parent. Peer-dep: the SDK peer-requires `zod@^4.0.0`; we ship `zod@^3.23.8`, which produces a peer-dep warning. Runtime works today (Zod v3's compat story + the SDK's passthrough-shape pattern), but we accept the warning consciously rather than silently.

### TASK-26 — TTY env-hints for the Bash child

- **Sandbox:** Adds 5 fixed-name / fixed-value terminal-hint env vars
  (`TERM`, `COLUMNS`, `LINES`, `FORCE_COLOR`, `CI`) to the SDK Bash tool's child
  env (`tty-hint-env.ts`). No caller / model input influences the names or
  values — they're compile-time constants in a pure helper. No new filesystem
  path, network destination, process, or handle becomes reachable; the Bash tool
  already spawns arbitrary model-requested commands, so these hints grant nothing
  new. We rejected a pseudo-TTY (which WOULD widen the boundary: a `/dev/pts`
  master/slave kernel object + ioctl surface + interactive control channel for
  untrusted Bash) on invariant-#5 grounds. No capability widened.
- **Injection:** N/A — the helper takes no input and returns constants; it
  touches no model, tool, user, or external string. (Bash *output* is untrusted
  as always, but this change only affects whether the tool produces output, not
  how that output is handled downstream.)
- **Supply chain:** N/A — no `package.json` change, no new dependency.

### TASK-995 — one home, nothing re-rooted

- **Sandbox:** The `PreToolUse` hook no longer rewrites `.ax/**`, `.claude/**`
  or `CLAUDE.md` paths into a separate git-backed tree, and the host MCP server
  no longer flushes a workspace before a host tool (the descriptor flag that
  asked for that flush is gone from the wire too). Nothing is widened: the SDK's file tools reach
  `cwd` (the agent's home) plus `additionalDirectories` = the session scratch
  root and, when mounted, the read-only memory root. That is one directory
  fewer than before (the git tree is gone). The SDK subprocess runs with
  `HOME` = `cwd` = the home; the runner process keeps its own `HOME`.
- **Injection:** Tool input reaches `tool.pre-call` exactly as the model wrote
  it, and only a host `modifiedCall` can change it, so what the host
  adjudicates is what the SDK runs. A configuration-looking file that the agent
  (or an injected tool result talking it into it) writes in its home is inert:
  see "Newly enabled with caveats — `Skill`" below.
- **Supply chain:** N/A — no `package.json` change, no new dependency.

## `@anthropic-ai/claude-agent-sdk` pin posture

- Current specifier: `0.2.119` (exact-pinned; bump intentional). The SDK is pre-1.0 and shipping frequently, so we expect to bump often — but each bump is a deliberate act, not a silent pickup via caret range. Re-run `security-checklist` on every bump.
- Upgrade procedure: use `pnpm add @anthropic-ai/claude-agent-sdk@<new-exact-version>` in `packages/agent-claude-sdk-runner`, re-run the Week 6.5d acceptance test (`pnpm --filter @ax/cli test claude-sdk-runner`), and re-run `security-checklist` on the new dep tree. A new SDK can bring new built-in tool names. They stay out by default: the runner passes `ALLOWED_SDK_BUILTINS` as the SDK's `tools` option, so the SDK loads no built-in that is not on it (TASK-1200). `tool-allowlist-real-sdk.e2e.test.ts` fails when the new binary ships a built-in missing from `KNOWN_SDK_BUILTINS` in `tool-names.ts`; add it there, and to `ALLOWED_SDK_BUILTINS` only if the agent should have it. Anything that schedules, spawns, sends, or holds state outside AX stays off the allowlist.

## Disabled built-ins (why)

- **`WebFetch`** — uncontrolled network egress from inside the sandbox. Network policy is a sandbox-provider concern, and the subprocess sandbox can't enforce it today.
- **`WebSearch`** — same reason as `WebFetch`, plus search result content is a prime prompt-injection vector if the sandbox were to fetch and inline it.
- **`Task`** — spawns sub-agents with fresh sessions. Sub-agent capability scoping (each sub-agent should have its own IPC identity, not inherit the parent's) is a Week 9.5+ design concern, not something we'd want to accidentally enable.
- **Everything else not on the allowlist** (TASK-1200) — `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `RemoteTrigger` schedule work AX's scheduler never sees, in a sandbox that does not outlive the session; a walk caught an agent using `CronCreate` to skip the `routine_create` hold and then report a routine that would never run. `SendMessage`, `TeamCreate`, `TeamDelete` spawn or message other agents; `PushNotification` reaches outside the sandbox; `Monitor`, `TaskOutput`, `TaskStop` are not needed by any AX flow (Bash's own `run_in_background` stays; its output file is readable with `Read`); `Agent` is the wire name of `Task`; `ListMcpResourcesTool`/`ReadMcpResourceTool` would read a connector's MCP resources around the per-tool `mcp.<ns>.<tool>` policy rules (no AX flow uses MCP resources); `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` need an interactive UI the headless runner does not have; `EnterWorktree`/`ExitWorktree` move the working tree; `NotebookEdit` duplicates `Edit` without the policy rail describing it. These were reachable before TASK-1200 because most are deferred — loadable by name through `ToolSearch` — and `disallowedTools` named only four.

## Newly enabled with caveats — `Skill`

**`Skill`** is the SDK's built-in skill-discovery tool. Phase 0 enabled it via `allowedTools: ['Skill', ...]`, and Phase 3 narrowed `settingSources` to `['user']`. The agent-self-escalation risk — the agent writing configuration that the SDK then trusts — is held by three independent defenses:

- `settingSources: ['user']`. The `'project'` source would load `<cwd>/.claude/**` (settings hooks, skills, agents, commands), `<cwd>/CLAUDE.md` and `<cwd>/.mcp.json` from the agent's home, which the agent writes freely. It is not passed, and `main.test.ts` pins that on every `query()` call.
- `CLAUDE_CONFIG_DIR` (the `'user'` root) is runner-private (k8s `/home/runner/.ax/session`) and outside the agent's home. The runner refuses to start when it is unset, relative, missing, or overlaps the home (`assertConfigDirOutsideAgentHome` in `@ax/agent-runner-core`, TASK-994), because unset, the SDK falls back to `$HOME/.claude` — the agent's own files.
- The §11 canaries plant `CLAUDE.md`, `.claude/settings.json` hooks, `.claude/skills/`, `.mcp.json` and `.claude.json` MCP servers in the agent's home and check that none has any effect: against the real `claude` binary (`agent-files-guards-real-sdk.e2e.test.ts`, with two controls that make the same plants live by removing one protection each), and at the runner level (`main.test.ts`, `describe('agent files §11 guards')`).

Until TASK-995 a fourth layer re-rooted the file tools' `.ax/**`, `.claude/**` and `CLAUDE.md` paths into a separate git-backed tree, where `@ax/validator-skill` vetoed SDK-config writes at commit time. Both are gone. Those names are ordinary files in the home now, and the three defenses above are why that is safe.

See `docs/notes/2026-05-17-sdk-setting-sources-audit.md` for the full audit of files the SDK reads from its setting sources.

## Enabled built-ins

`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `TodoWrite`, plus `Skill` (above) and `ToolSearch`. `ToolSearch` keeps deferred tool schemas (AX's host tools, connector tools) out of the first request and loads them by name — without it the CLI loads every MCP tool up front, so it is a context-size choice, not a reachability one — and it cannot load a built-in outside the allowlist (`tool-allowlist-real-sdk.e2e.test.ts` checks this on the real binary). The file tools are all filesystem-scoped to `cwd` (the agent's home) plus `additionalDirectories` (the session scratch root and, when mounted, the read-only memory root), set on the `query()` call. `Bash` gets the same process-spawn constraints as the sandbox-provider imposes on the parent — the subprocess sandbox today means "same uid, same network stack, same filesystem"; the k8s sandbox (Week 7–9) will tighten that. `TodoWrite` writes into the SDK's in-memory session state, not disk.

## Terminal output / no-TTY compatibility (TASK-26)

The `Bash` tool runs a **fully-detached, no-controlling-TTY** shell. Plenty of
CLIs check "am I talking to a terminal?" and, finding no, write **nothing** —
the tool exits 0 and the agent gets an empty result with no error. We hit this
with `@schpet/linear-cli` (a cliffy/Deno binary): even plain `--help`, no network
involved, produced zero stdout. Its network calls worked fine; the binary just
rendered nothing into the void.

The fix is **env-hints, not a pseudo-TTY**. `main.ts` stamps a small set of
terminal-hint env vars onto the SDK `query()` env the Bash child inherits (see
`tty-hint-env.ts`): `TERM=xterm-256color`, `COLUMNS=120`, `LINES=40`,
`FORCE_COLOR=1`, `CI=1`. These flip the common terminal detectors so the tools
emit output (plain or colored). They're inert constant strings — they change zero
capabilities. We deliberately did **not** allocate a pseudo-TTY: a real
`/dev/pts` master/slave is a kernel object plus an ioctl surface plus an
interactive control channel, and handing that to untrusted, model-driven Bash
widens the sandbox boundary for no good reason (capability minimization,
invariant #5). The hints are a default *floor*, not a clamp — they're spread
FIRST, so if the host ever genuinely has a TTY (and forwards a real
`TERM`/`COLUMNS`/`LINES` through `proxy-startup.ts`'s allowlist), the real value
wins.

Which CLI output shapes work vs. not:

- **Plain-pipe writers — always worked, unaffected.** Tools that just write to
  stdout no matter what: `echo`, `cat`, `git`, and most Go/Rust tools using plain
  `println!` / `fmt.Println`. These never cared about a TTY.
- **TTY/terminal-detecting writers — fixed by the env-hints.** cliffy/Deno
  (`isTerminal()`), ink, chalk / `supports-color`, and CI-aware tools that
  suppress output when they think no one's watching. Previously emitted nothing;
  now emit (plain or colored) output.
- **Hard pty-only tools — still won't work, and that's intended.** Full-screen
  TUIs and interactive prompts that call `ioctl(TIOCGWINSZ)` or open `/dev/tty`
  directly and refuse to run without a real terminal: interactive `vim` / `top`,
  password prompts, and the like. They need an actual pty, which we've ruled out
  on security grounds. These are interactive tools that don't belong in a
  detached agent shell anyway — if you need one in a script, reach for its
  non-interactive flags (`--batch`, `--no-pager`, piping input) instead.

## Known scope limits

- **A future SDK's new built-ins are off by default (TASK-1200).** The SDK's `tools` option loads only `ALLOWED_SDK_BUILTINS`, so a built-in a new SDK adds is never loaded; if that option regressed, the classifier still refuses any non-`mcp__` name off the allowlist, whatever its spelling. `tool-allowlist-real-sdk.e2e.test.ts` fails on the bump until the new name is added to `KNOWN_SDK_BUILTINS`.
- **Only AX's own skills can be invoked (TASK-1207).** The CLI ships skills inside its binary, and the allowlisted `Skill` tool would open them right next to AX's. Two are switched off at the source (`bundled-skills-env.ts`): `loop`, which schedules with `CronCreate` the agent doesn't have, by `CLAUDE_CODE_DISABLE_CRON`; and `claude-api` by `CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL`. Nothing switches off the rest (`update-config`, `simplify`, `init`, `review`, …). So the PreToolUse hook refuses any `Skill` call whose name isn't a folder in AX's projection under `$CLAUDE_CONFIG_DIR/skills/`, read once at boot. If it can't read the projection it fails closed, and the refusal says the agent's skills couldn't be read. That also covers skills a future CLI adds. The tempting alternatives, measured on CLI 2.1.119, don't work: `skillOverrides: 'off'` does nothing, `query()` never sends the session `skills` allowlist, `CLAUDE_CODE_ENTRYPOINT=local-agent` also switches on the CLI's env scrubbing, and bare mode drops AX's skills too. `bundled-skills-real-sdk.e2e.test.ts` pins, on the real binary: `loop` and `claude-api` are missing from a session configured like `main.ts`, `Skill('loop')` is unknown to the CLI, `update-config` and `/init` are refused before the host is asked, and an installed AX skill still launches. The fail-closed read is unit-tested (`projected-skills.test.ts`). The dead ends above were measured once and nothing re-checks them.
- **Two ways a bundled skill still runs (measured, CLI 2.1.119).** An AX skill that shares a bundled skill's name (say `simplify`) passes the folder check, and the CLI launches its own `simplify`, not ours. And a person's chat message that starts with `/update-config` expands that bundled skill with no `Skill` call at all, so the hook never sees it. Neither adds reach: a skill is only instructions, and the model still has exactly this session's tools, each checked by `tool.pre-call`. Reserving the CLI's skill names when an AX skill is created would close the first.
- **`allowedTools` / `disallowedTools` and the `settingSources` veto-set are contracts, not firewalls.** A future Anthropic-introduced built-in stays out until someone adds it to `ALLOWED_SDK_BUILTINS` on purpose (see above). Likewise, the `'user'` setting source is what the SDK currently reads — if a future SDK version pulls in additional sources (machine-wide, organization, …) or starts reading a NEW file from its cwd regardless of `settingSources`, that's a regression the real-binary §11 canary is there to catch on the SDK bump. The runner unit test asserts `options.settingSources` is `['user']` and `options.allowedTools` contains `'Skill'` (with `'Skill'` explicitly NOT in `disallowedTools`) on every `query()` call, so a regression in our wiring fails the suite — but a regression inside the SDK itself could still be silent.
- **Sub-agent IPC identity is unsolved.** `Task` is disabled today. When we enable sub-agents, each needs its own session identity / auth token so a compromised sub-agent can't impersonate its parent on the IPC bus. That's a Week 9.5+ design item.
- **Peer-dep version skew.** We ship `zod@^3` and the SDK peer-requires `zod@^4`. Things work in practice, but a Zod-4-only API in the SDK surface would break us. When Week 13+ lands OpenAI / Gemini runners that want a unified zod version, bump together.

## Boundary review

- **Alternate impl this hook could have:** not a new hook — this package consumes existing hooks (`tool.pre-call`, `event.tool-post-call`, `session:claim-work`, `chat:...`). An alternate "run an agent on Anthropic Claude" implementation is what the IPC contract is designed for; any future runner that satisfies the same hook surface drops in without changes elsewhere.
- **Payload field names that might leak:** none new. IPC payload shapes come from `@ax/ipc-protocol`, which is LLM-neutral. We map claude-sdk vocabulary (`PreToolUse`, `PostToolUse`, `mcp__<server>__<tool>`) into the neutral hook shape inside this plugin; the wire bus never sees claude-sdk-specific names.
- **Subscriber risk:** none — this plugin is mostly a consumer of hooks, not a producer of new ones. The MCP server it exposes is internal to the claude-sdk query() call and not a cross-plugin boundary.
- **Wire surface:** the env-var contract (exactly one of `AX_PROXY_ENDPOINT` or `AX_PROXY_UNIX_SOCKET` alongside `AX_RUNNER_ENDPOINT`, `AX_SESSION_ID`, `AX_AUTH_TOKEN`, `AX_PROXY_TOKEN`, `AX_USERFILES_ROOT` (the agent's home), `AX_EPHEMERAL_ROOT` (the session scratch root) and `CLAUDE_CONFIG_DIR`) is documented in `@ax/agent-runner-core`'s `env.ts` and carried into the child via the sandbox-provider's fixed env allowlist. No new IPC actions.

## What we don't know yet

- Whether the SDK reads some file from its cwd (the agent's home) by a code path we didn't trace, whatever `settingSources` says. The LOW-confidence hedge in `docs/notes/2026-05-17-sdk-setting-sources-audit.md` covers this: the §11 real-binary canary plants every file we know the SDK can load and checks that none takes effect, but a file outside that list would slip past until the next SDK-bump re-audit catches it.
- Whether `Bash` subprocess output is ever buffered in a way we don't see before it flows to the model. `event.tool-post-call` fires on `PostToolUse`, which is after the SDK has the output — but the SDK gets to decide what exactly it shows the model. Subscribers that want to redact MUST operate on `llm:pre-call` too if they care about what the model actually saw.
- The exact supply-chain posture of every transitive dep the SDK pulls in. We've reviewed the direct deps (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, platform-specific CLI binaries) and the maintainer set, but we haven't walked every node_modules entry. The lockfile is committed; re-audit on every SDK bump.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
