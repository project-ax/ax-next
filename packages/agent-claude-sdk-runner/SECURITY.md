# Security — `@ax/agent-claude-sdk-runner`

This package is the sandbox-side runner that wraps `@anthropic-ai/claude-agent-sdk`. It spawns the `claude` CLI as a subprocess, bridges the SDK's tool hooks into our host-side IPC (`tool.pre-call`, `event.tool-post-call`), and serves host-mediated tools via an in-process MCP server. Everything it does runs **inside** the sandbox boundary — this process is the untrusted one. This note captures the `security-checklist` walk for the Week 6.5d landing.

## Security review

- **Sandbox:** The runner is on the sandbox side of the trust boundary. Its only reach OUT of the sandbox is (a) the IPC endpoint it was handed via `AX_RUNNER_ENDPOINT` + `AX_AUTH_TOKEN`, which carries auth-gated service calls, and (b) the credential-proxy endpoint — either `AX_PROXY_ENDPOINT` (subprocess sandbox: TCP loopback, set as `HTTPS_PROXY`) or `AX_PROXY_UNIX_SOCKET` (k8s sandbox: the runner starts a local TCP-to-unix bridge so off-the-shelf libraries can dial it). In both modes the SDK calls `api.anthropic.com` directly; the credential-proxy intercepts the request and substitutes the `ax-cred:<hex>` placeholder for the real Anthropic key (held only on the host) mid-flight. The runner never sees the real key. The runner does NOT spawn processes directly — that's the SDK's job — and the CLI's descendant tree (the `claude` CLI, its Bash / Read / Edit tool subprocesses, anything those spawn) stays inside the sandbox filesystem and process namespace. Isolation holds because the sandbox-provider plugin (subprocess today, k8s / docker later) owns the fence, not this runner. Tool reach is constrained two ways: disabled built-ins (`WebFetch`, `WebSearch`, `Skill`, `Task`) are blocked via `disallowedTools` AND again in the tool-name classifier as defense in depth; enabled built-ins (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `TodoWrite`) run with `cwd` pinned to `workspaceRoot`. `settingSources: []` is passed explicitly so the SDK does NOT read `~/.claude`, project settings, or any CLAUDE.md — all config arrives through host-mediated IPC instead. EVERY tool call (built-in AND MCP-host) fires `tool.pre-call` via the SDK's `PreToolUse` hook, giving the host veto / rewrite authority before any execution. Every call also fires `event.tool-post-call` for observation.

- **Injection:** LLM output flows through our proxy, not directly to Anthropic — host-side subscribers on `llm:pre-call` / `llm:post-call` can intercept. Tool output — the raw stdout/stderr / return values from `Bash`, `Read`, an MCP tool result — is untrusted (invariant I5) and flows back into the SDK's model context via the SDK's internal transcript. Our host sees that output via `event.tool-post-call` on the IPC bus; subscribers there treat it as untrusted and scan / scrub / veto accordingly. Inside THIS package, tool output from the SDK is never interpolated into a shell command, file path, SQL query, or URL before it crosses back into the host via IPC — we forward the argument object and result as opaque `unknown` through the structured IPC channel, which serializes as JSON. Host MCP tool arguments arrive from the SDK as an object and are forwarded to the host as-is — the host's own tool handler is what ultimately decides what to do with them, and it already treats its input as untrusted.

- **Supply chain:** One new runtime dependency: `@anthropic-ai/claude-agent-sdk`, exact-pinned to `0.2.119`. `npm view @anthropic-ai/claude-agent-sdk@0.2.119 scripts` returned empty — no `preinstall` / `postinstall` / `prepare` / `install` hooks run at `pnpm install` time. Direct deps: `@anthropic-ai/sdk@^0.81.0`, `@modelcontextprotocol/sdk@^1.29.0`. Maintainers are all `*-anthropic` npm accounts (plus long-standing contributors with anthropic.com emails). Platform-specific optional binaries (`claude-agent-sdk-{darwin,linux,win32}-{arm64,x64}[-musl]`) carry the `claude` CLI binary per platform — same integrity-hashed `.tgz` shape as the parent. Peer-dep: the SDK peer-requires `zod@^4.0.0`; we ship `zod@^3.23.8`, which produces a peer-dep warning. Runtime works today (Zod v3's compat story + the SDK's passthrough-shape pattern), but we accept the warning consciously rather than silently.

## `@anthropic-ai/claude-agent-sdk` pin posture

- Current specifier: `0.2.119` (exact-pinned; bump intentional). The SDK is pre-1.0 and shipping frequently, so we expect to bump often — but each bump is a deliberate act, not a silent pickup via caret range. Re-run `security-checklist` on every bump.
- Upgrade procedure: use `pnpm add @anthropic-ai/claude-agent-sdk@<new-exact-version>` in `packages/agent-claude-sdk-runner`, re-run the Week 6.5d acceptance test (`pnpm --filter @ax/cli test claude-sdk-runner`), and re-run `security-checklist` on the new dep tree. A new SDK can bring new built-in tool names — if any escape the sandbox's intent, extend `DISABLED_BUILTINS` in `tool-names.ts` before shipping.

## Disabled built-ins (why)

- **`WebFetch`** — uncontrolled network egress from inside the sandbox. Network policy is a sandbox-provider concern, and the subprocess sandbox can't enforce it today.
- **`WebSearch`** — same reason as `WebFetch`, plus search result content is a prime prompt-injection vector if the sandbox were to fetch and inline it.
- **`Skill`** — the SDK's `Skill` tool loads user settings and CLAUDE.md from disk. We explicitly pass `settingSources: []` to prevent that, and disabling the tool is the belt to that suspenders.
- **`Task`** — spawns sub-agents with fresh sessions. Sub-agent capability scoping (each sub-agent should have its own IPC identity, not inherit the parent's) is a Week 9.5+ design concern, not something we'd want to accidentally enable.

## Enabled built-ins

`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `TodoWrite`. All filesystem-scoped to `cwd = workspaceRoot` (set on the `query()` call). `Bash` gets the same process-spawn constraints as the sandbox-provider imposes on the parent — the subprocess sandbox today means "same uid, same network stack, same filesystem"; the k8s sandbox (Week 7–9) will tighten that. `TodoWrite` writes into the SDK's in-memory session state, not disk.

## Known scope limits

- **We haven't audited every SDK built-in's permission model individually.** We trust the SDK's `disallowedTools` flag plus our classifier's defense-in-depth check. If a future SDK version adds a NEW built-in we haven't seen, our allowlist would let it through as `{kind: 'builtin'}` and the host would see it in `tool.pre-call`. That's fine for audit but a surprise for deny-by-default callers — document the delta when bumping the SDK.
- **`settingSources: []` is a contract, not a firewall.** If the SDK silently regressed and re-enabled one of those sources despite the empty array, `~/.claude` and CLAUDE.md would become reachable from the sandbox. The runner unit test asserts `options.settingSources` is `[]` and `options.systemPrompt` is `{ type: 'preset', preset: 'claude_code' }` on every `query()` call, so a regression in our wiring would fail the suite — but a regression inside the SDK itself could still be silent.
- **Sub-agent IPC identity is unsolved.** `Task` is disabled today. When we enable sub-agents, each needs its own session identity / auth token so a compromised sub-agent can't impersonate its parent on the IPC bus. That's a Week 9.5+ design item.
- **Peer-dep version skew.** We ship `zod@^3` and the SDK peer-requires `zod@^4`. Things work in practice, but a Zod-4-only API in the SDK surface would break us. When Week 13+ lands OpenAI / Gemini runners that want a unified zod version, bump together.

## Boundary review

- **Alternate impl this hook could have:** not a new hook — this package consumes existing hooks (`tool.pre-call`, `event.tool-post-call`, `session:claim-work`, `chat:...`). An alternate "run an agent on Anthropic Claude" implementation is what the IPC contract is designed for; any future runner that satisfies the same hook surface drops in without changes elsewhere.
- **Payload field names that might leak:** none new. IPC payload shapes come from `@ax/ipc-protocol`, which is LLM-neutral. We map claude-sdk vocabulary (`PreToolUse`, `PostToolUse`, `mcp__<server>__<tool>`) into the neutral hook shape inside this plugin; the wire bus never sees claude-sdk-specific names.
- **Subscriber risk:** none — this plugin is mostly a consumer of hooks, not a producer of new ones. The MCP server it exposes is internal to the claude-sdk query() call and not a cross-plugin boundary.
- **Wire surface:** the env-var contract (exactly one of `AX_PROXY_ENDPOINT` or `AX_PROXY_UNIX_SOCKET` alongside `AX_RUNNER_ENDPOINT`, `AX_SESSION_ID`, `AX_AUTH_TOKEN`, and `AX_WORKSPACE_ROOT`) is documented in `env.ts` and carried into the child via the sandbox-provider's fixed env allowlist. No new IPC actions.

## What we don't know yet

- Whether the claude-sdk's internal prompt-assembly ever materializes a CLAUDE.md from somewhere we haven't disabled. `settingSources: []` is the documented contract and it works on the version we've tested; we haven't exhaustively probed it.
- Whether `Bash` subprocess output is ever buffered in a way we don't see before it flows to the model. `event.tool-post-call` fires on `PostToolUse`, which is after the SDK has the output — but the SDK gets to decide what exactly it shows the model. Subscribers that want to redact MUST operate on `llm:pre-call` too if they care about what the model actually saw.
- The exact supply-chain posture of every transitive dep the SDK pulls in. We've reviewed the direct deps (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, platform-specific CLI binaries) and the maintainer set, but we haven't walked every node_modules entry. The lockfile is committed; re-audit on every SDK bump.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
