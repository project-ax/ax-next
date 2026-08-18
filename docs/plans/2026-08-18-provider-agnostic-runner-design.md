# Provider-agnostic agent runner — design

**Date:** 2026-08-18. **Owner:** Vinay. **Status:** Design approved, impl plan pending.

This spec fixes the shape of a **second agent runner** that can drive any model on
OpenRouter or Vertex AI, running alongside `@ax/agent-claude-sdk-runner` with
per-agent selection. It also specifies the `@ax/agent-runner-core` extraction that
makes two runners affordable to maintain.

---

## Source of truth

- **Current architecture:** `docs/plans/2026-05-24-current-architecture.md` — host/runner
  split, IPC boundaries, transcript source-of-truth.
- **Founding runner design:** `docs/plans/2026-04-24-week-6.5-agent-sandbox-design.md` —
  Section "Runner comparison" and slices 6.5b/6.5c/6.5d. This design finishes an
  intent that doc already had: pluggable runners, pluggable providers.
- **Project conventions:** `CLAUDE.md` — the six invariants, half-wired policy,
  boundary review, bug-fix policy.
- **Memory:** `feedback_half_wired_window_pattern.md` (load the new plugin in CLI +
  k8s preset in the same PR), `feedback_yagni_check_in_plans.md` (audit each task for
  load-bearing at MVP), `feedback_auto_ship_design_doc_on_origin_main.md` (this doc
  must be on `origin/main` before cards citing it are dropped on the board).

---

## Goal

Full provider independence: stop depending on Anthropic's SDK for the agent loop, so
any model — Claude, Gemini on Vertex, grok, kimi, or whatever ships next quarter — is
a per-agent configuration choice rather than an architectural commitment.

Both runners ship. The agent row picks one. They must be **host-indistinguishable**:
same IPC events, same transcript contract, same workspace choreography, same security
policy. That constraint is the point — it is the "does the runner boundary actually
hold?" check the 6.5 design wanted, and it is what keeps a second runner from becoming
a second architecture.

## Non-goals

- Replacing `@ax/agent-claude-sdk-runner`. It stays; Claude models keep Anthropic's
  tuned harness.
- Cross-runner transcript translation (see §5).
- A user-facing "bring your own agent" runner. Considered and rejected (see
  "Rejected: ACP").

---

## Decision record

Three approaches were evaluated.

**A — extract `@ax/agent-runner-core`, add a runner built on the Vercel AI SDK.**
Chosen.

**B — host-side Anthropic-format gateway** (revive the deleted
`@ax/llm-proxy-anthropic-format`, point the SDK runner at it via `ANTHROPIC_BASE_URL`).
Cheapest by far, and recoverable from commit `0228e610`. Rejected as the *answer*
because it does not deliver provider independence: we would still be running
Anthropic's SDK and its Claude-tuned harness, inheriting its prompt and tool protocol
while non-Claude models degrade against them. Remains available as a de-risking spike
if we ever want a cheap read on model behaviour.

**C — adopt an existing OSS coding-agent framework** (pi-coding-agent, or an ACP brain
such as `@agentclientprotocol/codex-acp`). Rejected on evidence — see below.

### Why not pi

v1's `~/dev/ai/ax/src/agent/runners/pi-session.ts` (723 lines) is the reference
implementation, and it argues against the approach:

- v1 got **zero tools** from pi. It passed `tools: []` with `customTools: ipcToolDefs`,
  and routed sandbox tools to its own `local-sandbox.ts` (503 LOC), because every tool
  call had to pass the host audit gate. v2's constraint is stronger.
- v1 got **zero transcript persistence** from pi (`SessionManager.inMemory()`, history
  rehydrated per turn).
- v1 had to patch pi's private state to function:
  `(session as any)._baseSystemPrompt = systemPrompt`, with a comment citing a line
  number in someone else's compiled JS, plus a dummy `AuthStorage` entry.
- What pi actually provided was the loop — the smallest and most stable part of the job.

`@mariozechner/pi-coding-agent` is also at 0.73.1 with 271 pre-1.0 releases and no
publish since 2026-05-07.

### Why not ACP (measured, not assumed)

`@agentclientprotocol/sdk` 1.3.0 has a method surface that looks tailor-made for us —
`fs/read_text_file`, `fs/write_text_file`, `terminal/*` are *client*-side, and
`session/request_permission` looks like a `PreToolUse` veto. A probe against
`@agentclientprotocol/codex-acp` 1.4.0, driving `x-ai/grok-4.6` through a local gateway
that mimicked `@ax/credential-proxy`, found:

| Question | Result |
|---|---|
| Credentials: model reachable with only an `ax-cred:` placeholder? | **PASS** — 14 requests, all placeholder-only, all to our gateway |
| Model: arbitrary OpenRouter slug? | **PASS**, but ACP's own `availableModels` advertised only Codex's OpenAI catalog |
| File I/O through `fs/*`? | **FAIL** — zero `fs/*` calls; it edited the file with a `python3` heredoc inside a shell call |
| Tool-call veto via `session/request_permission`? | **FAIL** — 1 permission request for 9 tool calls; unprompted `npm install` egress |

Re-running with Codex's strictest posture (`approval_policy: untrusted`,
`sandbox_mode: read-only`, `INITIAL_AGENT_MODE=read-only`) still produced 1 request for
6 calls, and the file was still modified on disk. (Caveat: measured on macOS/Seatbelt;
Linux/Landlock may enforce differently, and a mis-set knob can't be fully excluded.
Codex's config parser is strict — it rejected `wire_api = "chat"` with a precise error —
so the keys were at least accepted as valid.)

**Conclusion: ACP is an observability surface, not an enforcement surface.** Tool calls
arrive as opaque shell strings, file writes happen inside them, and whether we are asked
is the agent's policy decision. Our security model (`PreToolUse` → hook-bus veto,
validator re-root, egress allowlist, audit) operates on structured tool inputs.

Also noted: Codex has dropped the Chat Completions wire protocol (`wire_api` must be
`"responses"`). OpenRouter does serve `/api/v1/responses`, so this works today — but it
is a live coupling to two vendors' protocol decisions.

### What made A cheaper than expected

`ai@7` ships `ToolLoopAgent` — the loop, with `stopWhen`, `abortSignal`, `timeout`,
`prepareStep`, `onStepStart`, `onToolExecutionStart`, `onToolExecutionEnd`, `onStepEnd`,
`onFinish`. It also ships `pruneMessages`, which does the pairing-safe surgery
compaction needs. Both were budgeted as hand-written work and are not.

### Model fidelity, measured

Five models were run against stubs of our six sandbox tools, on a task requiring
`glob → read → edit → bash` chaining, with a simulated `PreToolUse` veto (`npm` denied,
must switch to `pnpm`):

| Model | Task | Veto recovery | `edit` not `write` | Calls | Bad args | Natural stop | Time | Tokens |
|---|---|---|---|---|---|---|---|---|
| `x-ai/grok-4.6` | ✅ | ✅ | ✅ | 12 | 0 | ✅ | 14s | 10.6k |
| `moonshotai/kimi-k3` | ✅ | ✅ | ✅ | 9 | 0 | ✅ | 46s | 14.0k |
| `anthropic/claude-sonnet-5` | ✅ | ✅ | ✅ | 5 | 0 | ✅ | 15s | 10.3k |
| `google/gemini-3.7-flash` | ✅ | ✅ | ✅ | 7 | 0 | ✅ | 17s | 6.6k |
| `google/gemini-3.5-flash-lite` | ✅ | ✅ | ✅ | 5 | 0 | ✅ | 3s | 4.0k |

5/5, zero malformed tool arguments. The tool surface is not the bottleneck, and the
floor is low enough that cheap models are viable. One wrinkle: OpenRouter drops
reasoning blocks lacking signatures (provider issues #418/#423) — see §6/§7.

---

## §1 — Package topology

| Package | Kind | Role |
|---|---|---|
| `@ax/agent-runner-core` *(new)* | shared library, not a plugin | Everything a runner does that isn't the loop: workspace materialize/commit/bundle, transcript delta protocol, uploads, skills projection, proxy bootstrap, python venv, prompt composition, inbox loop, tool **policy** |
| `@ax/agent-claude-sdk-runner` *(slims)* | runner binary | Claude Agent SDK loop, its hook adapters, jsonl transcript locator. ~7.3k → ~3k LOC |
| `@ax/agent-aisdk-runner` *(new)* | runner binary | `ToolLoopAgent` loop, our tool set, provider-agnostic model call, compaction |

`runner-core` needs an entry in `eslint.config.mjs`'s `no-restricted-imports` allowlist,
with the same justification the existing `@ax/ipc-core` entry uses: transport/loop-agnostic
shared machinery, not a plugin. **Boundary-review item.**

Host-side changes:

- `agents` gains a `runner` column (`'claude-sdk' | 'aisdk'`), validated against an
  allow-list exactly as `model` is today (`packages/agents/src/store.ts:188`).
- `AgentConfig` gains `runner`. **`model` finally gets consumed** — it is frozen onto the
  session at `chat-orchestrator/src/orchestrator.ts:1346` and shipped on the wire at
  `ipc-protocol/src/actions.ts:460`, and no runner reads it. The admin model picker is
  currently decorative.
- `chat.runnerBinary` (a single path) becomes a map from runner id → binary. The agent row
  and IPC wire stay id-based; only the `sandbox:open-session` call carries a path, as it
  does today (`sandbox-protocol/src/schemas.ts:292`). Leak surface unchanged.
- Both runner binaries ship in the sandbox image.

Per the half-wired policy, the new runner lands loaded in **both** the CLI and the k8s
preset in the PR that introduces it.

## §2 — The runner-core split

56% of the current runner (4,097 of 7,316 LOC) has no `@anthropic-ai/claude-agent-sdk`
import. Most of it moves wholesale; three files split along a seam.

**Moves to `runner-core`** (3,609 LOC): `git-workspace` (579), `installed-skills` (404),
`proxy-startup` (366), `prompt-engine` (315), `skill-propose-executor` (254),
`commit-notify-resync` (250), `artifact-publish-executor` (245), `attachment-translation`
(198), `python-venv` (189), `materialize-uploads` (177), `env` (149), `inbox-loop` (149),
`local-dispatcher` (75), `proxy-ca-from-env` (69), `home-bin-env` (60), `tty-hint-env` (56),
`tool-cache-env` (31), `commit-trace` (24), `identity-templates` (19).

**Stays SDK-side** (738 LOC plus the loop): `host-mcp-server` (202),
`sandbox-mcp-server` (124), `tool-names` (89, `DISABLED_BUILTINS` names SDK built-ins),
`telemetry-env` (67), `can-use-tool` (65), `turn-end-uuid` (191).

**`main.ts` (1,827)** is neither, and needs its own pass. It is mostly boot orchestration —
env read, IPC client construction, workspace materialize, uploads, skills projection, inbox
wiring, turn-end commit and flush, `event.chat-end` emission — with the SDK `query()` options
literal and the message loop embedded in the middle. The orchestration becomes a
`runRunner(hooks)` shell in core parameterized over a `Loop` interface; each runner supplies
its loop. Expect roughly two-thirds to move. This is the least mechanical part of the
extraction and should be reviewed line by line rather than trusted to a bulk move.

**The three that split cleanly:**

1. **`pre-tool-use.ts` (420)** — the validator re-root policy, `broaden`/`recognizedRoots`
   logic, and hook-bus veto forwarding go to core; a ~40-line adapter mapping the SDK's
   `PreToolUse` signature stays. The new runner calls the same policy from inside each
   tool's `execute`. **This is the load-bearing move**: it makes "one security policy, two
   runners" true rather than aspirational.
2. **`post-tool-use.ts` (154)** — same shape. Egress-block draining and note injection to
   core; hook adapter stays.
3. **`transcript-delta.ts` (297)** — the offset/`prefixHash`/resync protocol is core.
   `locateJsonl()` is SDK-specific (it readdir-walks `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/`
   because the slug is the SDK's private encoding of `realpath(cwd)`). Core defines a
   `TranscriptSource` interface; the SDK runner implements it with that walk, the new
   runner by serializing its own message array.

**Sequencing:** the extraction ships as its own PR with **no behaviour change and no new
runner**. The existing suites plus the canary acceptance test are the proof. The new
runner is a purely additive second PR.

**Risk:** this refactors code carrying hard-won edge cases (F2a resume guards, TASK-164
re-root broadening, `scaffoldSdkProjectsSymlink`). Mitigated by the behaviour-free
constraint and by not combining it with new-runner work.

## §3 — Tool set and permission path

Four groups, all plain entries in the `tools` object handed to `ToolLoopAgent`:

| Group | Source | Execution |
|---|---|---|
| Built-ins — `Bash` `Read` `Write` `Edit` `Glob` `Grep` | ours to implement | in-sandbox |
| Host tools (`executesIn: 'host'`) | `tool.list` catalog | `tool.execute-host` IPC |
| Sandbox tools (`executesIn: 'sandbox'`) | `tool.list` catalog | locally |
| `Skill` | §4 | in-process |

The 326 LOC of MCP shims (`host-mcp-server.ts`, `sandbox-mcp-server.ts`) are not needed —
they exist only to make our catalog look like MCP servers to the SDK. User-configured MCP
servers still arrive host-side through `@ax/mcp-client` in `tool.list`.

`DISABLED_BUILTINS` (`WebFetch`, `WebSearch`, `Task`, `AskUserQuestion`) stops being a
deny-list and becomes "not registered". Web capability is unaffected — `@ax/web-tools`
supplies `web_search`/`web_extract` as host tools. `AskUserQuestion` stays absent per PR #331.

**Permission path — one choke point.** Today there are two, with a documented gap:
`pre-tool-use.ts` notes that `canUseTool` "only fires when the CLI decides a tool needs a
permission prompt — built-ins like Bash with benign input don't reach it", which is why the
`PreToolUse` hook is the real gate. The new runner owns every `execute`:

```
execute = async (input) => {
  const verdict = await policy.preToolUse(name, input)   // core: re-root, veto, hook bus
  if (verdict.denied) return verdict.reason              // a tool RESULT, not a throw
  const out = await run(verdict.input ?? input)          // re-rooted input
  await policy.postToolUse(name, out)                    // egress notes, event.tool-post-call
  return out
}
```

Two deliberate choices:

- **Vetoes return as tool results, not exceptions.** All five models tested read a denial
  reason and complied on the next call. Throwing would abort the turn; returning text keeps
  the agent working, which is what the existing egress-block remediation notes assume.
- **Inputs stay structured**, so the validator re-root sees real paths — precisely what the
  ACP probe could not offer.

**Not supported: skill-declared in-sandbox MCP servers.** The `mcpServers` grammar from
PR #113 materializes a per-skill `.mcp.json` that only the Anthropic SDK knows how to
discover, and `ai@7` exports no MCP client. Building an equivalent would cost ~150–250 LOC
over `@modelcontextprotocol/sdk` plus a new dependency inside the sandbox. **Decision: don't
build it.** The evidence says the capability is unused — no `SKILL.md` in the repo declares
`mcpServers` (the one grep hit, `ax-connector-creator`, only discusses the grammar in prose
because it teaches connector authoring). Crucially this does **not** affect connectors:
connector-backed MCP servers run host-side in `@ax/mcp-client` and reach both runners through
`tool.list` as ordinary host tools. The gap is limited to a user-installed skill that ships
its own stdio MCP server.

**Degradation must be visible, not silent.** A skill whose declared MCP servers are
unavailable stays discoverable, but the `Skill` tool's response appends a note saying its MCP
servers are not available on this runner and the tools it describes will not exist. That
mirrors the existing egress-block remediation-note pattern: tell the model about the
constraint at the moment it matters, so it adapts rather than hallucinating tools. The runner
also logs it once at projection time. If this capability is ever adopted for real, the client
can be added later behind the same policy wrapper.

## §4 — Skills without the SDK's `Skill` tool

Nearly all of this already works, because the projection happens before any SDK exists.
`installed-skills.ts` (moving to core) reads `AX_INSTALLED_SKILLS_JSON`, writes each bundle
to `$CLAUDE_CONFIG_DIR/skills/<id>/`, re-validates every path at the extract boundary, and
chmods the parent to `0555`. Only the last mile is SDK-specific: `settingSources: ['user']`
and the built-in `Skill` tool.

Replacement, two parts:

1. **Discovery → system prompt.** At boot, walk the projection, parse each `SKILL.md` with
   `@ax/skills-parser` (`parseSkillManifest` / `splitSkillMd` — already on the eslint
   allowlist for exactly this kind of sharing), and inject a compact `name + description`
   index into the composed prompt. Descriptions always present, bodies on demand.
2. **`Skill` tool → progressive load.** `inputSchema: { name }`; returns the body plus the
   bundle directory path so the model can `Read`/`Bash` within it. Wrapped in the same policy
   as every other tool. If the skill declares `mcpServers`, the response also carries the
   unavailability note from §3.

Security properties are unchanged and must be restated in the PR: the `0555` projection under
`$CLAUDE_CONFIG_DIR` remains the **sole** discovery path. We do not read `.claude/skills/`
from the workspace — it is agent-writable and pass-through in `@ax/validator-skill`, which is
why `settingSources` dropped `'project'` in Phase 3. Host-side quarantine scan, `approved_caps`
intersection, and the authored-skill approval window are untouched.

**Deferred:** `TodoWrite` — an SDK built-in with no host-side consumer. Trivial to add later
if it proves to matter for long-task behaviour.

## §5 — Transcript format and resume

**Format:** newline-delimited JSON, one AI SDK `ModelMessage` per line, preceded by a header
line `{"v":1,"runner":"aisdk"}`. Line-oriented because the delta protocol is seq-based
(`fromSeq`, `maxSeq`, `prefixHash`).

**No file on disk.** The SDK runner's transcript machinery exists to chase a file the SDK
owns — the `locateJsonl` walk, `scaffoldSdkProjectsSymlink`, and `waitForTranscriptUuid`. The
new runner holds messages in memory and serializes at the turn boundary.

**This deletes a race, not just code.** `waitForTranscriptUuid` exists because the SDK flushes
jsonl asynchronously and the turn-end commit had to gate on bytes landing — the lineage behind
TASK-11/PR #163 and the F-1/F-2 re-sync work. When the runner owns the messages, durability is
a function return and `commitTurnAndBundle` runs immediately.

**Resume:** `session.get-transcript` → parse → seed the message array → continue. The F2a guard
carries over in spirit: a bound session with no resumable transcript demotes to fresh.

**Runner switch:** if an agent's `runner` changes between turns, the stored transcript is in the
other format. The header line makes that detectable; on mismatch we take the demote-to-fresh
path. Cross-runner translation is explicitly out of scope — it would be a lossy mapping between
two vendors' message shapes. Display history (`conversations:append-event`) is structured and
runner-neutral, so the user still sees the whole conversation either way.

**Compaction interplay:** the compactor calls `session.replace-transcript` explicitly rather
than letting a rewrite trip the `prefixHash` mismatch → `resync-required` path. That path stays
the safety net it was designed to be.

## §6 — Model, provider, and credentials

**Model identity:** a `/`-prefixed id — `openrouter/x-ai/grok-4.6`, `vertex/gemini-3-pro`,
`anthropic/claude-sonnet-5` — validated against the per-agent allow-list. The AI SDK's
`createProviderRegistry(providers, { separator: '/' })` parses it: `splitId` uses
`indexOf` (first occurrence) and `slice(index + separator.length)`, so nested vendor slugs
survive intact.

`/` over `:` because **OpenRouter already uses `:` as its own variant delimiter** — 79 of 414
models carry one (`:free`, `:batch`, `:thinking`), e.g. `google/gemini-3.7-flash:batch`. A colon
prefix would give one character two meanings in one string; anything doing `split(':')[-1]`
would silently yield `batch`. Secondary: our tooling runs under zsh, where `:` after a parameter
expansion is a modifier (see `feedback_bash_tool_runs_zsh_colon_modifier.md`).

The one thing `:` bought — visual distinction from a raw OpenRouter slug — is already covered by
allow-list validation at write time.

**Legacy rows** (bare `claude-sonnet-4-6`) are normalized to `anthropic/<id>` by migration. No
runtime "no slash means Anthropic" fallback: an implicit fallback re-introduces the ambiguity.

`models:list-supported` (today registered only by `@ax/llm-anthropic`) gains registrants per
provider so the admin picker becomes real.

**Credentials — OpenRouter is nearly free.** The existing mechanism is keyed by env name, not
vendor: `proxy:open-session({ credentials: { OPENROUTER_API_KEY: { ref } } })` resolves via
`credentials:get`, mints an `ax-cred:<32-hex>` placeholder (`credential-proxy/src/registry.ts:29`),
and the MITM proxy substitutes mid-flight. Add `openrouter.ai` via `proxy:add-host`. Same code
path as `ANTHROPIC_API_KEY` today — confirmed end-to-end by the spike.

**Vertex is the one new piece.** It wants short-lived OAuth bearers. Chosen approach: a host-side
token minter plus `proxy:rotate-session`, which already exists and whose contract is exactly this.
Needs a new credential kind for GCP service accounts (`credentials:list-kinds` is the extension
point). Fallback if token rotation races badly with in-flight requests: a terminating gateway that
re-signs, as built for the spike.

**Provider construction:** each provider is built with a custom `fetch` carrying the placeholder
and honouring the `HTTPS_PROXY` that `proxy-startup.ts` already sets. No provider SDK may perform
its own auth discovery — in particular `@ai-sdk/google-vertex` must **not** fall back to
Application Default Credentials, which would authenticate from inside the sandbox. Explicit
injection only. **Security-checklist item.**

**Reasoning blocks:** for non-Anthropic providers, strip reasoning from prior turns before
re-sending (`pruneMessages({ reasoning: 'before-last-message' })`), per OpenRouter issues #418/#423.

## §7 — Compaction

**Where:** `prepareStep` on `ToolLoopAgent` — per-step message rewriting.

**Trigger:** `usage.inputTokens` from the previous step against the model's context window, at
0.5–0.7. No tokenizer needed; the provider reports it every step.

**Ladder, cheapest first:**

1. **Mask stale tool outputs** — superseded tool results collapse to a short marker with a small
   token budget. No LLM call, no information the model still needs.
2. **Prune** — `pruneMessages({ reasoning: 'before-last-message', toolCalls: 'before-last-N-messages',
   emptyMessages: 'remove' })`. Pairing-safe surgery; also the §6 reasoning fix.
3. **Summarize** — preserve the newest ~30% verbatim plus the first user message, summarize the
   rest, splice in a synthetic message, persist via `session.replace-transcript`.

**Failure handling.** Gemini CLI (Apache-2.0) names the traps and we adopt them: summary larger
than what it replaced, empty summary, token-count error. On any of these: **do not retry in a
loop** — mark the attempt failed, fall through, and if the ceiling is genuinely reached, fail the
turn with a clear message rather than thrashing. Its policy constants are a reasonable starting
point (`threshold 0.5`, `preserve 0.3`, per-tool-response budget).

**Summarizer model:** the agent's own model by default, cheap override optional. Defaulting avoids
new credential or allow-list surface.

**Boundary with `@ax/memory-strata`** (invariant 4): the compactor owns *in-turn* context and
writes only to the transcript. Strata owns *cross-conversation* memory off `chat:end`. The
compactor does not write into strata; strata does not read compaction summaries.

**Licensing note:** `opencode-acp` ("Active Context Pruning") is **AGPL-3.0-or-later** and must not
be used. `ai`'s `pruneMessages` (Apache-2.0) is the dependency; Gemini CLI is a reference to read,
not a dependency.

**Scope:** v1 ships rungs 1–2 plus a clean ceiling error; rung 3 follows immediately. With grok at
500k and kimi at 1M context, this is not launch-blocking.

**Eval:** reuse the memory-strata bench discipline — long sessions where a question must still be
answerable *after* compaction fires. The risk is quality, not code.

## §8 — Parity acceptance bar

Invariant 3 sets the floor: **the canary runs twice.** The acceptance and e2e suites are
parameterized over runner id, and both must pass before the runner PR lands.

Parity checklist, each an assertion: workspace materialize → commit → bundle across turns ·
uploads materialization and attachment translation · installed-skill discovery and invocation ·
authored-skill proposal via `skill.propose` · artifact publish · resume across turns and after a
warm rebind · sandbox death mid-turn producing `chat:turn-error` and a retryable UI · egress-block
remediation notes · routine-triggered invocation · host tools and connector/user MCP tools from
the catalog.

Beyond the automated suite: a `chat-qa-sweep` run against an agent pinned to the new runner, and a
`k8s-acceptance-loop` walk, since the pod path is where runner spawn differences surface.

**Documented non-parity** (in the PR description and the runner README): `TodoWrite` absent;
cross-runner resume demotes to fresh; SDK-specific setting sources do not exist;
**skill-declared in-sandbox MCP servers are unsupported** and degrade with an agent-visible
note (§3). Connector-backed MCP servers are unaffected — they are host-side.

The acceptance suite asserts the *degradation*, not the capability: a skill declaring
`mcpServers` must still load on the aisdk runner and must carry the note.

---

## Sequencing

| # | PR | Gate |
|---|---|---|
| 1 | `@ax/agent-runner-core` extraction | No behaviour change; existing suites + canary green |
| 2 | Host-side runner + model selection (`agents.runner`, orchestrator map, `AgentConfig`, migration) | Model picker drives a real value on the SDK runner |
| 3 | `@ax/agent-aisdk-runner` — loop, tools, policy wiring, transcript | Canary green on both runners; loaded in CLI + k8s preset |
| 4 | Provider layer — OpenRouter credential path + `models:list-supported` | grok-4.6 / kimi-k3 drive a real conversation on the cluster |
| 5 | Vertex — credential kind, token minter, rotation | Gemini on Vertex, no ADC reachable from the sandbox |
| 6 | Compaction rungs 1–2 + ceiling error | Long session degrades cleanly |
| 7 | Compaction rung 3 (summarize) + eval suite | Post-compaction answerability holds |

## Open risks

- **The extraction is the riskiest PR**, not the new runner. It touches code with subtle
  edge-case history and its safety rests on existing test coverage being honest.
- **Vertex token rotation** may race with in-flight requests; the terminating-gateway fallback
  exists but doubles the egress shapes we maintain.
- **Two runners means every future runner-side feature lands twice.** Accepted deliberately; the
  `runner-core` split is the mitigation, and its boundary needs policing in review.
- **Reasoning-block round-tripping** through OpenRouter is lossy today. Fine for tool-driving;
  needs a decision before shipping reasoning UI on non-Anthropic models.
