# @ax/agent-aisdk-runner

The second agent runner. It drives the same agent loop as
`@ax/agent-claude-sdk-runner`, but on Vercel's `ai@7` `ToolLoopAgent` instead of
Anthropic's Agent SDK — which is what makes "which model runs this agent" a
per-agent configuration choice rather than an architectural commitment.

Both runners ship. An agent row picks one (`agents.runner`), the orchestrator
maps that id to a binary, and the sandbox spawns it. Everything either side of
the loop — workspace materialize/commit/bundle, uploads, the skills projection,
the proxy bootstrap, the transcript protocol, the turn-end events, the single
`chat:end` — lives in `@ax/agent-runner-core` and is shared.

Design: `docs/plans/2026-08-18-provider-agnostic-runner-design.md`.

## The part worth understanding

**Every tool call goes through one gate.** `wrapWithPolicy` (`src/tools/policy-wrap.ts`)
wraps the `execute` of every registered tool — the six built-ins, every host and
sandbox tool from the catalog, and `Skill` — around the shared `ToolPolicy` from
`@ax/agent-runner-core`. That policy re-roots governed paths and adjudicates the
call against the host's `tool.pre-call` hook, exactly as the SDK runner's
`PreToolUse` hook does. One security policy, two runners.

We assert that rather than trusting it: the assembled tool set is checked at boot
(`assertAllToolsWrapped`), so a tool added later on a bypass path fails to start
instead of quietly skipping the gate.

Two deliberate choices inside the wrapper:

- **A policy veto comes back as a normal tool result**, not an exception.
  Throwing would mark the call failed; returning the denial text lets the agent
  read it and take a different approach on the next call. (It is also what the
  existing egress-block remediation notes already assume.)
- **An executor failure does throw.** That is a different event — the tool was
  permitted and then broke. `ai@7` turns it into a `tool-error` part and an
  `error-text` result and keeps the loop going, so the model sees a failed tool
  and the host gets `is_error` for the UI.

**The transcript never touches disk.** The runner holds its messages in memory
and serializes them at the turn boundary (`src/memory-transcript-source.ts`).
This is not a micro-optimisation: the SDK runner's `waitForTranscriptUuid` exists
because the SDK flushes its jsonl asynchronously and the turn-end commit had to
poll for bytes to land — the lineage behind TASK-11, PR #163, and the F-1/F-2
re-sync work. Here durability is a function return. **Do not add a `beforeCommit`
wait to this runner**; its absence is the point.

**Compaction is a send-site transform, not a rewrite of history.** When a turn
approaches the model's context window, `prepareStep` masks stale tool outputs and
then drops old tool call/result pairs (`src/compaction/`). What it never does is
touch the transcript: those bytes are the host's source of truth, and rewriting
them to save room in one request would trade a recoverable context problem for an
unrecoverable history one. The stored conversation keeps growing while the sent
one does not — the ladder is deterministic, so the same stored messages compact
the same way on every step and every resume.

**Skills come from one place.** The read-only `0555` projection under
`$CLAUDE_CONFIG_DIR/skills/` is the sole discovery path. We never read
`.claude/skills/` from the workspace — that directory is agent-writable, which is
why the SDK runner dropped `'project'` from `settingSources` in Phase 3. Names
and descriptions go into the system prompt; bodies load on demand through the
`Skill` tool.

## Documented non-parity

These are the places this runner deliberately differs from
`@ax/agent-claude-sdk-runner`. Everything else is expected to behave identically,
and the parity suite (`src/__tests__/parity.e2e.test.ts`) is where that claim is
checked.

| Difference | What it means in practice |
|---|---|
| **`TodoWrite` is absent** | An SDK built-in with no host-side consumer. Nothing reads it today; trivial to add if long-task behaviour turns out to want it. |
| **Cross-runner resume rebuilds context, it does not inherit the transcript** | Switch an agent's runner mid-conversation and the next turn starts a new session — the two transcript formats are different and translating between them would be lossy in both directions, so we don't. What this runner *does* do is rebuild the conversational thread from the runner-neutral display log (`session.get-display-history`), so the agent keeps the thread even though it lost the runner-native transcript. It is text-only: the tool calls and results from those turns are gone, and the reconstruction says so in a note the model can read. **This is one-directional** — switching *away* to `claude-sdk` still starts blank, because that runner's transcript is an SDK-owned file and seeding it would mean hand-forging the SDK's private format. |
| **No SDK setting sources** | `settingSources`, `.claude/settings.json`, and the SDK's own config discovery have no counterpart here. Skills arrive through the projection above; everything else is runner-owned. |
| **Skill-declared in-sandbox MCP servers are unsupported** | A skill that ships its own stdio MCP server still installs and still loads, but its servers do not run. The `Skill` response says so explicitly, so the model adapts instead of hallucinating tools that will never exist. **Connector-backed MCP servers are unaffected** — those are host-side in `@ax/mcp-client` and arrive here as ordinary host tools. |
| **Compaction is lossier than the SDK's** | Both runners compact, differently. The SDK summarizes; this one masks stale tool output and then drops old tool call/result pairs (rungs 1-2 of design §7). Rung 3 — summarize — is PR 7. Until it lands, a very long session loses old tool output rather than having it condensed, and a conversation that cannot fit even fully compacted ends with a "start a new conversation" error instead of continuing. |

## Provider scope

Today: **Anthropic and OpenRouter**, driven through the AI SDK. The model ref is
a `provider/model-id` string (`anthropic/claude-sonnet-4-6`,
`openrouter/x-ai/grok-4.6`), parsed by `parseModelRef` in `@ax/core`. A ref
naming any other provider fails at boot with a message saying so — it is never
silently downgraded to Anthropic, because an agent explicitly configured for
another model must not quietly get this one.

Vertex (PR 5) plugs into `src/provider.ts` as one more entry. The construction is
already shaped for that: explicit credential injection, a custom `fetch` that
routes through the session credential-proxy and trusts its MITM CA, and **no
provider SDK doing its own auth discovery**. The runner never holds a real API
key — only the `ax-cred:<hex>` placeholder the proxy substitutes mid-flight.

## Layout

| File | Role |
|---|---|
| `main.ts` | The loop: env composition, boot self-check, tool assembly, the turn pump |
| `provider.ts` | Model ref → `LanguageModel`; the proxy-routed `fetch` |
| `tools/policy-wrap.ts` | The one permission choke point |
| `tools/builtins.ts` | `Bash` `Read` `Write` `Edit` `Glob` `Grep` |
| `tools/host-tools.ts` | Catalog tools with `executesIn: 'host'` → `tool.execute-host` |
| `tools/sandbox-tools.ts` | Catalog tools with `executesIn: 'sandbox'` → the local dispatcher |
| `tools/skill-tool.ts` | `Skill` — progressive load of a skill body |
| `skills-index.ts` | Discovery over the projection + the prompt index |
| `compaction/` | The context-window ladder on `prepareStep` (mask → prune → ceiling) |
| `memory-transcript-source.ts` | The in-memory `TranscriptSource`, plus `seedFromHistory` (cross-runner rebuild) |
| `transcript-codec.ts` | The ndjson format and its header line |
| `memory-transcript-source.ts` | The in-memory `TranscriptSource` |
| `user-message.ts` / `turn-blocks.ts` | The two translation edges to/from the host's vocabulary |
