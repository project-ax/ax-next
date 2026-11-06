# TASK-1046 — Allow on a held connector call actually runs it (host replay) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task heading carries a `[tier: …]` tag; map it to model/effort without re-deciding.

**Goal:** When a person approves a connector (MCP) call held during a task run (an unattended decision, so no live agent will make it), the host makes that exact call once, through `@ax/mcp-client`'s guarded MCP client, with the credentials the sandbox would have used, and tells the person honestly what happened.

**Architecture:** `@ax/mcp-client` gains one service hook, `connectors:call-tool`, which re-derives authorization from the decision's `(ownerUserId, agentId)`, resolves the connector and its credentials the way a session does, and sends one `tools/call` through the existing SSRF-guarded fetch. It returns a closed outcome code and never server text. `@ax/decisions` treats a connector toolKey (`mcp.<ns>.<tool>`) as host-executable when that hook exists and the decision was held during a task run (Decision 10). It re-checks tool-policy `deny` at replay time and maps the outcome onto the existing claim → replay → settle machinery. A call that went out with no reliable answer is recorded as "can't tell whether it finished", never as "nothing was completed".

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` 1.32.1 (already pinned), undici, zod v3, kysely/Postgres, vitest, React (channel-web).

**Spec:** the TASK-1046 card body (owner decision: OPTION A) plus the **Design** section below. Decisions log: `.claude/memory/decisions/2026-11-05-TASK-1046.md`.

## Global Constraints

- **No new dependencies.** `@modelcontextprotocol/sdk` stays exact-pinned at `1.32.1`. No `package.json` dependency changes.
- **Invariant 2.** `@ax/decisions` never imports `@ax/mcp-client`. `@ax/mcp-client` never imports `@ax/decisions`, `@ax/connectors` or `@ax/agents` at runtime. The hook contract is re-declared locally on each side (structural types plus a local zod schema).
- **`connectors:call-tool` is never reachable from the sandbox.** Do not register any `tool:execute:<name>` for connector keys. Do not add an IPC action or handler for it. Do not add it to `tool:register`/the catalog.
- **At most one `tools/call` per invocation.** Nothing retries it: no 401-renewal retry, no transport reconnection (`maxRetries: 0`), no loop.
- **Never echo third-party text.** The server's reply content, error messages and HTTP bodies, the call's `input`, header values and the server URL must never reach a log field, a decision row, a receipt, or a hook return. Failures are closed reason codes. Decisions maps those codes to authored sentences.
- **Timeouts.** Register `connectors:call-tool` with the bus default timeout (no `timeoutMs` override). The handler bounds itself at **45 s total, measured from handler entry**, including its own pre-send hook reads. It sends nothing if less than 15 s is left. Inside that budget: 10 s for connect, 30 s per HTTP request. This keeps `STRANDED_REPLAY_TIMEOUT_MS`' derivation in `packages/decisions/src/expiry.ts:46-70` true.
- **Copy is exact.** Every user-facing string in this plan is final. Copy it verbatim. Paired strings that two packages must keep identical are pinned by literal in each package's tests.
- **Test command order:** `pnpm --filter <pkg> test` (filter BEFORE the script). Postgres-backed suites (`store.test.ts`, `decisions.canary.test.ts`, `connector-inventory-wiring.test.ts`) need an explicit `DOCKER_HOST` (CLAUDE.md "Docker-backed tests").
- **Final gate:** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. `pnpm build` is the tsc pass. Vitest alone tolerates type errors.

## Review Focus

These are the inputs most likely to bite a person after Allow, each pinned by a test in the owning task:

1. **A connection drops after `tools/call` was sent** (an SSE stream ends with no result, a socket reset, a 5xx). This must read as `unknown`, never as "nothing was completed", or the person re-approves and posts twice. Task 1, `unknown-after-send` tests.
2. **A server answers `tools/call` with a 3xx redirect.** The redirect is not followed and the outcome is `unknown`. Task 1.
3. **A recorded `input` that is not a plain object** (array, `null`, string from a misbehaving runner). The outcome is `failed/invalid-call` and nothing reaches the network. Task 2.
4. **A server that answers after the budget.** The outcome is `unknown/timeout`, and the hook returns well before the bus's 120 s ceiling. Task 1, small-limits test.
5. **A hostile server body** (prompt text, control characters, an echoed secret) on an error or a success. None of it appears in a log field, the row, the receipt or the hook's return. Task 1 (log capture), Task 3 (row/receipt).

---

## Design

### Problem

`decisions:approve` replays an unattended approval only when `bus.hasService('tool:execute:' + name)` (`packages/decisions/src/plugin.ts:737-743`). Connector tools have had no host executor since TASK-792 retired host MCP servers, so every unattended connector approval is claimed `approved-pending-agent` and waits for a byte-identical call from a later run. Webhook calls never repeat (a fresh Linear `save_comment` body), so Allow does nothing. Prod: `dec_611b4f955e4947799acec9f5e3a9470a` (`mcp.c3f53566018.whoami`) and the 11-02 `save_comment` are still parked.

### Naming facts the plan relies on

- Runners lift `mcp__<ns>__<tool>` to the canonical key `mcp.<ns>.<tool>` before `tool.pre-call`. See `packages/agent-claude-sdk-runner/src/tool-names.ts:178-190,252-257` and `packages/agent-aisdk-runner/src/tools/connector-tools.ts:592-593`. The decision row stores that key verbatim as `call.name`.
- `<ns>` is not a server id. It is the per-record tool namespace `c` + 10 hex, a hash of (connector row owner, connector id, server name) (`packages/connectors/src/tool-namespace.ts:39-62`). It cannot be reversed. The host finds the connector by matching `<ns>` against the agent's effective set (`connectors:list-effective` → `toolNamespaces[{server, toolNamespace}]`), the same composition `packages/mcp-client/src/connector-inventory/auth-failure-recheck.ts:102-136` uses. The MCP tool name sent upstream is everything after `mcp.<ns>.`. The arguments are `call.input`.

### Decisions (also in the decisions shard)

1. **Hook shape: a named service `connectors:call-tool`, registered by `@ax/mcp-client` when `connectorToolInventory: true`, declared as an `optionalCalls` entry by `@ax/decisions`.** It is NOT `tool:execute:<name>`, for two reasons. First, connector names are data minted per connector record, and HookBus has exact-match lookup and no unregister. Second, every `tool:execute:*` hook is reachable from the sandbox through `tool.execute-host` (`packages/ipc-core/src/handlers/tool-execute-host.ts:37-45`). That would hand a compromised runner a credentialed, host-side path to third-party servers that skips both the approval gate and the credential-proxy's per-session host binding.
2. **Authorization is re-derived at call time from the decision's `(ownerUserId, agentId)`, never the approver's:**
   - `agents:resolve`;
   - the namespace must belong to a connector in the agent's effective set (`connectors:list-effective` with the agent row's `connectorAttachments` / `connectorExclusions`);
   - `connectors:resolve` must still resolve it and still carry the namespace;
   - the server's hostname must be in the connector's `capabilities.allowedHosts`. This is parity with the session proxy's exact-match allowlist (`credential-proxy/src/listener.ts:642`), so the host never reaches further than the sandbox would;
   - credentials come from the connector's own `credentialPlan` via `credentials:get` under `(userId, agentId)`. That is the same refs and the same scope walk the session proxy spends (`connector-inventory/describe-tools.ts:231-271`).

   `@ax/decisions` additionally re-runs `tool-policy:evaluate` under the decision's ctx right before the call and refuses on `deny`, or on a thrown or malformed answer (fail closed). `hold` and `allow` proceed: `hold` is the question the person just answered. The precedent is `currentPolicy` in `packages/decisions/src/routine-authorization.ts:65-82`.

   **Accepted residual: a verdict-store outage inside tool-policy reads as `hold`, not as an error** (`strictest(static, 'hold')`, `packages/tool-policy/src/plugin.ts:635-641`). During such an outage, a Deny saved after the hold is not seen and the approved call proceeds. That is tool-policy's own fail-safe answer for the gate, which is "ask", and the person has already been asked and said yes. Telling an outage apart from a real `hold` would change `tool-policy:evaluate`'s output and need its own boundary review, so it is not built here.
3. **Outcome contract is closed codes, and an unknown result is honest.** The hook returns `succeeded`, `failed` (a definite answer: nothing completed, except `tool-error`, the tool's own "it didn't work" after it ran; Decision 12), or `unknown` (sent, no reliable answer). Decisions writes `unknown`, and any throw or unreadable return from the hook, as `status: 'failed'` plus `replay_abandoned_at`. That is the shape `receiptFor` already renders as `ABANDONED_RECEIPT` ("…we cannot tell you whether it finished…"). channel-web's card learns to say the same (it says "Nothing was completed" for every `failed` row today).
4. **Exactly-once rides the existing claim-first machinery, unchanged:**
   - `claimForApproval` stamps `replay_claimed_at` on the immediate path;
   - `claimDueReplays` stamps it on the deferred path;
   - `claimReplayFlight` stamps it on the attended-delivery fallback (tool:execute rows only since Decision 10: an attended connector row parks there and is never host-made);
   - the call runs only after one of these claims.

   A crash mid-call leaves `executed + replay_claimed_at`. `reclaimStrandedFlights` moves it to `failed` + abandoned after 15 min and never re-runs it. `recoverRoutineReplays` only touches `routine_release_at IS NOT NULL` rows (routine write tools), so it never re-queues a connector row. The hook itself never retries.
5. **Undo window: unchanged semantics.** `tool-policy:evaluate` always answers `irreversible: false` for connector keys, so connector approvals replay immediately on Allow with no undo window, exactly as any reversible host replay does. Whether outward connector writes should defer by the undo window is a follow-up, not this card.
6. **The agent is told nothing, and nothing is written to the run's conversation.** The run is over. The receipt (Activity) and the row (Today / card) are the record. A later run that re-issues the same call holds again, because the yes is spent by `replayed_at`, so nothing silently runs twice. A transcript write would need a new path into the conversations source of truth for no safety gain.
7. **Already-parked rows are not replayed retroactively.** They were approved under "the next time it runs". Firing a days-old webhook comment out of context would surprise the person. They keep their parked status; only their wording improves (Task 5).
8. **A namespace the host cannot match to the agent's effective set fails as `not-connected`. It does not park.** That covers a detached or deleted connector, and a connector a skill brought in, which `list-effective` does not carry (a known limitation, the same one TASK-842 accepted). It is an authorization miss, not a capability gap. Nothing is sent and the yes is spent.
9. **YAGNI cuts:**
   - no TASK-817-style 401 renewal and retry (a write must not be re-sent);
   - no tool-inventory pre-check (the server rejects unknown tools itself, and a fresh `tools/list` is a second round trip for no added safety);
   - no rail refresh on 401;
   - no skill-referenced connector union;
   - no conversation write;
   - no new status;
   - no migration.
10. **Host replay is for connector calls held during a task run (review F1, owner scope "from a task run").** `hostExecutorFor` takes the decision, and a connector key whose stored attendance is `attended` has no host executor, at all three sites. An attended connector row with no live session parks (`approved-pending-agent`) exactly as before this PR, at the approve route and at the `runDueDeliveries` fallback. The agent's next turn in that thread re-issues the call and the gate lets it through once. Host-making it instead spent the yes in a way the agent never heard about, so that same re-issued call was held again: a second card for a call that already went out. `tool:execute:*` routing is unchanged.
11. **The host sends only a request the person was shown whole (review F2).** channel-web's card caps the request it shows (`wireRequest`: 2000 characters, 40 lines, a 120-character tool line, "This is only the beginning…"), but the host sends the full `call.input`. So `decisions:approve` gains an optional `requestShownInFull`, and `@ax/decisions` makes a CONNECTOR call on the host only when it is `=== true` (`hostExecutorForApproval`). Absent, false or any other value parks the call (`approved-pending-agent`) in the claim itself. That fails closed, so a stale client or another caller cannot trigger a host write. channel-web's approve route computes the flag from the STORED row with `wireRequest`, the function the card is drawn from. It never reads it from the HTTP body, which may carry only `approvalScope`. The flag is asked only where the yes is given: a parked row is never replayed later, and a row claimed or deferred for the host already passed the check. `tool:execute:*` host replays ignore it.
12. **A tool that ran and said it failed is its own outcome (review F3).** An MCP reply with `isError: true` was `failed/rejected` and read "…Nothing was completed." But the call was sent and the tool ran, and it may have done part of the work. It now has its own closed reason code, `tool-error`, under `failed` on both sides (strict on both: `{ outcome: 'unknown', reason: 'tool-error' }` and any extra field are refused). HTTP 4xx and the JSON-RPC codes −32700, −32600 and −32601 stay `rejected` (nothing ran). −32602 joined `tool-error` in review r2 (R1): a server can send it after the tool ran. Decisions records `tool-error` like `unknown`, as `status: 'failed'` plus `replay_abandoned_at`, so `outcomeUnknown` and the receipt never claim nothing happened. With no migration and no new status, the row tells the two abandoned kinds apart by one closed code in `replay_error`: `TOOL_ERROR_REPLAY_CODE` (`'tool-error'`), meaningful only on an abandoned row. `receiptFor` reads it as `TOOL_ERROR_RECEIPT`, with no second line. channel-web projects it as a second derived wire boolean, `toolReportedError`, and the card says the service said it didn't work, never "interrupted".
13. **One shape for connector toolKeys (review F5).** `@ax/decisions`' label parser accepts `mcp.<ns>.<anything>` (`/^mcp\.(c[0-9a-f]{10})\.(.+)$/s`), but `connectors:call-tool` accepts only a 1-128 printable-ASCII tool name and answers `invalid-call` for the rest. A key only the parser accepts was routed to the host just to spend the yes on that refusal. `hostExecutorFor` now treats a key as host-executable only in the strict shape, `CONNECTOR_CALL_TOOL_KEY_RE`, re-declared in decisions (no cross-plugin import) and pinned to the same literal as mcp-client's `CONNECTOR_TOOL_KEY_RE` by a test on each side. Any other connector-shaped key parks, and never falls through to a `tool:execute:<key>`.
14. **The parked note claims nothing about the run (review F9).** `DECISION_PENDING_AGENT_NOTE` dropped ", and that run had already ended". It was false for the TASK-692 fallback, where the `chat:resume` gate refused the wake-up and the run may still be there. It now reads "Nothing has happened yet. It can only do this during one of its own runs. If a later run makes exactly this request, it goes ahead without asking you again." The headline is unchanged.

### Boundary review (paste into the PR body)

- **Hook:** `connectors:call-tool` (service). `{ userId, agentId, toolKey, input }` → `{ outcome: 'succeeded' } | { outcome: 'failed', reason } | { outcome: 'unknown', reason }`.
- **Alternate impl:** a one-shot sandbox replay, i.e. a short-lived runner session for `(user, agent)` that makes the call through the credential-proxy and reports the outcome. Or a non-MCP connector backend (a REST/OpenAPI connector) answering the same canonical toolKey.
- **Payload field names that might leak:**
  - `toolKey`'s value carries the `mcp.` prefix. It is the canonical permission key since TASK-734, shared by tool-policy, decisions, `connectors:tool-labels` and `connectors:describe-tools`. It is not a transport field.
  - `input` is the ToolCall vocabulary, not MCP's `arguments`.
  - The reason codes (`invalid-call | not-connected | needs-auth | unavailable | unreachable | rejected | tool-error | timeout | interrupted`) carry no URL, header, HTTP status, server name or session id. `tool-error` (review F3) is MCP's `isError` in our words: a tool-level "it didn't work", which a REST connector backend has too.
- **Subscriber risk:** none. It is a service hook and nothing fires.
- **Wire surface:** none. It is deliberately not an IPC action. `tool.execute-host` dispatches only `tool:execute:<name>`, and no IPC handler forwards `connectors:*`.
- **`@ax/decisions` manifest:** new `optionalCalls` entry. No `calls` change. Cycle-free: none of mcp-client's producers call `decisions:*`, and `boot-graph.test.ts` proves it.

**`decisions:approve` input gains `requestShownInFull?: boolean` (review F2).** Output unchanged.

- **Alternate impl:** another approving surface, such as a Slack approval message or a CLI prompt, renders the held request its own way and sets the flag from its own rendering (Slack's block limit, a terminal pager). A surface that shows no request at all (a bare yes/no notification) leaves it absent, and a connector call approved there parks for the agent.
- **Payload field names that might leak:** none. `requestShownInFull` names a fact about what the approving PERSON was shown. It says nothing about the transport, the store or the renderer: no `card`, `html`, `truncated`, `fenceBlock` or character count. Any surface that shows a request can answer it, and one that cannot answers "no" by leaving it out.
- **Subscriber risk:** none. It is a service input. It is not stored on the row and not carried by `decisions:raised` or any other fire, so no subscriber can key off it.
- **Wire surface:** `decisions:approve` is not an IPC action, so the sandbox cannot send it. The browser cannot send it either: the HTTP approve route refuses any body key but `approvalScope` (400), and fills the field itself with `requestShownInFull(stored)`, which reads `wireRequest`'s output for the stored row. That is the only translation: wire body (nothing) → hook input (the route's answer).

### Security note

Finalized by Task 2's builder with `security-checklist` (2026-11-05), for the `@ax/mcp-client` half as built. Task 3 adds the decisions half (the policy re-check and the routing), so the final verification re-runs the checklist before the PR. The block to paste under the PR body's `## Security review`:

```
- Sandbox: New host capability `connectors:call-tool` (@ax/mcp-client, k8s preset only): one guarded HTTPS `tools/call` (with its MCP handshake) to one connector server's own origin, through the inventory's guarded fetch (https only, no userinfo, same origin, no redirects, connect-time IP vetting), only after access is re-derived from the decision's (user, agent): agents:resolve, the agent's effective connector set, connectors:resolve, no URL fragment, host in the connector's allowedHosts (exact match, the session proxy's rule). 30 s per request, 45 s from handler entry, nothing sent with under 15 s left, 2 MiB per response, never retried. Credentials are the connector's plan refs via credentials:get as (user, agent), held only in one transport's header map. Reachable only over the host hook bus: no IPC action, no tool:execute:*, no catalog entry, so the sandbox cannot call it. The intended caller is @ax/decisions; that is not enforced (see the Supply chain residual). No processes, no filesystem, no env reads.
- Injection: Untrusted in: the model-authored `input` (sent verbatim as the tool's arguments, the bytes the person approved: @ax/decisions asks for the call only when decisions:approve says the approving surface showed the whole request, `requestShownInFull: true`, which channel-web computes from the stored row with the card's own renderer, and a request the card cut short parks instead (the host path only: a parked yes still lets the agent's own identical call through, a pre-existing residual); never logged, never part of a URL, header or path), the model-chosen tool name (printable ASCII, 1-128 chars by the input schema; sent only as the MCP tool name), and the server's reply (read only for the boolean isError through a local passthrough schema; content dropped unread; no server-supplied schema compiled). Errors are closed codes, and the bus's strict `returns` schema refuses any answer with a field that could carry text. The one `connector_call_tool` line is connectorId + code (a credential read failure also logs the shared header builder's codes-only line), pinned by tests that inject hostile text and secrets.
- Supply chain: No package.json or lockfile change. Reuses the exact-pinned @modelcontextprotocol/sdk 1.32.1 Client / StreamableHTTPClientTransport (already used by list-tools.ts), undici and zod. Residual, third-party host plugin code: any host plugin can call connectors:call-tool (every plugin gets the same bus; a manifest's `calls` orders boot, it does not gate calls), a ctx is one makeAgentContext away, the payload carries no proof of approval, and the hook runs no tool-policy check (the caller's job, Task 3). The re-derived access still bounds where such a call goes and whose credentials it spends.
```

- **Sandbox escape:**
  - New host reach is one HTTPS origin per call, the connector server's. It goes through the existing guarded fetch: https only, no userinfo, same origin, no redirects, connect-time IP vetting, 30 s per request, 2 MiB cap. The 45 s budget runs from handler entry, its own hook reads included, and nothing is sent with less than 15 s left.
  - The destination must also clear the authorization checks of Decision 2, including the connector's `allowedHosts` (exact match, IPv6 brackets stripped, as the proxy does) and no URL fragment. Nothing is read from the vault until the URL checks pass, and nothing is sent until every check passes.
  - `connectors:call-tool` is a named service. It is not an IPC action, not a `tool:execute:*` hook and not a catalog entry, so the sandbox cannot reach it. The caller's ctx must name the payload's user and agent, and an owner-less id gets nothing. That catches a confused caller, not a hostile one: host code can build any ctx.
  - No processes are spawned. There are no filesystem or env reads.
  - The intended trigger is `decisions:approve` by the decision's owner (`plugin.ts:599`), or the sweep's due replay of an approval that owner already made. Never the delivery fallback: an attended connector row parks there (Decision 10). The hook does not enforce that (the Supply chain residual below).
- **Prompt injection:**
  - `input` is model-authored and sent verbatim. That is the WYSIWYG promise the card makes. The person approved exactly those bytes, and that is enforced, not assumed (Decision 11): `@ax/decisions` makes a connector call only when `decisions:approve` carries `requestShownInFull: true`, which channel-web's approve route computes from the stored row with `wireRequest`, the function the card is drawn from. A request the card cut short ("This is only the beginning…"), or an approval that says nothing about it, parks for the agent instead. That holds for the HOST path only (review r2 R2): the parked row is still a standing yes, so the agent's own identical call can still send the bytes the card cut short (a pre-existing residual, listed below). The handler sends the caller's own object, never a parsed copy.
  - The namespace-to-connector mapping is the host's answer, never the model's.
  - The reply is read only for the boolean `isError`. Its content is discarded unread and never logged, stored or rendered.
  - Errors reduce to closed codes. The registration's strict `returns` schema refuses any other answer (`invalid-return`), which decisions records as "can't tell".
- **Supply chain:** no new dependency. The SDK's `Client` / `StreamableHTTPClientTransport` are already used by `list-tools.ts`. We call `client.request` with a minimal local schema, so the host never compiles a server-supplied JSON Schema.
  - **Residual (third-party host plugin code):** nothing stops another host plugin from calling `connectors:call-tool`. Every plugin gets the same bus, and a manifest's `calls` orders boot rather than gating calls. A ctx is one `makeAgentContext` away, the payload carries no proof that anyone approved the call, and the hook runs no tool-policy check (that is the caller's job: Task 3's `replayConnectorCall`). So a buggy or hostile host plugin could make a connector call nobody approved. The re-derived access still bounds it to where a session of that agent could go, with that agent's own credentials. Host plugins already have this much reach (`credentials:get` is just as callable), so the guard is which plugins a preset loads.
- **Accepted residuals (documented):**
  - any host plugin can call `connectors:call-tool` (the Supply chain residual above);
  - tool-policy's 30 s verdict cache can lag a Deny saved on another replica;
  - a connector whose server URL changed since the hold is called at its current URL (parity with a fresh session);
  - a paused (kill-switch) account's prior approvals still run, consistent with TASK-692/TASK-716;
  - a verdict-store outage inside tool-policy reads as `hold`, so a Deny saved after the hold is not seen during it (Decision 2);
  - Decision 10 keys on STORED attendance, which can read `unattended` for a call held in a chat in two ways: the conversation lookup failed at hold time (`attendanceFor` falls back to `unattended`, attendance.ts), or the chat's identical call reused an open hold a task run raised, and the row keeps the raiser's attendance (`createOrReuseOpen`, pre-call.ts). Such a connector call is host-made. It still runs exactly once; the cost is that the chat's next turn may hold it again, one extra card (review r2 R3);
  - a parked yes is a standing yes (`takeApproval`): the agent's own identical call passes the gate with the bytes the card cut short. Decision 11 closes the HOST path only; this agent path predates the PR (the card has capped the request since TASK-699) and applies to every parked call (review r2 R2);
  - serial host calls in one sweep pass can outlive the 15-min reclaim. That is pre-existing for every host executor. Connector rows do not reach it today. They never defer (Decision 5), and the attended-delivery fallback, where `runDueDeliveries` stamps each flight with the pass's own `now` so a very long pass makes a late flight look old, parks them instead (Decision 10). It is rare. It is still never a double-send, because the reclaim runs nothing and `markReplayed` wins if the call lands.

### What the person sees after Allow (connector call held during a task run)

| Outcome | Today / in-thread card | Activity receipt (+ second line) |
|---|---|---|
| succeeded | row's `approvedText`, done dot | `approvedText` |
| failed (definite) | "It tried to do this, and it did not work." / "Nothing was completed. Your yes does not carry over, so it will ask again if it still needs to." | `FAILED_RECEIPT` + authored detail for the reason |
| failed / tool-error (the tool ran and said it didn't work; review F3) | "It tried to do this, and the service said it didn't work." / "It may have done part of it. Worth checking before you approve it again." | `TOOL_ERROR_RECEIPT`: "It tried to do this, and the service said it didn't work. It may have done part of it, so check before you approve it again." (no second line) |
| unknown | **new:** "This was interrupted while it was running, so we cannot tell you whether it finished." / "Worth checking before you approve it again." | `ABANDONED_RECEIPT` (no second line) |
| hook absent (host truly cannot) | **new wording:** "Approved — it can do this the next time it tries." / the new note in Task 5 | same headline |

A connector call held in a chat (`attended`) is not in this table: with no live session it parks and reads like the last row, and the agent's next turn makes it (Decision 10).

---

## Task 1 [tier: sensitive]: mcp-client — shared connector headers + one-shot `tools/call`

**Files:**
- Create: `packages/mcp-client/src/connector-inventory/connector-headers.ts`
- Modify: `packages/mcp-client/src/connector-inventory/describe-tools.ts:87-105,188-192,231-271` (move the `Resolved*` interfaces, `noUsableCredential` and the `headersFor` body out. describe-tools calls the shared function. Behaviour unchanged.)
- Create: `packages/mcp-client/src/connector-inventory/call-server-tool.ts`
- Test: `packages/mcp-client/src/__tests__/connector-call-server-tool.test.ts` (new). It reuses the `fakeMcpServer` `baseFetch` pattern from `connector-inventory-list-tools.test.ts:97-150`.
- Regression: `packages/mcp-client/src/__tests__/connector-inventory-describe-tools.test.ts` stays green unchanged.

**Interfaces:**
- Produces (`connector-headers.ts`):
  ```ts
  export interface ResolvedSlot { slot: string; kind: 'api-key' | 'oauth'; headerName?: string; server?: string }
  export interface ResolvedServer { name: string; transport: 'http'; url?: string }
  export interface ResolvedConnector {
    id: string;
    capabilities: { credentials: ResolvedSlot[]; mcpServers: ResolvedServer[]; allowedHosts?: string[] };
    credentialPlan: Array<{ slot: string; ref: string }>;
    toolNamespaces?: Array<{ server: string; toolNamespace: string }>;
  }
  export function noUsableCredential(err: unknown): boolean;
  export function connectorHeaders(
    bus: { call<I, O>(hook: string, ctx: AgentContext, input: I): Promise<O> },
    connector: ResolvedConnector, server: ResolvedServer, ctx: AgentContext, userId: string,
  ): Promise<{ headers: Record<string, string>; bearerRef?: string } | 'absent' | 'needs-auth' | 'unavailable'>;
  ```
  `allowedHosts` is optional on the view so describe-tools fixtures keep compiling.
- Produces (`call-server-tool.ts`):
  ```ts
  export const CALL_LIMITS = { connectTimeoutMs: 10_000, requestTimeoutMs: 30_000, budgetMs: 45_000, maxResponseBytes: 2 * 1024 * 1024 } as const;
  export type ServerCallOutcome =
    | { outcome: 'succeeded' }
    | { outcome: 'failed'; reason: 'needs-auth' | 'unreachable' | 'rejected' }
    | { outcome: 'unknown'; reason: 'timeout' | 'interrupted' };
  export interface CallServerToolOptions {
    url: string; headers: Record<string, string>; tool: string; input: Record<string, unknown>;
    resolver?: AllAddressesResolver;                                   // test seam
    baseFetch?: (url: string, init: Record<string, unknown>) => Promise<Response>; // test seam
    limits?: Partial<typeof CALL_LIMITS>;
  }
  export async function callServerTool(opts: CallServerToolOptions): Promise<ServerCallOutcome>; // never throws
  ```

**Classification (the part the signature does not determine):**

| Where it fails | Condition | Outcome |
|---|---|---|
| `createGuardedFetch` throws (URL policy) | any | `failed / unreachable` |
| `client.connect` (initialize) throws | `code` 401 or 403, or name `UnauthorizedError` | `failed / needs-auth` |
| `client.connect` throws | anything else | `failed / unreachable` |
| `client.request(tools/call)` resolves | `isError === true` | `failed / tool-error` (was `failed / rejected` until review F3: the tool ran, so it is not a refusal) |
| `client.request(tools/call)` resolves | otherwise | `succeeded` |
| `client.request(tools/call)` throws | numeric `code` 401 or 403 (`StreamableHTTPError`) | `failed / needs-auth` |
| `client.request(tools/call)` throws | numeric `code` 400–499 other than 401/403 | `failed / rejected` |
| `client.request(tools/call)` throws | `McpError` with code −32700, −32600 or −32601 | `failed / rejected` |
| `client.request(tools/call)` throws | `McpError` with code −32602 (InvalidParams) | `failed / tool-error` (review r2 R1; was `rejected`: an McpServer on SDK 1.12–1.20 runs the tool callback and then throws −32602 for "output schema but no structured content", and a low-level Server handler can send it at any point, so the tool may have run) |
| `client.request(tools/call)` throws | name `TimeoutError` / `AbortError` that is not the oversize abort, or `McpError` code −32001 | `unknown / timeout` |
| `client.request(tools/call)` throws | anything else (5xx, −32603 and other JSON-RPC codes, −32000 connection closed, `BlockedRequestError` from a redirect, `ResponseTooLargeError` / oversize abort, a parse failure, a socket reset on a plain-JSON reply) | `unknown / interrupted` |

**SDK 1.32.1 behaviour the table depends on** (found by the builder check):
- When the `tools/call` reply is an SSE stream, the SDK hands it to `_handleSseStream(…, false)` (`streamableHttp.js:405`).
- If that stream ends with no result or breaks mid-way, the SDK only calls `onerror` (`:236-252`). It never rejects the pending request.
- So the request waits out `requestTimeoutMs` and surfaces as `McpError` −32001 (`shared/protocol.js:713,741`), which classifies as `unknown/timeout`.
- Do not add code to force `interrupted` for that case. Both reasons mean the same thing to the caller, and with default limits this wait is at most 30 s, inside the budget.

Implementation notes:
- Copy `listServerTools`' shape (`list-tools.ts:171-227`): the `oversize` AbortController, `AbortSignal.any([AbortSignal.timeout(budgetMs), oversize.signal])`, the same `StreamableHTTPClientTransport` options (except `fetch`, two bullets down) with `reconnectionOptions.maxRetries: 0`, `client.onerror = () => {}`, and `client.close()` + `guarded.close()` in `finally`.
- The guarded fetch gets `timeoutMs: requestTimeoutMs`.
- The transport's `fetch` is the guarded fetch with the budget added to every request's signal: `AbortSignal.any([init.signal, budget])`, or `budget` alone when the request has none. The SDK passes our signal only to `initialize` and `tools/call`. `connect` awaits `notifications/initialized` with no signal of its own, so without this a server that stalls it holds the call for the per-request deadline, whatever the budget. After a budget abort, the SDK's `notifications/cancelled` is handed over already aborted, so it is never sent.
- `connect` gets `{ signal: budget, timeout: connectTimeoutMs }`.
- Send exactly `client.request({ method: 'tools/call', params: { name: tool, arguments: input } }, CallResultView, { signal: budget, timeout: requestTimeoutMs })`, where `CallResultView = z.object({ isError: z.boolean().optional() }).passthrough()` is a local schema. Never `client.callTool()` and never `CallToolResultSchema`: those validate content blocks, and `callTool` can compile a server-supplied output schema.
- Read the request error before deciding "oversize" (`oversize.signal.aborted` → `interrupted`), the same way `list-tools.ts:222` prefers `oversize.signal.reason`.
- Classify on `code` / `name` / `instanceof` ONLY. The SDK puts the server's response body into the error MESSAGE (`StreamableHTTPError(status, \`Error POSTing to endpoint: ${text}\`)`, `@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:378`), so `err.message` must never be logged, returned or matched. An unexpected content type is `StreamableHTTPError(-1, …)` (`:419`). It is not 4xx, so it falls to `unknown/interrupted` after the send, or `failed/unreachable` during connect.
- Log nothing in this file. The caller logs codes.

- [ ] **Step 1: Write the failing tests** in `connector-call-server-tool.test.ts`. Each `it` asserts the exact returned object, and, where it says so, the number of `tools/call` POSTs the fake server saw.
  - `sends one tools/call with the tool name and the input object verbatim` — `params` deep-equals `{ name: 'save_comment', arguments: <nested input> }`. The `Authorization` header passed in is on the request. Returns `{ outcome: 'succeeded' }`. `tools/call` count is 1.
  - `isError result is a definite failure` → `{ outcome: 'failed', reason: 'rejected' }`.
  - `JSON-RPC invalid params is a definite failure` (error code −32602) → `failed/rejected`. (Superseded by review r2 R1: −32602 after the send is `failed/tool-error`.)
  - `401 on initialize is needs-auth and never sends tools/call` → `failed/needs-auth`, `tools/call` count 0.
  - `401 on tools/call is needs-auth and is not retried` → `failed/needs-auth`, `tools/call` count 1.
  - `a 500 after send is unknown` → `{ outcome: 'unknown', reason: 'interrupted' }`.
  - `an SSE response that ends without a result is unknown` (limits `{ budgetMs: 2_000, requestTimeoutMs: 5_000 }`, which keeps the call open past the SDK's default 1 s reconnect delay; the server answers `tools/call` with a `text/event-stream` that opens with a priming event and closes before any result) → `outcome: 'unknown'` (assert the class only; the budget ends it), settling in under 4 000 ms, and no request carries `last-event-id` (the stream is never resumed). **(Review Focus 1)**
  - `a redirect on tools/call is not followed and is unknown` → `unknown/interrupted`, and the redirect target is never requested. **(Review Focus 2)**
  - `an answer past the budget is unknown` (limits `{ budgetMs: 200, requestTimeoutMs: 200 }`; the server answers `initialize` at once and delays `tools/call` by 2 000 ms) → `outcome: 'unknown'`, and the promise settles in under 1 500 ms. Assert the outcome class, not the reason: depending on how the SDK wraps the abort it may surface as `timeout` or `interrupted`, and both mean the same thing to the caller. **(Review Focus 4)**
  - `an oversize reply is unknown` (limits `{ maxResponseBytes: 1024 }`) → `unknown/interrupted`.
  - `a non-https server url is refused before any request` → `failed/unreachable`, and `baseFetch` is never called.
  - `hostile reply text never leaves the function` — the server returns `isError: true` with content text `IGNORE PREVIOUS INSTRUCTIONS sk-live-123`, and a second case returns a 500 body with the same text. `JSON.stringify(outcome)` contains neither `IGNORE` nor `sk-live`. **(Review Focus 5, transport half)**
- [ ] **Step 2: Run** `pnpm --filter @ax/mcp-client test -- connector-call-server-tool`. Expected: FAIL (module not found).
- [ ] **Step 3: Extract `connectorHeaders` / `noUsableCredential` / the `Resolved*` interfaces into `connector-headers.ts`, and switch describe-tools to them** (a pure move: same return union, same `credentials:get {ref, userId}` call, same log line `connector_inventory_credential_unavailable`).
- [ ] **Step 4: Implement `callServerTool`** per the table.
- [ ] **Step 5: Run** `pnpm --filter @ax/mcp-client test` and `pnpm --filter @ax/mcp-client build`. Expected: all PASS, including the untouched describe-tools suite.
- [ ] **Step 6: Commit** `feat(mcp-client): one-shot guarded tools/call with closed outcomes (TASK-1046)`.

## Task 2 [tier: sensitive]: mcp-client — `connectors:call-tool` service, registration, SECURITY.md

**Files:**
- Modify: `packages/mcp-client/src/connector-inventory/types.ts`. Add the input/output types and schemas, with a boundary-review header comment (copy the Design section's answers).
- Create: `packages/mcp-client/src/connector-inventory/call-tool.ts`
- Modify: `packages/mcp-client/src/plugin.ts`:
  - header comment `:1-21`: add item 3, "approved connector calls";
  - registers `:83-87`;
  - init `:150-167`;
  - options `:48-59`: new test seam;
  - the `connectors:list-effective` degradation text `:78-82`.
- Modify: `packages/mcp-client/SECURITY.md`. Update the intro list and the "one place this package opens network connections" sentence, and add a new section (content below).
- Test: `packages/mcp-client/src/__tests__/connector-call-tool.test.ts` (new; fake bus plus a fake `callServer`).
- Test: `packages/mcp-client/src/__tests__/connector-inventory-wiring.test.ts`. Add a new `describe`. Follow its existing harness and the TASK-842 describe at `:331` for how `agents:resolve` / attachments are provided.
- Modify pins: `packages/mcp-client/src/__tests__/plugin.test.ts:141-167` and `presets/k8s/src/__tests__/preset.test.ts:574-578`. Append `'connectors:call-tool'` to `registers` in both.

**Interfaces:**
- Consumes: Task 1's `connectorHeaders`, `ResolvedConnector`, `callServerTool`, `ServerCallOutcome`.
- Produces (`types.ts`; decisions re-declares the same shape locally in Task 3):
  ```ts
  export type ConnectorCallFailedReason = 'invalid-call' | 'not-connected' | 'needs-auth' | 'unavailable' | 'unreachable' | 'rejected';
  export type ConnectorCallUnknownReason = 'timeout' | 'interrupted';
  export interface ConnectorCallToolInput { userId: string; agentId: string; toolKey: string; input: Record<string, unknown> }
  export type ConnectorCallToolOutput =
    | { outcome: 'succeeded' }
    | { outcome: 'failed'; reason: ConnectorCallFailedReason }
    | { outcome: 'unknown'; reason: ConnectorCallUnknownReason };
  export const ConnectorCallToolInputSchema: z.ZodType;   // .strict(); userId/agentId min 1 max 256;
                                                          // toolKey /^mcp\.c[0-9a-f]{10}\.[\x21-\x7e]{1,128}$/; input z.record(z.unknown())
  export const ConnectorCallToolOutputSchema: z.ZodType;  // discriminatedUnion on `outcome`, each arm .strict()
  ```
- Produces (`call-tool.ts`):
  ```ts
  export interface CallToolDeps {
    bus: { call<I, O>(h: string, ctx: AgentContext, i: I): Promise<O>; hasService(h: string): boolean };
    callServer?: (opts: CallServerToolOptions) => Promise<ServerCallOutcome>; // test seam; default callServerTool
    now?: () => number;                                                       // test seam; default Date.now
  }
  export function createCallTool(deps: CallToolDeps): (callerCtx: AgentContext, rawInput: unknown) => Promise<ConnectorCallToolOutput>;
  ```
- Produces (`plugin.ts`): option `connectorCallServerTool?: (opts: CallServerToolOptions) => Promise<ServerCallOutcome>` (test seam, mirrors `connectorInventoryListTools`). It is registered only inside `if (connectorToolInventory)`, as `bus.registerService('connectors:call-tool', PLUGIN_NAME, createCallTool(...), { returns: ConnectorCallToolOutputSchema })`, with no `timeoutMs`.

**The handler's order. Every step before 9 sends nothing. The handler is total: it never throws.**
1. `safeParse` the input. On failure → `failed/invalid-call`. After it passes, use the ORIGINAL `rawInput.input` object for the send, never zod's copy (byte-faithful, and no `__proto__` re-assignment).
2. `callerCtx.userId !== input.userId || callerCtx.agentId !== input.agentId` → `failed/invalid-call`. `isOwnerlessId(userId) || isOwnerlessId(agentId)` (from `@ax/core`) → `failed/not-connected`.
3. Build `ctx = makeAgentContext({ sessionId: 'connector-call', agentId, userId, logger: callerCtx.logger })`, the same posture as describe-tools `:481-486`.
4. `agents:resolve { agentId, userId }`. If it throws a `PluginError` with code `not-found` or `forbidden` → `failed/not-connected`. Any other throw → `failed/unavailable`.
5. If `!bus.hasService('connectors:list-effective')` → `failed/unavailable`. Otherwise call it with `{ userId, attachmentIds, exclusions }` from the agent row, using the `stringList` handling of `auth-failure-recheck.ts:66-68,116-123`. A throw → `failed/unavailable`. If no entry's `toolNamespaces[].toolNamespace` equals the key's namespace → `failed/not-connected`.
6. `connectors:resolve { userId, connectorId }`. Use the same code mapping as step 4. Find the `{server}` whose `toolNamespace` is the key's namespace in the RESOLVED record, then the `capabilities.mcpServers` entry with that name, `transport: 'http'` and a non-empty `url`. If any is missing → `failed/not-connected`.
7. Validate the URL with the existing `assertAllowedServerUrl` (`connector-inventory/safe-fetch.ts:119-138`). A throw, a non-empty `hash`, or a `hostname` not in `capabilities.allowedHosts` (exact match, which is the proxy's rule) → `failed/unreachable`. The hash rule is parity with the session fold, which binds no credential to a URL with a fragment (`chat-orchestrator/src/connector-union.ts:906-913`).
8. `connectorHeaders(...)`: `'absent'` or `'needs-auth'` → `failed/needs-auth`; `'unavailable'` → `failed/unavailable`.
9. **The 45 s budget covers the whole handler, not just the network.**
   - Take `deadline = start + CALL_LIMITS.budgetMs` at handler entry.
   - Here, `left = deadline - Date.now()`. If `left < 15_000`, return `failed/unavailable` and send nothing. Slow pre-send hook reads must never push a send past the bus's 120 s ceiling, because the caller would then record a throw while the call is still going out.
   - Otherwise set `sent = true`, then return `callServer({ url, headers, tool, input, limits: { budgetMs: left } })` (`tool` = everything after `mcp.<ns>.`).
   - Unit test: `a handler whose pre-send reads used up the budget sends nothing`. Inject a clock seam `now?: () => number` on `CallToolDeps` that jumps 40 s during `agents:resolve`. Expect `failed/unavailable` and `callServer` not called.
10. A catch-all around steps 1–9 returns `sent ? { outcome: 'unknown', reason: 'interrupted' } : { outcome: 'failed', reason: 'unavailable' }`.

Log exactly one `connector_call_tool` line per call: `{ connectorId?, outcome, reason? }`. A credential read failure also logs `connectorHeaders`' own `connector_inventory_credential_unavailable` line (connector id and an error code). Never `input`, headers, URL or tool output.

**SECURITY.md new section** (house voice, short sentences), titled `## Approved connector calls (\`connectors:call-tool\`, TASK-1046)`. It covers:
- **who can trigger it:** the intended caller, `@ax/decisions`, after a decision's owner approves a held call and no live agent is there to make it (not enforced by the hook; SECURITY.md names the residual). It is not an IPC action, and the sandbox cannot reach it;
- **authorization:** re-derived from the decision's user and agent on every call (steps 4–8, in words);
- **reach:** the same guarded fetch and origin rules as the inventory. 30 s per request, 45 s in all, 2 MiB. One `tools/call`, never retried;
- **credentials:** the connector's plan refs via `credentials:get`, as the user and agent. They live in one transport's header map and are never logged, stored or returned;
- **injection:** the arguments are the approved call's recorded input, unchanged. The reply is read only for `isError`. Its content is dropped unread. Failures are short codes, never the server's text;
- **exactly-once:** the decision row is claimed before the call. A call that went out with no reliable answer is reported as "can't tell whether it finished".

Also reword the intro's first sentence, so it no longer claims nothing makes a host-side MCP call. Reword "This is the one place this package opens network connections" to cover both the inventory and approved calls.

- [ ] **Step 1: Write the failing unit tests** in `connector-call-tool.test.ts`. Each asserts the exact outcome and whether `callServer` was called.
  - `maps the namespace through the agent's effective set and sends the original input` — `callServer` gets the resolved server URL, the plan-bound header, `tool: 'save_comment'`, and `input` that is `toBe` the same object reference passed in. Returns `succeeded`.
  - `input that is not a plain object is invalid-call and nothing is sent`, with `it.each` over `[[]], [null], ['text']`. Every row gives `failed/invalid-call`, and `callServer` is not called. **(Review Focus 3)**
  - `a ctx for another user or agent is refused` → `failed/invalid-call`, no send.
  - `an agent the user can no longer resolve is not-connected` (agents:resolve throws `PluginError{code:'forbidden'}`) → `not-connected`. With a non-PluginError throw → `unavailable`.
  - `a namespace outside the effective set is not-connected` → no `connectors:resolve` call, no send.
  - `missing connectors:list-effective fails closed as unavailable`.
  - `a server host outside the connector's allowedHosts is unreachable and nothing is sent`.
  - `no stored sign-in is needs-auth; a vault blip is unavailable` (credentials:get throws `PluginError{code:'credential-not-found'}` / a plain Error).
  - `passes the transport's outcome through` with `it.each` over the five `ServerCallOutcome` values.
  - `a throw after the send is unknown, before it is unavailable` (a `callServer` that throws → `unknown/interrupted`; a `connectors:resolve` stub that throws an unexpected value → `failed/unavailable`).
  - `logs codes only` (capture logger fields; `JSON.stringify(fields)` contains no input value, no header value and no URL).
- [ ] **Step 2: Write the failing wiring test** in `connector-inventory-wiring.test.ts`: `describe('connectors:call-tool through the real connectors:resolve + list-effective (TASK-1046)')`. It uses the real `McpServer` with a registered `save_comment` tool that records its arguments and the request headers it received.
  - **Seed:** the file's existing seed (`seedConnector`, `:186-205`) already lists `HOST` in `allowedHosts`, which step 7's parity check needs. Its key is bound as an `X-Api-Key` header on server `primary` (`:193-200`), not `Authorization`.
  - **Transport:** inject it with the `connectorCallServerTool` seam, forwarding to `callServerTool({ ...opts, baseFetch: loopbackFetch })`, the same way `boot()` injects `connectorInventoryListTools` (`:166-169`).
  - **Attachments:** `boot()`'s `agents:resolve` stub is fixed at `connectorAttachments: [CONNECTOR_ID]` (`:155-158`). Make it read a module-level `let agentAttachments: string[]` (reset to `[CONNECTOR_ID]` in `afterEach`), so one case can empty it. New connector rows are `requires_attachment: true` (`packages/connectors/src/store.ts:640`), so an empty list really yields `not-connected`.
  - `an attached connector's approved call reaches the real MCP server once, with the plan-bound key` — the `primary` server's tool ran exactly once, its arguments deep-equal the input, its `x-api-key` header equals `SECRET`, and the outcome is `succeeded`.
  - `a connector that is not attached to the agent is not-connected and the server never sees a tools/call`.
  - `a tool that answers isError is failed/rejected`.
- [ ] **Step 3: Run** `pnpm --filter @ax/mcp-client test`. Expected: the new tests FAIL.
- [ ] **Step 4: Implement** `types.ts` additions, `call-tool.ts`, and the plugin registration and seam. Update the two manifest pins. Write the SECURITY.md section.
- [ ] **Step 5: Run** `pnpm --filter @ax/mcp-client test && pnpm --filter @ax/mcp-client build && pnpm --filter @ax/preset-k8s test`. Expected: PASS. That includes `boot-graph.test.ts` and `prod-bootstrap` (`registerService` now runs in the real preset).
- [ ] **Step 6: Commit** `feat(mcp-client): connectors:call-tool re-derives access and makes one approved call (TASK-1046)`.

## Task 3 [tier: sensitive]: decisions — route approved connector calls to the host

**Files:**
- Create: `packages/decisions/src/host-executor.ts`
- Create: `packages/decisions/src/connector-replay.ts`
- Modify: `packages/decisions/src/replay.ts:44-55` (`ReplayOutcome`), `:118-133` (`replayOnApprove` dispatch), `:254-326` (`settleReplay` unknown branch)
- Modify: `packages/decisions/src/plugin.ts:737` (`hasExecutor`), and `:261-301` (new `optionalCalls` entry, placed right after the `CONNECTOR_TOOL_LABELS_HOOK` entry)
- Modify: `packages/decisions/src/expiry.ts:241`
- Modify: `packages/decisions/src/store.ts` (interface near `:331-367`; impl next to `markFailed` `:867-880`) and `packages/decisions/src/__tests__/fake-store.ts:286-297`
- Modify: `packages/decisions/src/templates.ts` (new detail constants)
- Modify: `packages/decisions/src/types.ts:274-292` (`replayAbandonedAt` doc: a second writer, see below)
- Tests: `__tests__/host-executor.test.ts` (new), `__tests__/connector-replay.test.ts` (new), `__tests__/replay.test.ts`, `__tests__/store.test.ts`, `__tests__/templates.test.ts`
- Modify: `presets/k8s/src/__tests__/preset.test.ts:515-523` (decisions `optionalCalls` pin), plus one new test (Step 1).

**Interfaces:**
- Consumes: Task 2's hook contract (re-declared locally; never imported).
- Produces (`host-executor.ts`):
  ```ts
  export const CONNECTOR_CALL_TOOL_HOOK = 'connectors:call-tool';
  export type ConnectorCallFailedReason = 'invalid-call' | 'not-connected' | 'needs-auth' | 'unavailable' | 'unreachable' | 'rejected';
  export const ConnectorCallOutcomeSchema: z.ZodType<
    { outcome: 'succeeded' } | { outcome: 'failed'; reason: ConnectorCallFailedReason } | { outcome: 'unknown'; reason: 'timeout' | 'interrupted' }>;
  export type HostExecutor = { kind: 'tool'; hook: string } | { kind: 'connector' };
  /** A connector toolKey (parseConnectorToolKey !== null) is host-executable ONLY via the connector hook — never via a
   *  `tool:execute:<key>` even if one exists. Anything else needs `tool:execute:<name>`. Null means the host cannot run it. */
  export function hostExecutorFor(bus: Pick<HookBus, 'hasService'>, toolName: string): HostExecutor | null;
  ```
- Produces (`connector-replay.ts`): `export async function replayConnectorCall(args: { bus: HookBus; ctx: AgentContext; decision: Decision }): Promise<ReplayOutcome>`. It never throws.
- Produces (`replay.ts`): `ReplayOutcome` gains `outcomeUnknown?: true`. Doc: the host sent the call and got no reliable answer, so it may or may not have happened.
- Produces (`store.ts`): `markOutcomeUnknown(decisionId: string, nowIso: string): Promise<Decision | null>`. It is `transition(decisionId, ['executed'], { status: 'failed', replay_abandoned_at: new Date(nowIso), replay_error: null, replay_due_at: null })`. `resolved_at` is untouched. The fake store mirrors it.
- Produces (`templates.ts`), exact copy:
  ```ts
  export const CONNECTOR_CALL_DETAIL: Readonly<Record<ConnectorCallFailedReason, string>> = {
    'invalid-call': "The request wasn't in a form we could send.",
    'not-connected': "We couldn't find this connector on this agent.",
    'needs-auth': "The sign-in for this connector didn't work.",
    unavailable: "We couldn't check this connector just now.",
    unreachable: "We couldn't reach this connector's service.",
    rejected: "This connector's service turned the request down.",
  };
  export const CONNECTOR_POLICY_DENIED_DETAIL = "This agent's settings for this tool now block it.";
  export const CONNECTOR_POLICY_UNREADABLE_DETAIL = "We couldn't check this agent's settings for this tool.";
  ```

**`replayConnectorCall`'s order:**
1. `bus.call('tool-policy:evaluate', ctx, { call: { name: decision.call.name, input: decision.call.input }, agentId: decision.agentId })` with a local `z.object({ verdict: z.enum(['allow', 'hold', 'deny']) }).passthrough()` safeParse.
   - `deny` → `{ executed: false, path: null, error: CONNECTOR_POLICY_DENIED_DETAIL }`.
   - A throw or unparseable answer → `{ …, error: CONNECTOR_POLICY_UNREADABLE_DETAIL }`.
   - In both cases the connector hook is NOT called. Log `decision_connector_replay_refused { decisionId, tool, reason: 'policy-deny' | 'policy-unreadable' }`.
2. `bus.call(CONNECTOR_CALL_TOOL_HOOK, ctx, { userId: decision.ownerUserId, agentId: decision.agentId, toolKey: decision.call.name, input: decision.call.input })`.
3. `ConnectorCallOutcomeSchema.safeParse` the answer:
   - `succeeded` → `{ executed: true, path: 'host-replays', error: null }`, plus log `decision_replayed`;
   - `failed` → `{ executed: false, path: null, error: CONNECTOR_CALL_DETAIL[reason] }`, plus log `decision_replay_failed { decisionId, tool, reason }`;
   - `unknown`, an unparseable answer, or ANY throw from the hook call (including the bus's own `timeout` / `invalid-return`) → `{ executed: false, path: null, error: null, outcomeUnknown: true }`, plus log `decision_connector_replay_unknown { decisionId, tool, reason }`. `reason` is the code, or `'threw'` / `'unreadable'`. Never log the error's message.

**Wiring:**
- `replayOnApprove` → `const executor = hostExecutorFor(bus, decision.call.name)`. `null` → today's park return. `kind: 'connector'` → `return replayConnectorCall(...)`. `kind: 'tool'` → today's path with `executor.hook`, routine handling untouched. Connector keys are never routine tools (`routineToolKind` is null for them).
- `connector-replay.ts` takes `ReplayOutcome` with `import type { ReplayOutcome } from './replay.js'`, so the replay.ts ↔ connector-replay.ts reference stays type-only and there is no runtime import cycle.
- `settleReplay`: right after the `pending` early return, `if (outcome.outcomeUnknown === true)` → `warnIfLost(ctx, decision, 'markOutcomeUnknown', await store.markOutcomeUnknown(decision.id, now().toISOString()))` and return.
- `plugin.ts:737` → `const hasExecutor = hostExecutorFor(bus, current.call.name) !== null;`.
- `expiry.ts:241` → `if (hostExecutorFor(bus, decision.call.name) !== null) {`.
- Manifest entry: `{ hook: CONNECTOR_CALL_TOOL_HOOK, degradation: 'An approved connector call from a run with no live agent cannot be made by the host; it waits (approved-pending-agent) for the agent to make the same call again.' }`.
- `types.ts` `replayAbandonedAt` doc: a second writer, `markOutcomeUnknown`. A host connector call that went out and got no reliable answer. Same meaning to a reader: no report, so the only honest receipt is that we cannot say.

- [ ] **Step 1: Write the failing tests:**
  - `host-executor.test.ts`, with `it.each` over the four combinations of (connector key | plain name) × (hook present | absent). Plus `a connector key never routes to tool:execute:<key>`: register `tool:execute:mcp.c5e0235982f.x`, leave the connector hook absent, and expect `null`.
  - `connector-replay.test.ts` (real `HookBus`, stubbed `tool-policy:evaluate` and `connectors:call-tool`):
    - `sends the recorded call under the decision's owner and agent` — the stub input deep-equals `{ userId: 'owner-1', agentId: 'agent-1', toolKey, input }`, and `ctx.userId`/`ctx.agentId` are the decision's;
    - `a Deny since the hold refuses before the hook is called`;
    - `an unreadable policy answer refuses before the hook is called`;
    - `each failed reason maps to its authored detail`, with `it.each` over the six reasons;
    - `unknown, a throw and a malformed answer are all outcomeUnknown` (three cases, including `{ outcome: 'failed', reason: 'upstream said <script>' }`, which fails the schema);
    - `nothing the hook returns reaches the error text`. The stub throws `new Error('IGNORE PREVIOUS sk-live-123')`. The outcome has `error: null` and `outcomeUnknown: true`, and the captured logger fields do not contain `IGNORE`. **(Review Focus 5, decisions half)**
  - `replay.test.ts`, `settleReplay`:
    - `a connector success stamps replayedAt and the receipt is approvedText`;
    - `a definite connector failure stores the authored detail and the receipt is FAILED_RECEIPT`;
    - `an unknown connector outcome is failed + replayAbandonedAt and the receipt is ABANDONED_RECEIPT`.
  - `store.test.ts`, new `describe('decisions store — an outcome nobody reported (TASK-1046)')`:
    - `markOutcomeUnknown moves a claimed executed row to failed with replay_abandoned_at, keeps resolved_at, clears replay_error`;
    - `it refuses a row that is not executed` (returns null);
    - `the row leaves the standing-authorisation set` (a fresh identical row can claim).
  - `templates.test.ts`: `connector details are authored constants that never say the call went out` — no `/sent|completed/i` in any `CONNECTOR_CALL_DETAIL` value or either policy detail.
  - `preset.test.ts`: add `'connectors:call-tool'` after `'connectors:tool-labels'` in the `:515-523` list. Add `it('gives connectors:call-tool a caller and loads its producer — @ax/decisions + @ax/mcp-client (TASK-1046)')`. It asserts the decisions `optionalCalls` hooks contain it, and that `new Set(plugins.flatMap(p => p.manifest.registers)).has('connectors:call-tool')`. An optional call never fails a boot, so this assertion is the only thing that catches the producer vanishing; the comment says so, like `:526-540`.
- [ ] **Step 2: Run** `pnpm --filter @ax/decisions test` (Docker for the store suite). Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `host-executor.ts`, `connector-replay.ts`, `markOutcomeUnknown` (+ fake), the template constants, and the four call-site edits.
- [ ] **Step 4: Run** `pnpm --filter @ax/decisions test && pnpm --filter @ax/decisions build && pnpm --filter @ax/preset-k8s test`. Expected: PASS. The existing `parks a sandbox-only tool…` canary still passes, because `skill_propose` is not a connector key.
- [ ] **Step 5: Commit** `feat(decisions): approved connector calls with no live agent run on the host (TASK-1046)`.

## Task 4 [tier: integration]: decisions canary — the connector path through real Postgres + real tool-policy

**Files:**
- Modify: `packages/decisions/src/__tests__/decisions.canary.test.ts`. Add a new `describe('decisions canary — approved connector calls run on the host (TASK-1046)')` after the TASK-736 describe at `:2619`. Reuse `boot` (`:65-134`), `routineCtx`/`userCtx` (`:211-231`), `holdAndId` (`:267`), `approve` (`:277`), `readDecision` (`:288`), `readReceipts` (`:310`) and `liveChannels` (`:161`). Add a local `recordConnectorCalls(h, outcome = { outcome: 'succeeded' })` helper that `h.bus.registerService('connectors:call-tool', '@ax/decisions/test/connectors', …)`, records `{ input, ctx }` and returns `outcome`. It is modeled on `recordExecutor` `:246-264`.

**Interfaces:** Consumes Task 3. Produces nothing.

Fixture: `const CONNECTOR_CALL = { id: 'c-conn', name: 'mcp.c5e0235982f.save_comment', input: { issueId: 'ENG-1', body: 'Shipped', nested: { b: 2, a: [1, 2] } } }`. With no stored verdicts the real tool-policy answers `hold` (the implicit connector ceiling).

- [ ] **Step 1: Write the tests:**
  - `an unattended connector approval is made by the host, once, byte for byte, as the decision's owner`. Hold via `routineCtx`, approve via `userCtx`. The stub saw exactly one call with `input` `{ userId: 'u1', agentId: 'a1', toolKey: CONNECTOR_CALL.name, input: CONNECTOR_CALL.input }` and `ctx.userId === 'u1'`, `ctx.agentId === 'a1'`. `out.executed === true`, `out.path === 'host-replays'`. The row is `executed` with `replayedAt` set. The receipt is the row's `approvedText`. An identical `tool:pre-call` afterwards holds again, and the stub count is still 1.
  - `an attended connector decision whose session has since ended is made by the host at once`. Mirror `:1484-1538`: `const channels = liveChannels()`, hold via `userCtx` (attendance `attended`), then `channels['conv-web']!.activeSessionId = null`, then approve. Stub count 1, `out.path === 'host-replays'`, `out.pendingUntil === null`, `h.delivered` is `[]`, `replayClaimedAt` and `replayedAt` are set.
  - `a session that dies before the hand-over falls back to the host's connector call`. Mirror `:1613-1650`: `movableClock()`, boot with `liveChannels()` and `{ throws: 'unknown-session' }`, hold via `userCtx`, approve (`out.path === 'agent-executes'`, stub count 0), `clock.pastWindow()`, `sweepNow(h, sweeper)` → `delivered === 1`. Stub count 1, `replayedAt` set, and an identical `tool:pre-call` afterwards holds.
  - `a Deny saved after the hold stops the call`. After `holdAndId`, call `h.bus.call('tool-policy:set-agent-override', userCtx(h), { agentId: 'a1', toolKey: CONNECTOR_CALL.name, verdict: 'deny' })`, then approve. Stub count 0. The row is `failed`, `replayError === CONNECTOR_POLICY_DENIED_DETAIL`, and the receipt is `FAILED_RECEIPT` with `error === CONNECTOR_POLICY_DENIED_DETAIL`.
  - `a refused call fails honestly and spends the yes`. The stub returns `{ outcome: 'failed', reason: 'rejected' }`. Row `failed`, receipt `FAILED_RECEIPT`, `error === CONNECTOR_CALL_DETAIL.rejected`. A re-issued identical call holds.
  - `a call with no reliable answer never reads as nothing-completed`. The stub returns `{ outcome: 'unknown', reason: 'timeout' }`. Row `failed`, `replayAbandonedAt` not null. Receipt `ABANDONED_RECEIPT`. `decisions:undo` answers `undone: false`.
  - `without connectors:call-tool a connector approval still parks`. No stub. `out.decision.status === 'approved-pending-agent'`, receipt `PENDING_AGENT_RECEIPT` (the constant, so Task 5 does not break it).
  - `two concurrent approvals make the connector call exactly once`, following `:906`.
  - `a connector flight stranded by a crash is given up, never re-sent`. Reuse `strandOnACrash`'s shape (`:2305-2341`), parametrized so the dead host holds `CONNECTOR_CALL` and registers a `connectors:call-tool` stub that records and never resolves, through the immediate path. Then boot the recovered host at `T_RECOVERED` with a fresh recording `connectors:call-tool` stub, as `:2343-2368` does with `recordExecutor`. Assert: `(await sweep(h)).reclaimed === 1`, the recovered stub's calls are `[]`, the row is `failed` with `replayAbandonedAt` set, and the receipt is `ABANDONED_RECEIPT`.
- [ ] **Step 2: Run** `pnpm --filter @ax/decisions test -- decisions.canary` (Docker). Expected: PASS on the Task 3 code. A failure here is a Task 3 bug: fix it in Task 3's files, with the failing test kept.
- [ ] **Step 3: Commit** `test(decisions): canary for host-made connector approvals (TASK-1046)`.

## Task 5 [tier: mechanical]: say plainly what a parked approval will do

**Files:**
- Modify: `packages/decisions/src/templates.ts:407-415` (`PENDING_AGENT_RECEIPT` value and its doc comment)
- Modify: `packages/decisions/src/__tests__/templates.test.ts:293-296`. Replace `/next time it runs/i` with `/next time it tries/i`, and add `expect(PENDING_AGENT_RECEIPT).toBe('Approved — it can do this the next time it tries.')`.
- Modify: `packages/decisions/src/__tests__/decisions.canary.test.ts`. The three assertions at `:903`, `:1564` and `:1718` become `toContain('the next time it tries')`. Update the comments at `:1546` and `:1714` to match.
- Modify comments that quote the old receipt: `packages/decisions/src/__tests__/receipts.test.ts:110` and `packages/decisions/src/receipts.ts:97`.
- Modify: `packages/channel-web/src/components/workspace/decision-copy.ts:132-139`, and the header comment `:32-36` where it quotes the old line.
- Modify comments that quote the old line: `packages/channel-web/src/components/workspace/DecisionRow.tsx:19-20` and `packages/channel-web/src/lib/workspace-decisions.ts:16`.
- Test: `packages/channel-web/src/components/workspace/__tests__/decision-renderers.test.tsx`. Add the literal pin below.

**Exact copy:**
```ts
// decisions/src/templates.ts AND channel-web decision-copy.ts (DECISION_PENDING_AGENT) — identical
'Approved — it can do this the next time it tries.'
// channel-web decision-copy.ts DECISION_PENDING_AGENT_NOTE (review F9 dropped ", and that run had already ended")
'Nothing has happened yet. It can only do this during one of its own runs. If a later run makes exactly this request, it goes ahead without asking you again.'
```
Why: the old line promised the action would happen. It happens only if a later run makes the identical call, which is exactly what never happens for a webhook comment. The new pair is true for the parked case and for TASK-517's attended "told, not yet re-issued" case.

- [ ] **Step 1:** Update the tests first. Add `it('the parked line and note say plainly what will happen (TASK-1046)')` in `decision-renderers.test.tsx`, asserting both literals. Then run `pnpm --filter @ax/decisions test -- templates` and `pnpm --filter @ax/channel-web test -- decision-renderers`. Expected: FAIL.
- [ ] **Step 2:** Change the constants and comments.
- [ ] **Step 3:** Run `pnpm --filter @ax/decisions test && pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build` (channel-web's tsc includes test files). Expected: PASS.
- [ ] **Step 4:** Commit `fix(decisions,channel-web): a parked approval says plainly what will happen (TASK-1046)`.

## Task 6 [tier: integration]: the card says "can't tell" when the outcome is unknown

**Files:**
- Modify: `packages/channel-web/src/server/routes-workspace.ts`. Add `replayAbandonedAt?: string | null` to the `StoredDecision` mirror at `:932-990` (optional: an older producer omits it). In `toWireDecision`, next to `undoable` (`:2791-2801`), derive `outcomeUnknown: stored.status === 'failed' && (stored.replayAbandonedAt ?? null) !== null`.
- Modify: `packages/channel-web/src/lib/workspace-types.ts:300-322`. Add `outcomeUnknown?: boolean` to the wire `Decision`, with a doc comment: server-derived, true when the host made the call and got no reliable answer. Optional, like `checkIn`, so fixtures need no churn.
- Modify: `packages/channel-web/src/components/workspace/decision-copy.ts`. Add two constants and branch the `failed` arm of `decisionOutcome` (`:406-408`).
- Tests: `packages/channel-web/src/__tests__/server/routes-workspace-decisions.test.ts` and `packages/channel-web/src/components/workspace/__tests__/decision-renderers.test.tsx`.
- Modify pin: `packages/channel-web/src/__tests__/server/routes-workspace.test.ts:2243-2270`. `WIRE_KEYS` pins the exact key set of every wire decision (checked at `:2355`, `:2463`, `:3457`, `:3528`). Insert `'outcomeUnknown'` in its sorted position, because `toWireDecision` now always sends it.

**Exact copy** (the two concatenated with one space are word for word `ABANDONED_RECEIPT`, `packages/decisions/src/templates.ts:383-385`):
```ts
export const DECISION_OUTCOME_UNKNOWN = 'This was interrupted while it was running, so we cannot tell you whether it finished.';
export const DECISION_OUTCOME_UNKNOWN_NOTE = 'Worth checking before you approve it again.';
```
In the `failed` arm: `d.outcomeUnknown === true ? { line: DECISION_OUTCOME_UNKNOWN, note: DECISION_OUTCOME_UNKNOWN_NOTE, tone: 'bad' } : { line: DECISION_FAILED, note: DECISION_FAILED_NOTE, tone: 'bad' }`.

- [ ] **Step 1: Write the failing tests:**
  - routes: `a failed row with replayAbandonedAt projects outcomeUnknown: true; without it, or on any other status, false`. Also `replayAbandonedAt itself never crosses the wire`.
  - renderers: add `{ name: 'failed, outcome unknown', decision: resolvedFixture('failed', { undoable: false, outcomeUnknown: true }), line: DECISION_OUTCOME_UNKNOWN }` to the `cases` table that drives `says the same thing in both places` (`decision-renderers.test.tsx:102-137`). Then add `it('an outcome-unknown failure never says nothing was completed')`: for both `queueText` and `cardText`, the text does not contain `DECISION_FAILED_NOTE`. Plus `the unknown pair matches the server's abandoned receipt word for word`: `${DECISION_OUTCOME_UNKNOWN} ${DECISION_OUTCOME_UNKNOWN_NOTE}` equals the literal `'This was interrupted while it was running, so we cannot tell you whether it finished. Worth checking before you approve it again.'`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test -- routes-workspace-decisions decision-renderers`. Expected: FAIL.
- [ ] **Step 3: Implement** the projection field, the wire type and the copy branch. This is UI copy inside existing shadcn renderers; no new component.
- [ ] **Step 4: Run** `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(channel-web): a call with no reliable answer reads as "can't tell", not "nothing completed" (TASK-1046)`.

## Task 7 [tier: mechanical]: rule 5 — fix the lines that made "parked" look like the only answer

**Files** (prose only; no behaviour):
- `packages/decisions/src/replay.ts:5-31` (header). "THE CONSTRAINT, STATED OUT LOUD: the host can only replay a call whose tool has a host-side executor…" now reads: the host replays through a host executor. That is a `tool:execute:<name>` hook, or, for a connector toolKey `mcp.<ns>.<tool>`, `@ax/mcp-client`'s `connectors:call-tool` (TASK-1046), which re-derives access from the decision. It parks only when neither exists (`skill_propose`). Keep the dynamic-hook-name paragraph.
- `packages/decisions/src/plugin.ts:684-693` (routing table comment: "unattended, no executor → the host physically cannot make this call"). Say "no host executor (`hostExecutorFor`)" and name the connector case. `:238-251` (manifest note): add one sentence saying `connectors:call-tool` is a NAMED optional call, unlike the dynamic `tool:execute:<name>`.
- `packages/decisions/src/types.ts:74-86`. In the `approved-pending-agent` paragraph, "the host physically CANNOT make" now covers no `tool:execute:<name>` AND, for connector keys, no `connectors:call-tool`. In the `failed` paragraph, add "or the host sent a connector call and got no reliable answer (`replayAbandonedAt`)".
- `packages/decisions/src/expiry.ts:188-197` (`runDueDeliveries` doc). "Gated on the executor existing" now says "gated on a host executor (`hostExecutorFor`)".
- `packages/decisions/src/expiry.ts:49-57` (`STRANDED_REPLAY_TIMEOUT_MS` derivation). The comment says "A host replay is one `bus.call('tool:execute:<name>')` … cannot outlast 120 s". A connector replay is two calls in a row, `tool-policy:evaluate` then `connectors:call-tool`, and `connectors:call-tool` bounds itself at 45 s. So the ceiling is about 240 s plus the store writes. Fifteen minutes still leaves headroom; the value does not change.
- `packages/decisions/src/replay.ts:18` and `packages/decisions/src/types.ts:78` say the agent "performs it the next time it runs". In the paragraphs rewritten above, say instead that it goes ahead if a later run makes the identical call. That keeps them consistent with Task 5's copy.
- `packages/decisions/src/receipts.ts:154-168` (`failed` comment). The abandoned kind now also covers a host connector call with no reliable answer.
- `packages/decisions/src/templates.ts:313-339`. "a call the host cannot even attempt (sandbox-only tool)" stays true. Add that connector calls are attempted host-side since TASK-1046.
- `docs/plans/2026-05-24-current-architecture.md:126` ("Host tool execution" row). After "MCP reaches agents only through connectors.", add: "One host-side exception (TASK-1046): when a person approves a held connector call and no live agent is there to make it, `@ax/decisions` has `@ax/mcp-client` make that one call (`connectors:call-tool`, not an IPC action) with the decision owner's connector credentials." `:131` (Credentials row): add "(the host's own `connectors:call-tool` reads the real value through `credentials:get` for one approved call)".

- [ ] **Step 1:** Make the edits. Then `grep -rn "physically cannot\|can only replay a call" packages/decisions/src` should show no stale sentence that omits the connector case.
- [ ] **Step 2:** Run `pnpm --filter @ax/decisions build && pnpm lint`. Expected: PASS.
- [ ] **Step 3:** Commit `docs: host replay covers approved connector calls (TASK-1046)`.

## Final verification and PR

- [ ] `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. Read every package's result: `--no-bail` keeps going past a failure, so a red package does not stop the run.
- [ ] Invoke `security-checklist`. Paste its note, plus the Boundary review section above, into the PR body.
- [ ] Commit the decisions shard `.claude/memory/decisions/2026-11-05-TASK-1046.md` with the work.
- [ ] Out of scope, for the PR body's follow-ups:
  - should outward connector writes defer by the undo window (`irreversible` for connector keys);
  - skill-referenced connectors in the host's effective-set check;
  - a `(walk)` card for a real Linear webhook → Allow → comment-posted check on kind.
