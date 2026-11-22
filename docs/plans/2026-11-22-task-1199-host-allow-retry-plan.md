# TASK-1199: tell the agent a blocked host was allowed, and stop forbidding the retry

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** after a person allows a blocked host (web "Allow access" card or Slack host prompt), the agent's next turn in that session opens with a "now allowed" line, and the block note no longer tells it that retrying can never help.

**Architecture:** `@ax/credential-proxy` records each host `proxy:add-host` newly puts on a live session's allowlist, and a new service hook `proxy:drain-session-allowed-hosts` returns and clears them, with the session taken from `ctx.sessionId`. A new runner→host IPC action, `proxy.drain-allowed-hosts`, exposes that hook. The shared runner shell (`run-runner.ts`, used by both runners) drains it when it pulls each person's message and puts a `System message (not from the user):` line in front of that message's model-facing content. The block note in `egress-note.ts` is reworded so a retry after an Allow is expected.

**Tech Stack:** TypeScript, zod, vitest, pnpm workspace. No new dependencies.

**Spec:** the card [TASK-1199] (walk TASK-1192, `deploy/kind/walks/2026-11-22-TASK-1192/REPORT.md` row A.5) plus the orchestrator's binding constraints. Design rationale: this plan's Design section. Decisions: `.claude/memory/decisions/2026-11-22-TASK-1199.md`.

**Acceptance ("a host allowed between turns: the next turn's input carries the line and the retry succeeds")** is proven in two halves, joined by the Task 2 wire contract:
- Task 1's canary: through the real listener, block, then `proxy:add-host`, then the session's drain names the host once, and the retry returns 200.
- Task 4 `R1`: the shell's next turn starts with the exact line when the drain names the host.

**Tasks:** 6 (2 mechanical, 0 integration, 4 sensitive). Order: 1 → 2 → 3 → 4 → 5 → 6. Tasks 3 and 5 don't depend on the others.

## Premise check (verified in code at 5eaddd508)

- `proxy:add-host` (`packages/credential-proxy/src/plugin.ts:924-966`) widens only the live session `allowlist` Set. Nothing records the change or tells the runner.
- Web chat has the same gap. `routes-allow-host.ts` calls `proxy:add-host` (and `host-grants:grant` for "Always"). The client then drops the card. Nothing resumes the turn, and nothing reaches the model (`GrantRow.tsx` only calls `onGranted` for skills).
- The only egress text the model sees is `buildEgressBlockNote` (`packages/agent-runner-core/src/egress-note.ts:27-30`), injected after a builtin `Bash` call (`tool-policy.ts:204-227`). It says "This is NOT a transient error — retrying … will NOT help" and "stop retrying". Nothing later contradicts it.
- **What made the card look true:** the JIT design says the agent retries after a host grant (`docs/plans/2026-05-26-just-in-time-capabilities-design.md:104` "…no re-spawn; the agent retries." and `:135` "…+ model retries"). `GrantRow.tsx:111-113` and `:481-482` say a host grant needs no resume "because the agent never stopped". Neither was ever wired. TASK-37's plan listed the retry as a half-wired seam ("Seamless auto-retry is not built … the user re-prompts (or the model retries on its own)"), and #322's note then told the model not to retry. Task 5 fixes those four lines.

## Global Constraints

- A host Allow stays **session-scoped**. Whether a channel Allow should outlive its session is a product decision (follow-up 1). Do not add persistence or per-thread grants.
- Do not edit `packages/channel-slack/src/turn-note.ts`, channel-slack's "not remembered" code, or `docs/plans/2026-11-09-channel-slack-design.md`. TASK-1202/1203 are changing them.
- `proxy:add-host` stays host-internal. Never expose it over IPC.
- The new drain reads and clears only the caller's own session: `ctx.sessionId` (bearer-bound over IPC). The request body is `z.object({}).strict()` and never carries a sessionId.
- Hostnames reach model context only after the `SAFE_HOST_RE` filter, rendered as a backticked list inside fixed authored copy. The `System message (not from the user):` label is prepended, never interpolated.
- The line goes only into the model-facing turn content. It does not go into the display event log, `chatEndHistory` / `event.chat-end` `outcome.messages`, Slack, or the web UI.
- Best effort: a failed drain leaves the person's message unchanged and the turn runs. Write one operator stderr line, `runner: drain-allowed-hosts failed (continuing): <err.message>`, as TASK-732's turn-start drain did. Never throw.
- The drain runs only on `user-message` deliveries, not on `decision-resolved` turns.
- Copy strings are exactly the ones in Task 3.
- Run package tests as `pnpm --filter @ax/<pkg> test`, with the filter before the script.

## Review Focus

1. **The session ends between the Allow and the next message** (idle reap, skill respawn, connector change). The new session's allowlist doesn't have the host and there is no line. The reworded note's "If they ask you to try again, do." covers this: one retry raises a fresh card. Pinned by Task 1 `A7` (close forgets) and Task 3 `N7`.
2. **A repeated or stale Allow** (double click, web plus Slack, an old card for a host already allowed). The agent is told once, not again. Pinned by Task 1 `A2` and `A3`.
3. **A message with attachments and no typed text.** The line must come first and no empty text block is added. Pinned by Task 4 `R4`.
4. **A slow or failing host on the drain.** The turn must not stall past the short budget and must keep the person's words. Pinned by Task 2 `P4` and Task 4 `R2`.
5. **Several hosts allowed in one gap.** All are named once, in grant order. Pinned by Task 1 `A1b` and Task 3 `N2`.

---

## Design

### Approach (chosen): drain in the runner shell, at each person's turn

| Option | Why not |
|---|---|
| Host-side: chat-orchestrator drains when it queues the routed message, through a host-internal hook (no wire change) | It needs `sessionId` as a request field and an ownership rule that is wrong for shared Slack threads (the next writer may not be the session owner). It must run after ~10 retire decisions (`orchestrator.ts:3244-3330`). It drains at enqueue, so an Allow between enqueue and pickup is missed. It would also duplicate `SAFE_HOST_RE` and the system label in a host plugin, away from the block note it answers. |
| Put `allowedHosts` on the `session.next-message` delivery | Couples the inbox to the proxy, and changes the closed delivery union on the hottest IPC path. |
| Extend `proxy.drain-egress-blocks` | Two buffers with different timing in one call. A turn-start drain would also surface stale blocks. |
| channel-slack only | Web chat has the same gap, and the orchestrator constraint rules this out. |
| Wake a host-authored turn on Allow (like `decision-resolved`) | Product change. It contradicts Slack's "Ask me again". |
| claude-sdk `UserPromptSubmit` `additionalContext` | One runner only; aisdk has no equivalent. In the pinned CLI (0.2.119) the hook also doesn't fire for a message folded into a running turn (`queued_command`). |

The chosen path reaches both runners and every channel through one function. It is session-bound by construction. It drains at the moment the turn starts. It follows two shipped patterns: the `proxy.drain-egress-blocks` IPC drain (#322), and TASK-732's turn-start notice. TASK-732 drained `conversation.drain-save-refusals` at each person's turn. Its `prependNotice` put the labelled line in front of a string, or as the first block of an array, and kept it out of chat-end history. TASK-995 (b53bede91) removed it only because its subject went away (see `git show b53bede91^:packages/agent-runner-core/src/save-refused-notice.ts`, `:124-135`).

Where the line lands: the model's turn, plus the runner-side stored transcript, which is read back only on resume. It does not reach the display log (the orchestrator saves the person's turn before routing, at `orchestrator.ts:3234`), titles, Slack, or `outcome.messages`. That last one feeds memory's older extraction path (`packages/memory/src/plugin.ts:1862-1887`), which is why the line stays out of `chatEndHistory`.

### Boundary review (new hook `proxy:drain-session-allowed-hosts`, new IPC action `proxy.drain-allowed-hosts`)

- **Alternate impl:** an egress gate that is not this MITM proxy but grants live per-session hosts, such as an FQDN egress policy (Cilium-style) or a cloud egress firewall updated at Allow time. It would drain its own live grants. The CLI, which has no proxy, already answers `{ hosts: [] }` through the handler's `hasService` guard.
- **Payload field names that might leak:** none. The request is empty and the response is `hosts: string[]`.
- **Subscriber risk:** none. It is a service hook with no subscribers.
- **Wire surface:** `@ax/ipc-protocol` `actions.ts` gains `ProxyDrainAllowedHostsRequestSchema` (`.strict({})`) and `ProxyDrainAllowedHostsResponseSchema` (`{ hosts }`). The handler in `@ax/ipc-core` maps the call to the hook 1:1. The session comes from ctx, never from the body.
- `proxy:add-host` keeps its signature. It only gains an internal record (no boundary change).

### Security (pre-stated; the builder runs `security-checklist` at PR time, since Tasks 1–4 are flagged)

- **Sandbox escape:** the new runner-callable action only reads and clears the caller's own session buffer. It never widens egress; the allowlist still changes only through host-internal `proxy:add-host` on a person's click. The drained hosts are hosts the person allowed for this session, which the agent can learn anyway by retrying. There is no filesystem, process or env reach, and the body is empty and strict.
- **Prompt injection:** each host passed `HOST_RE` at `proxy:add-host` and passes `SAFE_HOST_RE` again in the runner before it is backticked into fixed copy. Anyone can type a fake "System message … ALLOWED" line into a message, and it grants nothing. The proxy's allowlist is the only gate, so a forgery can at most make the agent try a request the proxy still refuses. A refused request raises a card the person must approve.
- **Supply chain:** no new dependencies.

### Exact-list pins and docs that must change

- `packages/ipc-protocol/src/__tests__/schemas.test.ts:1004-1031`: the "sixteen expected keys" test becomes seventeen, with `'proxy.drain-allowed-hosts'` added (Task 2).
- `packages/agent-runner-core/src/__tests__/run-runner.test.ts:2117-2127`: the exact action sequence gains `'proxy.drain-allowed-hosts'` right after `'tool.list'` (Task 4).
- `packages/ipc-core/src/__tests__/dependency-sync.test.ts` scans handler sources. The new hook must sit in `dependencies.ts` `optionalCalls`, not `requiredCalls`; `requiredCalls` is pinned at `:148-153` (Task 2).
- `packages/ipc-http/SECURITY.md:28` and `packages/credentials/SECURITY.md:7` enumerate the dispatcher actions (Task 2).
- No test pins credential-proxy's `registers`. No consumer declares the new hook, so no acceptance stub changes. `ipc-http` and `ipc-server` stamp dispatcher `optionalCalls` into their manifests automatically.

---

### Task 1: credential-proxy records live allows and drains them per session `[tier: sensitive]` (security-checklist)

**Files:**
- Modify: `packages/credential-proxy/src/plugin.ts`: types near `:304-345`, manifest `registers` `:546-552`, `proxy:close-session` `:879-899`, `proxy:add-host` `:924-966`, the new registration after `:978-990`.
- Modify: `packages/credential-proxy/src/egress-block-buffer.ts`: header comment only. The class now backs two per-session host sets: blocked hosts, and hosts allowed since the last drain.
- Create: `packages/credential-proxy/src/__tests__/allowed-hosts-drain.test.ts`. Boot `memCredentialsPlugin()` and the proxy plugin as `reactive-wall.canary.test.ts:41-71,133-141` does; no listener traffic is needed.
- Modify: `packages/credential-proxy/src/__tests__/reactive-wall.canary.test.ts`: add one `it`.

**Interfaces:**
- Produces: service hook `'proxy:drain-session-allowed-hosts'`, `(ctx: AgentContext, input: Record<string, never>) => Promise<{ hosts: string[] }>`. The session is `ctx.sessionId ?? ''`; empty or unknown gives `[]`. Hosts come in insertion order, each once, and the call clears them. Registered bare, like its sibling, with no `returns` schema (TASK-37 decision).
- `proxy:add-host`: unchanged signature and return. New side effect: when the session exists, the caller owns it and `!sess.allowlist.has(host)`, it adds the host AND records it in a second `SessionEgressBlockBuffer` instance (`allowedSinceDrain`). An already-present host records nothing. `proxy:close-session` also calls `allowedSinceDrain.forget(sessionId)`.

- [ ] **Step 1: Write the failing tests** in `allowed-hosts-drain.test.ts`. Open sessions with `proxy:open-session` and an allowlist of `['allowed.example.com']`. Drain through `bus.call('proxy:drain-session-allowed-hosts', makeAgentContext({ sessionId, agentId: 'a1', userId: 'u1' }), {})`.
  - `A1` add-host `new.example.com` on s1 → drain(s1) gives `{ hosts: ['new.example.com'] }`; a second drain gives `{ hosts: [] }`.
  - `A1b` add-host `b.example.com`, then `a.example.com` → drain gives `['b.example.com', 'a.example.com']`.
  - `A2` add-host `allowed.example.com`, already on the allowlist → `{ added: true, agentId: 'a1' }`, and drain gives `[]`.
  - `A3` add-host `new.example.com` twice → drain gives `['new.example.com']`.
  - `A4` add-host on an unknown session `s-gone` → `{ added: false }`, and drain with a `s-gone` ctx gives `[]`.
  - `A5` add-host on s1 as user `u2` → rejects with code `forbidden`, and drain(s1) gives `[]`.
  - `A6` add-host on s1, then drain with a ctx for `s2` → `[]`; a later drain(s1) still gives `['new.example.com']`.
  - `A7` add-host on s1, then `proxy:close-session` s1 → drain(s1) gives `[]`.
  - `A8` a ctx with `sessionId: ''` → drain gives `[]`.
- [ ] **Step 2: Add the canary case** to `reactive-wall.canary.test.ts`: `'TASK-1199: an allowed host is drained once for the session's next turn, and the retry passes'`. Use the existing test's setup (`:126-166`): blocked request → 403; `proxy:add-host` s1 `127.0.0.1` → `{ added: true, agentId: 'a1' }`; `proxy:drain-session-allowed-hosts` with a ctx for `s1` → `{ hosts: ['127.0.0.1'] }`; a second drain → `{ hosts: [] }`; retry fetch → `200`; `proxy:drain-session-egress-blocks` with the same ctx still gives `['127.0.0.1']` (the two buffers are independent).
- [ ] **Step 3: Run them and see them fail.** Run `pnpm --filter @ax/credential-proxy test -- allowed-hosts-drain reactive-wall`. Expected: FAIL, because no service registered for `proxy:drain-session-allowed-hosts`.
- [ ] **Step 4: Implement** the types (`DrainAllowedHostsInput = Record<string, never>`, `DrainAllowedHostsOutput { hosts: string[] }`), the `allowedSinceDrain` instance next to `egressBlocks` (`:534-538`), the `registers` entry, the add-host record, the close-session forget, and the new registration. Also update the comments: the add-host block comment (`:902-923`) says the add is recorded for the runner's next turn, and the new hook's block comment copies the security note from `:968-977`.
- [ ] **Step 5: Run them and see them pass,** with the same command plus `pnpm --filter @ax/credential-proxy test`. Expected: all PASS.
- [ ] **Step 6: Commit.** Message: `[TASK-1199] credential-proxy: record live host allows and drain them per session`.

### Task 2: the `proxy.drain-allowed-hosts` IPC action `[tier: sensitive]` (security-checklist)

**Files:**
- Modify: `packages/ipc-protocol/src/actions.ts`: after the `proxy.drain-egress-blocks` block (`:163-196`), with a comment written in the same register.
- Modify: `packages/ipc-protocol/src/timeouts.ts`: after `:86-90`, add `'proxy.drain-allowed-hosts': 5_000`, commented "runner drains at the start of each person's turn; fail fast and skip the line".
- Modify: `packages/ipc-protocol/src/ipc-client.ts`: add the `RESPONSE_SCHEMAS` entry after `:130`, and add the action to `SHORT_BUDGET_ACTIONS` (`:846-851`), with a comment: it runs at every turn start, and a surface-once drain gains nothing from a 2-minute replay.
- Create: `packages/ipc-core/src/handlers/proxy-drain-allowed-hosts.ts`, mirroring `proxy-drain-egress-blocks.ts`. Keep the inline hook literal, because the dependency-sync scanner keys off it.
- Modify: `packages/ipc-core/src/dispatcher.ts`: the import, plus `ACTIONS.set('/proxy.drain-allowed-hosts', { method: 'POST', handler: proxyDrainAllowedHostsHandler })` after `:115`.
- Modify: `packages/ipc-core/src/dependencies.ts`: an `optionalCalls` entry after `:158`, with `hook: 'proxy:drain-session-allowed-hosts'` and degradation `'POST /proxy.drain-allowed-hosts returns { hosts: [] } without calling the hook — no egress proxy means no live host grants; the agent simply gets no "now allowed" line.'`
- Modify: `packages/ipc-http/SECURITY.md:28`, `packages/credentials/SECURITY.md:7`: add `proxy.drain-allowed-hosts` beside `proxy.drain-egress-blocks`.
- Create: `packages/ipc-core/src/handlers/__tests__/proxy-drain-allowed-hosts.test.ts`.
- Modify: `packages/ipc-protocol/src/__tests__/schemas.test.ts`, `packages/ipc-protocol/src/__tests__/ipc-client.test.ts`.

**Interfaces:**
- Consumes: Task 1's hook.
- Produces: action `'proxy.drain-allowed-hosts'` (POST, body `{}`) → `{ hosts: string[] }`. Exports from `@ax/ipc-protocol`: `ProxyDrainAllowedHostsRequestSchema = z.object({}).strict()`, `ProxyDrainAllowedHostsResponseSchema = z.object({ hosts: z.array(z.string()) })`, and types `ProxyDrainAllowedHostsRequest` / `ProxyDrainAllowedHostsResponse`. `client.call('proxy.drain-allowed-hosts', {})` type-checks because `IpcActionName = keyof IPC_TIMEOUTS_MS`.

- [ ] **Step 1: Write the failing tests.**
  - `P1` handler (`proxy-drain-allowed-hosts.test.ts`, mirroring the four cases of `proxy-drain-egress-blocks.test.ts:42-89`): it returns the drained hosts and passes `ctx` (not a body field) to `'proxy:drain-session-allowed-hosts'`; it degrades to `{ hosts: [] }` without calling the hook when `hasService` is false; it rejects `{ sessionId: 'other' }` with 400 before dispatch; it maps a hook throw to an error envelope with no stack.
  - `P2` `schemas.test.ts`: the timeouts-keys test is renamed "seventeen" and its expected list gains `'proxy.drain-allowed-hosts'`.
  - `P3` `schemas.test.ts`: the request schema accepts `{}` and rejects `{ sessionId: 's1' }`; the response schema accepts `{ hosts: ['a.example.com'] }` and rejects `{}`.
  - `P4` `ipc-client.test.ts`: `'proxy.drain-allowed-hosts gets the SHORT connection budget (it runs at every turn start)'`. Copy the `tool.execute-host` short-budget test at `:392-419` and assert `attempts <= 5` and `clock < 10_000`.
- [ ] **Step 2: Run them and see them fail.** Run `pnpm --filter @ax/ipc-core test` and `pnpm --filter @ax/ipc-protocol test`. Expected: FAIL (module, key and export missing).
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run them and see them pass.** Run the same two commands, plus `pnpm --filter @ax/ipc-http test` and `pnpm --filter @ax/ipc-server test`. The manifests stamp `optionalCalls`, and `dependency-sync.test.ts` must pass. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `[TASK-1199] ipc: proxy.drain-allowed-hosts (session-bound, empty body)`.

### Task 3: the "now allowed" line, and a block note that expects a retry after an Allow `[tier: sensitive]` (security-checklist: hostnames reach model context)

**Files:**
- Modify: `packages/agent-runner-core/src/decision-turn.ts:66`: `export const SYSTEM_PREFIX` (add `export` only).
- Modify: `packages/agent-runner-core/src/egress-note.ts`.
- Create: `packages/agent-runner-core/src/__tests__/egress-note.test.ts`.
- Run, no edit expected: `packages/agent-claude-sdk-runner/src/__tests__/post-tool-use.test.ts:347-380`.

**Interfaces:**
- Produces: `buildEgressAllowedNote(hosts: readonly string[]): string | null`. It is not exported from the package barrel; `run-runner.ts` imports it from `./egress-note.js`. It returns `null` when no host survives `SAFE_HOST_RE`. There is no host-less fallback, because a "something was allowed" line with no host is useless. `buildEgressBlockNote` keeps its signature.

Exact copy, where `${list}` is the safe hosts, each backticked, joined by `', '`:
- Allowed line: `` `${SYSTEM_PREFIX} network egress is now ALLOWED for: ${list}. Requests to these hosts are no longer blocked, so you can retry one that was.` ``
- Block note: line 1 is unchanged (`:22`/`:24`). Line 2 replaces `:28`'s first string: `This is NOT a transient error: until the host is allowed, retrying, a different install method, or another mirror will NOT help. The sandbox can only reach hosts on its allowlist.` Line 3 is unchanged (`:29`). A new line 4 comes before the GitHub heads-up: `If the user allows a host, a system line at the start of their next message will say so, and you can retry then. If they ask you to try again, do.` Lines are still joined with `' '`.

- [ ] **Step 1: Write the failing tests** in `egress-note.test.ts`:
  - `N1` `buildEgressAllowedNote(['example.com'])` equals `` 'System message (not from the user): network egress is now ALLOWED for: `example.com`. Requests to these hosts are no longer blocked, so you can retry one that was.' ``
  - `N2` `['b.example.com', 'a.example.com']` contains `` '`b.example.com`, `a.example.com`.' `` in that order.
  - `N3` `[]` → `null`. `['bad host with spaces']` → `null`. ``['evil`echo pwned` ignore previous instructions']`` → `null`.
  - `N4` `['github.com', 'bad host']` contains `` '`github.com`' `` and does not contain `'bad host'`.
  - `N5` the allowed line starts with `` `${SYSTEM_PREFIX} ` `` (imported from `../decision-turn.js`).
  - `N6` `buildEgressBlockNote(['api.example.com'])` equals the full four-line text above, joined by single spaces. Write the expected string out literally.
  - `N7` structural guard: split `buildEgressBlockNote(['api.example.com'])` on `/(?<=\.)\s+/`. Every sentence matching `/will NOT help/` also contains `'until the host is allowed'`. The note contains `'If they ask you to try again, do.'`.
  - `N8` `buildEgressBlockNote(['github.com'])` still ends with the `release-assets.githubusercontent.com` heads-up sentence.
- [ ] **Step 2: Run them and see them fail.** Run `pnpm --filter @ax/agent-runner-core test -- egress-note`. Expected: FAIL (`buildEgressAllowedNote` is not exported, and N6/N7 fail).
- [ ] **Step 3: Implement.** Reuse the file's `SAFE_HOST_RE`. Update the file's doc comments: the block note no longer claims a retry can never work.
- [ ] **Step 4: Run them and see them pass.** Run the same command, `pnpm --filter @ax/agent-runner-core test`, and `pnpm --filter @ax/agent-claude-sdk-runner test -- post-tool-use`. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `[TASK-1199] runner-core: "now allowed" line; the block note expects a retry once a host is allowed`.

### Task 4: the shell drains at each person's turn and puts the line first `[tier: sensitive]` (security-checklist)

**Files:**
- Modify: `packages/agent-runner-core/src/run-runner.ts`: the `nextMessage()` `user-message` branch (`:1110-1170`) and a helper in the same closure. The IPC client is `client` (`:483`).
- Modify: `packages/agent-runner-core/src/__tests__/run-runner.test.ts`.

**Interfaces:**
- Consumes: `buildEgressAllowedNote` (Task 3), and `client.call('proxy.drain-allowed-hosts', {})` → `{ hosts: string[] }` (Task 2).
- Produces: no new exports. Two private helpers in `run-runner.ts`:
  - `function prependLine(content: unknown, line: string): unknown` is TASK-732's `prependNotice` restored under a new name. An array becomes `[{ type: 'text', text: line }, ...content]`. Otherwise `text = typeof content === 'string' ? content : String(content ?? '')`, and the result is `text.length > 0 ? `${line}\n\n${text}` : line`. It never mutates its input.
  - `async function allowedHostsLine(): Promise<string | null>` calls the action and returns `buildEgressAllowedNote(r.hosts)`. On any throw it writes the stderr line from Global Constraints and returns `null`.
- On each `user-message` delivery, call `allowedHostsLine()` once, after the uploads materialization (`:1119-1131`). Return `{ content: line === null ? messageContent : prependLine(messageContent, line), id }`. `chatEndHistory.push(...)` keeps the person's words only. Never drain for `decision-resolved`, `cancel`, `interrupt` or `idle-timeout`; the buffer waits for the next person's message.

- [ ] **Step 1: Update the existing pins.** In the global fake client (`:154-175`), add `if (action === 'proxy.drain-allowed-hosts') return { hosts: [] };` before the throw. In the exact action list at `:2117-2127`, insert `'proxy.drain-allowed-hosts'` after `'tool.list'`.
- [ ] **Step 2: Write the failing tests** in a new `describe('runRunner — hosts allowed since the last turn (TASK-1199)')`. Use `scriptInbox`, and a loop that records `msg.content` per turn and calls `endTurn` (as `:2140-2157` does). `LINE` is Task 3's `N1` string.
  - `R1` `'a host allowed between turns: the next turn starts with the now-allowed line, the earlier one does not'`. The drain answers `[]`, then `['example.com']`. Expect `seen` to equal `['first', `${LINE}\n\nsecond`]`.
  - `R2` `'a failing drain leaves the message as the person wrote it'`. The drain throws `new Error('boom')`. Expect `seen` to equal `['hello']`, the exit code 0, and stderr (spied) to contain `'runner: drain-allowed-hosts failed (continuing): boom'`.
  - `R3` `'the line reaches the model but never the chat-end history'`. With R1's setup, `seen[1]` starts with `LINE` (so the run is not vacuous). The `event.chat-end` payload's `outcome.messages` contains `{ role: 'user', content: 'second' }`, and no message content contains `'ALLOWED'`.
  - `R4` (in the `runRunner — uploads` describe, using `pullOne`): the drain answers `['example.com']`, and the message is `'see this'` plus the unlisted `att-ghost` block. `seen` equals `[{ type: 'text', text: LINE }, { type: 'text', text: 'see this' }, { type: 'text', text: "User attached 'notes.txt' (text/plain), but the file could not be loaded." }]`. Also, with typed text `''`, `seen[1]` is the attachment mention (no empty text block). Set the drain's answer before calling `pullOne`, because it captures the current mock.
  - `R5` `'hosts that fail the host-shape filter never reach the model'`. The drain answers `['bad host']`. `fakeClient.call` was called with `('proxy.drain-allowed-hosts', {})`, and `seen` equals `['hello']`.
  - The existing `:2140` test ("…with no notice prepended") must keep passing unchanged. The default `{ hosts: [] }` gives no line.
- [ ] **Step 3: Run them and see them fail.** Run `pnpm --filter @ax/agent-runner-core test -- run-runner`. Expected: R1 through R5 FAIL, because before the change the drain is never called and no line is added. The Step 1 pin also fails until the drain is called.
- [ ] **Step 4: Implement** both helpers and the return, with a short comment that names TASK-1199 and TASK-732's precedent, and says why the line stays out of `chatEndHistory`.
- [ ] **Step 5: Run them and see them pass.** Run the same command, then `pnpm --filter @ax/agent-runner-core test`, `pnpm --filter @ax/agent-claude-sdk-runner test` and `pnpm --filter @ax/agent-aisdk-runner test`. Expected: PASS. The claude-sdk and aisdk fakes don't answer the new action (`unexpected call`, or `undefined`), so they take the logged best-effort path. Do not edit those fakes.
- [ ] **Step 6: Commit.** Message: `[TASK-1199] runner: open the next turn with the hosts allowed since the last one`.

### Task 5: fix the lines that made a host Allow look already wired `[tier: mechanical]`

**Files:**
- Modify: `docs/plans/2026-05-26-just-in-time-capabilities-design.md`:
  - `:104` becomes `` - Granting widens the **live** session allowlist (`proxy:add-host`, §11.4) — **no re-spawn**. Nothing resumes the turn: when the person next writes in that session, the runner opens the turn with a "now allowed" system line (TASK-1199), and the agent retries then. ``
  - `:135`'s third cell becomes `` widen live allowlist (`proxy:add-host`); the agent is told at its next turn in that session (TASK-1199) and retries ``.
- Modify: `packages/channel-web/src/components/workspace/GrantRow.tsx` (comments only):
  - `:111-113` becomes `` Fires only for `skill`: a `host` grant widens the LIVE session allowlist and holds nothing, so there is nothing to resume. The person asks again, and the runner opens that turn by telling the agent the host is now allowed (TASK-1199). ``
  - `:481-482` becomes `` …and `onGranted` is never called there because a host grant holds nothing to resume. ``

- [ ] **Step 1: Make the four edits.** No behavior changes.
- [ ] **Step 2: Check.** Run `pnpm --filter @ax/channel-web test -- GrantRow` and `pnpm lint`. Expected: PASS.
- [ ] **Step 3: Commit.** Message: `[TASK-1199] docs: a host Allow resumes nothing; the agent is told at its next turn`.

### Task 6: changeset, full gate, PR notes `[tier: mechanical]`

**Files:**
- Create: `.changeset/egress-allowed-hosts-line.md`, with frontmatter `'@ax/credential-proxy': minor`, `'@ax/ipc-protocol': minor`, `'@ax/ipc-core': minor`, `'@ax/agent-runner-core': patch`. Body, in the project voice: after someone allows a blocked website, the agent's next turn in that conversation's live session starts with a line saying so, and the block message no longer tells it that retrying can never help. The Allow still lasts only for that session.

- [ ] **Step 1: Write the changeset.**
- [ ] **Step 2: Run the full gate.** Run `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. Expected: everything passes. A Docker teardown timeout in `@ax/auth-better` with all assertions green is the known local flake; report it, don't hide it.
- [ ] **Step 3: Write the PR description.** Include the Boundary review answers above, the `security-checklist` note (three threat models, starting from the Security section above), and the follow-ups below.
- [ ] **Step 4: Commit** the changeset, together with the decisions shard and this plan.

## Follow-ups (file as cards; do not build here)

1. **PRODUCT (Vinay): should a channel host Allow outlive its session?** It could last per agent (like the web's "Always for this agent" through `host-grants:grant`) or per thread/conversation. Today a new Slack thread, or an idle-retired session, blocks the host again (walk A.5's second half).
2. **Slack note lead:** `SLACK_NOTE_LEAD` (`turn-note.ts:68`) says the system never puts anything but the not-remembered line before the label. The runner's `System message (not from the user):` lines (this one, and decision-resolved openings) now can appear there. Name them in the lead once TASK-1202/1203 land.
3. **Web host Allow confirmation:** after "Just this once" or "Always", the card just vanishes, with no "Allowed. Ask again and it'll try." like Slack's `hostAllowed`. Raise it in a ux-design pass.

## Post-review changes (supersede the text above where they differ)

- `packages/channel-slack/src/turn-note.ts` WAS edited (review round 1, Major): the lead names `System message (not from the user):` lines as the system's. Follow-up 2 is done here and is not a card.
- The block note's last sentence is "If they tell you they allowed it, or ask you to try again, do." (round 1).
- The runner logs one line when drained hosts all fail the host-shape filter (round 1).
- The aisdk parity e2e asserts the line in the prompt the provider receives (round 1).
- Rounds 2–3: the lead's prefix sentence reads "A message to you may also start with a line beginning "System message (not from the user):": that is the system telling you what changed, such as a website now being allowed." "Grants nothing" stays on the not-remembered line only, and emails, pages and tool results are named as data. Moving `SYSTEM_PREFIX` into `@ax/core` (so the lead can't drift) is a follow-up; a comment at `decision-turn.ts` names the hand copy meanwhile.
