# TASK-1122: What an Outsider's Slack Turn Can Persist (Outside Memory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An outsider's turn (`ctx.source: 'external'`, a Slack channel turn by someone with no access to the agent) can change nothing the agent later reads as its own. Today five write paths let it. Close them, pin every existing refusal, and leave the settings copy ("never remembers what anyone else says") true.

**Architecture:** Each new refusal sits at the host gate that already owns the write: `@ax/routines` `prepare()`, ipc-core's `artifact.publish` and `conversation.store-runner-session` handlers, skill-broker's cold-start submit, and sandbox-k8s's session open. The session open asks the files resolver for a read-only `/files` and keeps that pod out of the warm pool. Every gate asks `isOutsiderTurn(ctx)` from `@ax/core`. The chat orchestrator also hides the newly refused tools from an outsider's catalog, as TASK-1091 did for the proposal tools. The runner tells the agent its files are read-only.

**Tech Stack:** TypeScript, vitest, the hook bus (`@ax/core`), Kubernetes pod specs (sandbox-k8s).

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` §2, §2a, §6. Predecessor audits: `docs/plans/2026-11-12-task-1091-ctx-external-audience-plan.md` (consumers of `source`) and TASK-1094 PR B review F1 (outsiders' words never remembered). Decisions: `.claude/memory/decisions/2026-11-17-TASK-1122.md`.

## Why the card looked settled, and what is actually open

Design §2 (`:74-75`) says: "No identity edits, skill authoring or connector requests are allowed, and both proposal tools are hidden from external turns." Read as a complete list, it made "what can an outsider persist" look answered. TASK-1091's audit asked a different question: which code branches on `source`. Paths that never branch on `source` were never examined. Five of them write durable state from an outsider's turn with no outsider check:

1. **The agent's `/files` home is mounted read-write** (`sandbox-k8s/src/open-session.ts:246-255`). It is the SDK's HOME and cwd (`agent-claude-sdk-runner/src/main.ts:429,470`). Every later session puts `/files/bin` on PATH. Tools read HOME dotfiles (`.npmrc`, `.ssh/config`, a cloned repo's `.git/hooks`). `skill_propose` reads drafts from `/files/.skill-draft/`. Members see the files in the Files tab. So this is a lasting code-execution path into members' private sessions, not only a prompt-injection one.
2. **`artifact.publish`** (`artifact_publish`, `show_visual`). The artifact list (titles and paths) goes into the system prompt of every later session, agent-wide, private ones included (`attachments/src/artifacts/augment.ts:64-88`). A publish can also add a version to an artifact made in a private chat, by path or by `artifactId`, and its share links then serve that version (`attachments/src/artifacts/store.ts:258-344`). The wire accepts an `artifactId` with `visual: true` too.
3. **Routine writes.** Routine consent belongs to `ctx.userId`, which is the connector. It turns a repeat-routine create, and any edit that leaves the brief alone, from `hold` into `allow` (`tool-policy/src/plugin.ts:700-707`, `routines-contract/src/tools.ts:135-153`). An outsider's text can become a routine that runs later, unattended, as the connector.
4. **Cold-start catalog requests.** A `search_catalog` or `request_capability` miss files the model's free-text need into the admins' queue in the connector's name (`skill-broker/src/tools/coldstart.ts:70-86`). This is the same harm class as `connector_propose`, which TASK-1091 refused.
5. **`conversation.store-runner-session`** is scoped by user only (`conversations/src/store.ts:921-935`). An outsider session's runner can bind a runner session id onto any of the connector's private conversations. That conversation's next pod joins the id unvalidated into a filename (`agent-claude-sdk-runner/src/jsonl-transcript-source.ts:154`).

Memory is covered (TASK-1094) and is not touched here. TASK-1136 is changing memory in parallel.

## Approaches considered

- **A. Refuse at each owning gate, and make `/files` read-only for an outsider's session (chosen).** Every gate keys on `isOutsiderTurn` (TASK-1091's pattern). The files decision belongs to the sandbox provider, which grants the session's capabilities (invariant 5), through the resolver's existing `readOnly` input ("never widens, only narrows"). Reads stay: the design says a channel agent's files are readable in every turn.
- **B. Correct the copy instead.** "Never remembers" becomes "can change its files, tasks and artifacts". Rejected: it leaves a lasting code-execution and prompt-injection path from the least-trusted speaker into members' private turns, the exact path TASK-1094 F1 closed for memory.
- **C. No `/files` for outsiders**, like `/memory` for a shared audience. Rejected: it breaks the design's readable files and TASK-992's required home (sandbox-k8s refuses an owned session with no user-files mount).

The shared pool needs its own decision. Production runs shared pools (Helm rev 32, 2026-10-02). The storage helper bind-mounts `user-files` read-write whatever the pod's `readOnly` says (`sandbox-k8s/src/storage-node/engine.ts:121-133` remounts only `memory` read-only). So a read-only home must not take a warm standby, or the decision is silently void in production. The chosen route sends it to the direct (cold) path. Teaching the helper a read-only bind is a follow-up: it changes a privileged component and its protocol.

## YAGNI pass

Each task is load-bearing:

- Tasks 1, 2, 3 and 7 close paths that a later private turn reads.
- Task 4 keeps the agent's instructions true. Without it, the agent is told to save into a home that refuses every write.
- Task 5 is TASK-1091's settled "refuse and hide". Without it, every chart an outsider asks for fails after uploading a blob.
- Task 6 keeps the outsider rule consistent with `connector_propose`. It is one line.
- Task 8 fixes the lines that made the card look settled.

Cut, each filed as a follow-up below:

- A read-only bind in the shared-pool helper.
- Validating `runnerSessionId` at use.
- `artifact.publish` accepting `artifactId` with `visual: true` in members' sessions.
- Outsiders reading routine briefs.

Left unchanged on purpose:

- `sandbox-subprocess` and `workspace-localdir`. channel-slack loads only in `presets/k8s`, and the subprocess sandbox has no filesystem isolation anyway (its SECURITY.md).
- Memory, which TASK-1136 owns.

## The write-path audit (acceptance 1)

Every write an outsider's turn can reach. "Feeds a private turn?" asks whether a later turn of a member (or of the owner, unattended) reads it as the agent's own context.

**A. The agent's own state: refused**

| # | Write path | Where decided | Decision | Why | Feeds a private turn? | Pinned by |
|---|---|---|---|---|---|---|
| 1 | Memory extraction of the `:external` thread | `channel-slack/src/capture-veto.ts:57` (`channel-external-turn`) | refused (TASK-1094) | integrity: an outsider's words would come back as facts with full authority | yes: the recall block in every spawn, team-wide | `channel-slack/src/__tests__/capture-veto.test.ts` (`OUTSIDER_THREAD`). TASK-1136 in flight: no edits here |
| 2 | `memory_note` | `memory/src/note-tool.ts:238` asks `memory:pre-capture`, so row 1's veto refuses it | refused (TASK-1094) | same | yes | `memory/src/__tests__/note-tool.test.ts`; `capture-veto.test.ts` |
| 3 | Identity, soul, Instructions (`update_identity`, `complete_bootstrap`) | `agents/src/identity/tools.ts:250,344`; hidden by `identityToolScope` (`chat-orchestrator/src/orchestrator.ts:1629`) | refused (TASK-1091) | a permanent change to the agent | yes: every spawn's system prompt | `agents/src/__tests__/identity-tools.test.ts:342,770`; `orchestrator.test.ts:8845,8866` |
| 4 | Skills (`skill_propose` → `skill.propose`) | `ipc-core/src/handlers/skill-propose.ts:130`; hidden (`PROPOSAL_TOOLS`, `orchestrator.ts:1497`) | refused (TASK-1091) | a clean authored skill goes active with no human | yes: active drafts listed per spawn | `ipc-core/src/__tests__/skill-propose-handler.test.ts:356`; `orchestrator.test.ts:1932-1951` |
| 5 | Connector requests (`connector_propose`) | `tool-connector-propose/src/plugin.ts:248`; hidden | refused (TASK-1091) | admin queue, outsider-worded, in the owner's name | only once an admin approves (a usage note per spawn) | `tool-connector-propose/src/__tests__/plugin.test.ts:272` |
| 6 | Task check-in output (`routine_report`, `routine_read_update`) | `routines/src/tools.ts:66,113` (`source !== 'routine'`) | refused | only a task's own check-in reports | yes: task state | `routines/src/__tests__/report-tool.test.ts:394`; `task-update-read.test.ts:31` |
| 7 | **The agent's files** (Bash, Write, Edit, NotebookEdit into `/files`; `/files/bin`; HOME dotfiles; `.skill-draft/`) | today nothing checks: `sandbox-k8s/src/open-session.ts:246-255` resolves it writable | **refused (new, Tasks 3-4)**: read-only for an outsider's session, reads allowed | HOME and cwd of every later session; code-execution persistence | yes: later sessions' HOME, cwd and PATH; on-demand reads; members' Files tab | Task 3, Task 4 |
| 8 | **Artifacts and charts** (`artifact_publish`, `show_visual` → `artifact.publish`) | today nothing checks: `ipc-core/src/handlers/artifact-publish.ts:67-86` | **refused (new, Task 2)**, and hidden (Task 5) | the list is in every spawn's prompt; versions land on private artifacts; share links | yes, automatically | Task 2, Task 5 |
| 9 | **Routines and tasks** (`routine_create/update/delete/fire_now`) | today a hold that the connector's routine consent can lift (`tool-policy/src/plugin.ts:700-707`) | **refused (new, Task 1)**, and hidden (Task 5). Reads stay | outsider text would run later, unattended, as the connector | yes: later runs; `routine_get` in private turns | Task 1, Task 5 |
| 10 | **Runner session binding** (`conversation.store-runner-session`) | today scoped by user only (`conversations/src/store.ts:921-935`) | **refused (new, Task 7)** unless it names the session's own conversation, for every session | the id becomes a filename in the target conversation's next pod | yes: that private conversation's resume | Task 7 |

**B. Held for the owner: nothing lands without their yes**

| # | Write path | Where decided | Decision | Why | Feeds a private turn? | Pinned by |
|---|---|---|---|---|---|---|
| 11 | Connector (MCP) tool calls | `tool-policy/src/verdicts.ts:207-216` (the connector's default, else `hold`); `decisions/src/attendance.ts:144` (outsider → unattended); `decisions/src/pre-call.ts:184` (an outsider spends only an unattended yes) | held, unless the owner or an admin chose `allow`; then it runs with the connector's access, by design (§1, §2) | the owner chose that reach, and the copy says so | not as the agent's own state: what a connected app returns is tool output, untrusted at every hop | `decisions/src/__tests__/attendance.test.ts:195-223`; `pre-call.test.ts:230-262` |
| 12 | Held calls → `decisions_v1_decisions` rows in the connector's Today | `decisions/src/pre-call.ts:273-366` | held | a person reads them; a replay runs only after their yes | no: Today UI | as row 11; TASK-1094 residual (10) |
| 13 | `web_extract` → `egress-allowlist:remember` (the connector's allowlist) | `tool-policy/src/rules.ts:245-255`; `web-tools/src/tools/web-extract.ts:70-95,131` | held on a new host | written only after a permitted fetch | no text: it changes only whether the connector is asked again | `web-tools/src/__tests__/tools-web-extract.test.ts` |
| 14 | `request_capability` hit → a permission card; Allow attaches an admin-curated skill | `tool-policy/src/rules.ts:141-152` (`hold`); `channel-slack/src/turn.ts:481-497` (no prompt for an outsider) | held | only the owner's Allow attaches anything | only after their Allow | `channel-slack/src/__tests__/turn.test.ts:881,1047` |
| 15 | Host grants (`host-grants:grant`, `proxy:add-host`) | owner routes only (`channel-web/src/server/routes-allow-host.ts:139-150`) | held | a person's click | only after it | `turn.test.ts:881` |

**C. Persists, but nothing reads it back into a private turn**

| # | Write path | Where decided | Decision | Why | Feeds a private turn? | Pinned by |
|---|---|---|---|---|---|---|
| 16 | **Cold-start catalog request** (`search_catalog`/`request_capability` miss → `catalog:submit`) | today nothing checks: `skill-broker/src/tools/coldstart.ts:70-86` | **refused (new, Task 6)**: skipped; the miss still reaches the model | consistent with `connector_propose` | no: admins triage; non-promotable | Task 6 |
| 17 | The `:external` thread's transcript and display log | channel-slack keys it `slack:<install>:<channel>:<thread>:external`, owned by the connector; transcript actions take the conversation from the session row (`ipc-core/src/handlers/session-transcript.ts:49-59`) | allowed | it is the outsiders' own thread; members' turns live in their own conversations | no: only later turns of the same outsider conversation. No tool reads another conversation; memory refuses it (row 1) | `channel-slack/src/__tests__/router.test.ts:1762,2291` |
| 18 | Conversation title | `conversation-titles/src/plugin.ts:199,404` | allowed | UI only | no | no reader to pin |
| 19 | Step summaries, agent activity, audit log | `step-summaries/src/plugin.ts:112,202`; agent-activity (in memory); `audit-log/src/plugin.ts:55-77` | allowed | UI or admin only | no | no reader to pin |
| 20 | Usage counters | `usage-limits/src/service.ts:258-330` | allowed | metering; spends the connector's budget (TASK-1094 residual 5) | no text, admission only | — |
| 21 | Connector status (`event.connector-auth-failure`) | `mcp-client/src/connector-inventory/auth-failure-recheck.ts:85-167` | allowed | the host verifies before it marks anything | only a verified needs-reconnect state | — |
| 22 | `blob.put` | `ipc-core/src/handlers/blob.ts:120` | allowed | unreferenced once row 8 refuses the publish; blob-gc collects it; disk quota bounds it | no | hidden tools (Task 5) mean an honest runner never calls it here |
| 23 | Scratch `/tmp`, HOME tmpfs `/home/runner` | per pod (`sandbox-k8s/src/pod-spec.ts`) | allowed | gone with the pod; a warm session serves only turns of its own mode | no | `orchestrator.test.ts:9127` |

**Out of scope (reads, not writes):** an outsider's turn can read the agent's files, instructions, artifact list and routine definitions. The design accepts files and instructions as visible. Routine briefs are a privacy question, filed as a follow-up.

**Acceptance 2:** after Tasks 1-7, no allowed row feeds a private turn. So the settings copy stays as it is, already pinned by `channel-web/src/components/workspace/__tests__/AgentSlack.test.tsx:136,142,156`.

## Global Constraints

- Every new gate asks `isOutsiderTurn(ctx)` from `@ax/core`. Never `=== 'external'`, which fails open on an unknown source. Never `!isAttendedTurn`, which would also refuse routines. Routines (`source: 'routine'`) and decisions replays, which run as `'routine'`, keep every capability.
- Key on `source`, never on `audience`. A member's channel turn (`source: 'user'`, `audience: 'shared'`) keeps a writable home, publishing and routine tools.
- Host refusals are the gates. Hiding a tool (`disallowedTools`) is catalog hygiene and is applied runner-side only.
- Refusal text is fixed. It never echoes caller input, names no plugin and gives no reason beyond the one sentence.
- Do not touch `packages/memory/**` or `packages/channel-slack/src/capture-veto.ts` (TASK-1136 is in flight).
- No new hooks, no hook-signature change, no new IPC action or wire field. The settings copy does not change.
- Run tests as `pnpm --filter @ax/<pkg> test` (filter BEFORE the script). Full gate: `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. Docker-backed files (e.g. `packages/routines/src/__tests__/tools.test.ts`, Postgres) need an explicit `DOCKER_HOST`. All new tests here are Docker-free.
- The Bash tool runs zsh: quote globs (`--include='*.ts'`) and keep file lists in arrays.

## Review Focus

1. **Production's shared pool.** An outsider's session must never land on a warm standby, where the helper binds `/files` read-write and ignores the pod's `readOnly`. Pinned in Task 3 (`shared-pool.test.ts`).
2. **A member's channel turn stays fully capable.** `source: 'user'` with `audience: 'shared'` keeps a writable home, `artifact.publish` and routine writes, and is hidden nothing. Pinned in Tasks 1, 2, 3 and 5.
3. **An outsider's malformed call** gets the outsider refusal, not a validation or field error that invites a retry, and writes no decisions row. Pinned in Tasks 1 and 2.
4. **An agent whose very first session is an outsider's.** Its `/files` subPath doesn't exist yet. The kubelet creates it through the NFS volume source, so only the volumeMount may be `readOnly`; the volume's `nfs:` source must not carry `readOnly`. Pinned in Task 3.
5. **Sources other than `'external'`.** An unknown source fails closed (refused). `'routine'` and `'user'` pass every new gate. Pinned in Tasks 1, 2 and 6. In Task 3, `owner.source` is a zod enum, so only `'external'` can arrive there. Task 7 applies to every session, whatever its source.

---

### Task 1: Routines: an outsider's turn can't create, change, delete or fire a routine [tier: sensitive]

**Security-checklist:** required (a host gate on untrusted input).

**Files:**
- Modify: `packages/routines/src/tools.ts:1-4` (import `isOutsiderTurn`), `:103-107` (`prepare`), `:296-303` (`recordRefusal`)
- Create: `packages/routines/src/__tests__/outsider-writes.test.ts` (Docker-free: `HookBus` plus stub store and stub services, the `task-update-read.test.ts` pattern)

**Interfaces:**
- Consumes: `isOutsiderTurn` (`@ax/core`), `C.routineToolKind` (`@ax/routines-contract`).
- Produces: the outsider refusal is `new SafeToolError('forbidden', 'input')`, so the model reads `safeToolMessage('forbidden', 'input')` ("This operation is not allowed for this person and agent. Field: input"). There is no new tool code.

- [ ] **Step 1: Write the failing tests** in `outsider-writes.test.ts`. Setup: `bus = new HookBus()`; register a `tool:register` stub; register spies for `agents:resolve` (answers `{ agent: { ownerType: 'team', ownerId: 't1' } }`), `agents:can-manage-routines` (`{ allowed: true }`), `decisions:reject-unstarted-routine-call`, `decisions:authorize-routine-call` and `routines:list`; build a store stub whose methods are all `vi.fn()` (`findOperationReceipt` and `findOne` resolve `null`); then `await registerRoutineTools({ bus, store, now: () => new Date(0) })`. `outsider = makeAgentContext({ agentId: 'a', userId: 'connector', conversationId: 'c', sessionId: 's', source: 'external' })`. Valid inputs, each asserted with `C.RoutineToolInputSchemas[name].safeParse(input).success === true`:
  - create: `{ requestId: 'r1', definition: { name: 'Daily', promptBody: 'Check outstanding work.', trigger: { kind: 'interval', every: '1h' } } }`
  - update: `{ requestId: 'r2', routineId: 'rt_1', expectedRevision: 'rev_1', patch: { enabled: false } }`
  - delete and fire_now: `{ requestId: 'r3', routineId: 'rt_1', expectedRevision: 'rev_1' }`

  Tests:
  - `it.each` over the four write tools: "an outsider's %s is refused at pre-call before any ACL, store or decisions call". `await bus.fire('tool:pre-call', outsider, call)` equals `{ rejected: true, reason: safeToolMessage('forbidden', 'input'), … }` (`toMatchObject`). Every spy and every store method has zero calls.
  - The same four at execute: `bus.call('tool:execute:<name>', outsider, call)` rejects `toMatchObject({ toolCode: 'forbidden' })`. Zero spy calls, `decisions:reject-unstarted-routine-call` included.
  - "an outsider's malformed create is refused, not validated": `input: {}` → the same `forbidden` refusal, never `validation`.
  - "a source this build doesn't know is refused too": `source: 'visitor' as never` → `forbidden`.
  - "an outsider can still list routines": pre-call of `routine_list` (`input: {}`) is not rejected, and `agents:resolve` is called once.
  - "a member's channel turn and a routine run pass this gate": with `source: 'user', audience: 'shared'` and then `source: 'routine'`, pre-call of the create reaches `agents:resolve` (called once each). Assert only that the gate let it through.
- [ ] **Step 2: Run** `pnpm --filter @ax/routines exec vitest run src/__tests__/outsider-writes.test.ts`. Expected: FAIL (no refusal; spies called).
- [ ] **Step 3: Implement.** In `prepare()`, directly after `const name = call.name as C.RoutineToolName;` and before `parseRoutineInput`, add `if (C.routineToolKind(name) === 'write' && isOutsiderTurn(ctx)) throw new SafeToolError('forbidden', 'input');`. Add a comment: TASK-1122, an outsider's turn never changes the agent's routines; routine consent is the connector's and would otherwise let an outsider's text run later as theirs; checked before validation, so a malformed call gets this answer rather than a field error. In `recordRefusal`, return early also when `isOutsiderTurn(ctx)`, so an outsider's call never touches the connector's own decision rows.
- [ ] **Step 4: Run** the new file and `pnpm --filter @ax/routines test`. Expected: PASS. Without `DOCKER_HOST` the Docker-backed files fail at container start; say so in the handoff rather than skipping them silently.
- [ ] **Step 5: Mutation check** (commit first; restore with `git checkout HEAD -- <path>`). Delete the new `prepare` line: the pre-call and execute tests fail. Swap `isOutsiderTurn` for `ctx.source === 'external'`: the unknown-source test fails.
- [ ] **Step 6: Commit** `feat(routines): an outsider's turn can't create, change, delete or fire a routine (TASK-1122)`

### Task 2: `artifact.publish` refuses an outsider's turn [tier: sensitive]

**Security-checklist:** required (an IPC handler).

**Files:**
- Modify: `packages/ipc-core/src/handlers/artifact-publish.ts:13` (import `isOutsiderTurn`), `:67` (first statement of `artifactPublishHandler`), header comment `:18-53` (one line on the rule)
- Test: `packages/ipc-core/src/handlers/__tests__/artifact-publish.test.ts`

**Interfaces:**
- Produces: `hookRejected(OUTSIDER_PUBLISH_REFUSAL)` (status 409, `HOOK_REJECTED`) where
  `export const OUTSIDER_PUBLISH_REFUSAL = "artifact.publish: files and charts can't be published from a conversation with people who don't have access to this agent. Nothing was published.";`

- [ ] **Step 1: Write the failing tests** (the file's existing ctx and bus helpers, with `source: 'external'` and a `conversationId` matching the payload):
  - "refuses an outsider's publish before reading the payload or calling any hook": a valid publish → `{ status: 409, body: { error: { code: 'HOOK_REJECTED', message: OUTSIDER_PUBLISH_REFUSAL } } }`; `bus.call` not called.
  - The same for a chat visual (`visual: true` at `visualPathFor(sha)`) and for a payload carrying `artifactId`.
  - "an outsider's malformed payload gets the same refusal, not a validation error".
  - "a source this build doesn't know is refused".
  - "a routine session and a member's channel session still publish": `source: 'routine'`, and `source: 'user'` with `audience: 'shared'`, reach the hook.
- [ ] **Step 2: Run** `pnpm --filter @ax/ipc-core exec vitest run src/handlers/__tests__/artifact-publish.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `if (isOutsiderTurn(ctx)) return hookRejected(OUTSIDER_PUBLISH_REFUSAL);` as the handler's first statement, before `safeParse`. The comment says why: the artifact list enters every later session's prompt, agent-wide; a publish can add a version to a privately made artifact; a visual is refused too, because the wire lets it carry an `artifactId`.
- [ ] **Step 4: Run** `pnpm --filter @ax/ipc-core test`. Expected: PASS.
- [ ] **Step 5: Mutation check.** Remove the line: the four refusal tests fail.
- [ ] **Step 6: Commit** `feat(ipc-core): an outsider's turn can't publish artifacts or charts (TASK-1122)`

### Task 3: sandbox-k8s: an outsider's session gets `/files` read-only, never from the warm pool [tier: sensitive]

**Security-checklist:** required (a sandbox boundary).

**Files:**
- Modify: `packages/sandbox-k8s/src/open-session.ts` (import `isOutsiderTurn`; the resolver call `:246-255`; `pooled` `:473-475`)
- Modify: `packages/sandbox-k8s/src/shared-pool.ts:166-172` (`createNamespacedPod`'s direct-path condition)
- Modify: `packages/sandbox-k8s/src/pod-spec.ts:395-415` (`RealizedMounts`), `:520-532` (`realizeMounts`), `:860-866` (env stamping)
- Modify comments only: `packages/sandbox-mount-protocol/src/mount-spec.ts:139-145`, `packages/workspace-filestore/src/plugin.ts:63-67`, `packages/workspace-localdir/src/plugin.ts:61-65` (each now says the k8s provider also asks for `readOnly` when an outsider's turn opens the session)
- Test: `packages/sandbox-k8s/src/__tests__/open-session.test.ts` (the `openWithOwner` block `:500-540`, the realization block `:898+`), `shared-pool.test.ts`, `pod-spec.test.ts`

**Interfaces:**
- Produces (for Task 4): runner env `AX_USERFILES_READONLY` = `'1'` exactly when the realized `role: 'user-files'` mount is `readOnly: true`; absent otherwise. `RealizedMounts.userFilesReadOnly?: boolean`.
- The resolver input becomes `{ owner, readOnly: true }` for an outsider's owner and stays `{ owner }` for everyone else (byte-for-byte unchanged).

- [ ] **Step 1: Write the failing tests.**
  - open-session: "an outsider's session asks the resolver for a read-only home". Use `openWithOwner({ source: 'external', audience: 'shared' })`, extended to also return the full resolver input; the input's `readOnly` is `true`.
  - open-session: "a member's channel session, a routine and an unsourced session keep a writable home". For `{ source: 'user', audience: 'shared' }`, `{ source: 'routine' }` and `{}`, the resolver input has no `readOnly` key.
  - open-session realization, with a resolver that honours `input.readOnly`, as `@ax/workspace-filestore` does. For an external owner: the runner's `/files` volumeMount is `readOnly: true`; the matching `nfs` volume source has no `readOnly`; there is no `ax-mount-0-chown` init container; the env holds `{ name: 'AX_USERFILES_READONLY', value: '1' }`. For a user owner: `readOnly: false`, the chown init is present, and there is no `AX_USERFILES_READONLY`.
  - shared-pool: "never pools a pod whose /files mount is read-only". Give `sessionPod` a third parameter for `/files` `readOnly`. `api.createNamespacedPod` calls `f.direct.createNamespacedPod` once with that body; `f.custom.createNamespacedCustomObject` and `f.storage.assign` are never called.
  - pod-spec: "stamps AX_USERFILES_READONLY=1 for a read-only user-files mount, and nothing for a writable one" (the existing `runnerEnv(spec)` helper, beside the `AX_USERFILES_ROOT` tests at `:1252-1282`).
- [ ] **Step 2: Run** `pnpm --filter @ax/sandbox-k8s exec vitest run src/__tests__/open-session.test.ts src/__tests__/shared-pool.test.ts src/__tests__/pod-spec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - open-session: `const readOnlyHome = input.owner !== undefined && isOutsiderTurn(input.owner);` Pass `{ owner: input.owner, ...(readOnlyHome ? { readOnly: true } : {}) }`. Add `&& !readOnlyHome` to `pooled`. Comment: TASK-1122, an outsider's turn can read the agent's files but not change them (HOME, cwd and `/files/bin` of every later session), and a standby's helper would bind it writable.
  - shared-pool: add `|| runner.volumeMounts.some((m) => m.mountPath === '/files' && m.readOnly === true)` to the condition that returns `direct.createNamespacedPod(req)`. Comment: the storage helper binds `user-files` read-write and ignores the pod's `readOnly`.
  - pod-spec: `realizeMounts` sets `out.userFilesReadOnly = mount.readOnly === true` next to `out.userFilesRoot`. The env block pushes `{ name: 'AX_USERFILES_READONLY', value: '1' }` after `AX_USERFILES_ROOT` when it is true. Leave the `nfs:` volume source without `readOnly`.
  - Update the three stale comments listed under Files.
- [ ] **Step 4: Run** `pnpm --filter @ax/sandbox-k8s test`, `pnpm --filter @ax/workspace-filestore test`, `pnpm --filter @ax/workspace-localdir test`. Expected: PASS.
- [ ] **Step 5: Mutation check.** Drop the wrapper condition: the shared-pool test fails. Drop `readOnly: true` from the resolver input: the open-session tests fail. Key `readOnlyHome` on `audienceOf(owner) === 'shared'` instead: the member-channel test fails.
- [ ] **Step 6: Commit** `feat(sandbox-k8s): an outsider's session mounts the agent's files read-only, never from the warm pool (TASK-1122)`

### Task 4: The runner tells the agent its files are read-only [tier: integration]

**Files:**
- Modify: `packages/agent-runner-core/src/env.ts` (`RunnerEnv` `:37-46`, parser `:174-198`)
- Modify: `packages/agent-runner-core/src/system-prompt.ts` (new `readOnlyFilesNote`, near `filesNote` `:168-176`; `operationalNotes` `:348-374`)
- Modify: `packages/agent-runner-core/src/prompt-engine.ts:286-321` (`buildSystemPrompt`), `packages/agent-runner-core/src/run-runner.ts:1371-1393` (its call)
- Test: `packages/agent-runner-core/src/__tests__/env.test.ts`, `system-prompt.test.ts`, `prompt-engine.test.ts`

**Interfaces:**
- Consumes: `AX_USERFILES_READONLY` from Task 3.
- Produces: `RunnerEnv.userFilesReadOnly?: true` (set only for `'1'`; any other value throws `InvalidEnvError('AX_USERFILES_READONLY', …)`). `export function readOnlyFilesNote(home: string, scratch: string): string`. `operationalNotes(home, scratch, pythonVenvActive = false, memoryRoot = undefined, filesReadOnly = false)`. `buildSystemPrompt(…, identityToolAvailable = false, filesReadOnly = false)`.
- Exact note text (fixed runner prose; never the word "workspace", per the vocabulary rule at `system-prompt.ts:160-166`):

```ts
`Your files: \`${home}\` is your working directory and holds your files. In this conversation you can read them but not change them: writing, editing or deleting anything under \`${home}\` fails. Anything you make here goes in scratch space, \`${scratch}\`, and is gone when this session ends, so never say you saved something.`
```

- [ ] **Step 1: Write the failing tests.**
  - env: `AX_USERFILES_READONLY=1` → `userFilesReadOnly: true`; unset → the key is absent; `'true'` and `'0'` → throw `InvalidEnvError` naming `AX_USERFILES_READONLY`.
  - system-prompt: `operationalNotes(home, scratch, false, undefined, true)` contains `readOnlyFilesNote(home, scratch)` and `ephemeralScratchNote(scratch)`. It contains none of `filesNote(home, scratch)`, `userFilesNote(home)`, `fileOutputNote(home)` or `skillAuthoringNote(home)`. With the flag false, the output equals today's.
  - prompt-engine: normal-mode `buildSystemPrompt` with `filesReadOnly = true` includes the read-only note and not `userFilesNote(home)`.
- [ ] **Step 2: Run** `pnpm --filter @ax/agent-runner-core exec vitest run src/__tests__/env.test.ts src/__tests__/system-prompt.test.ts src/__tests__/prompt-engine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** With `filesReadOnly`, `operationalNotes` replaces the first three notes with `readOnlyFilesNote` and drops `skillAuthoringNote`, because drafts need a writable home. `run-runner.ts` passes `env.userFilesReadOnly === true`. Bootstrap mode is unchanged: an outsider's turn never bootstraps.
- [ ] **Step 4: Run** `pnpm --filter @ax/agent-runner-core test`, `pnpm --filter @ax/agent-claude-sdk-runner test`, `pnpm --filter @ax/agent-aisdk-runner test`. Expected: PASS. TASK-994's real-SDK e2e (`agent-files-guards-real-sdk.e2e.test.ts`) already pins that a fresh session writes nothing into the home, which is what makes a read-only home safe to boot.
- [ ] **Step 5: Commit** `feat(agent-runner-core): tell the agent its files are read-only when they are (TASK-1122)`

### Task 5: Hide the newly refused tools from an outsider's catalog [tier: integration]

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:1489-1497` (new constant after `PROPOSAL_TOOLS`), `:1667-1698` (`proposalToolScope` → `outsiderToolScope`), `:3558-3572` (call site and comment)
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` (import `:22`; session-open tests `:1917-1975`; unit tests `:7520-7570`)

**Interfaces:**
- Produces:

```ts
const OUTSIDER_REFUSED_TOOLS: readonly string[] = [
  ...PROPOSAL_TOOLS,
  'routine_create', 'routine_update', 'routine_delete', 'routine_fire_now',
  'artifact_publish', 'show_visual',
];
export function outsiderToolScope(
  agent: { allowedTools: readonly string[]; mcpConfigIds: readonly string[] },
  allowedTools: readonly string[],
  disallowedTools: readonly string[] | undefined,
  opts: { external: boolean },
): string[] | undefined
```

  The contract is `proposalToolScope`'s, over the longer list: never shrink `allowedTools`; existing entries first, no duplicates; unchanged (possibly `undefined`) when nothing is hidden. `withBrokerDefaults` and `PROPOSAL_TOOLS` are unchanged. The routine names are a local mirror (I2), like `ROUTINE_RUN_TOOLS`.

- [ ] **Step 1: Write and update the failing tests.**
  - Unit: wildcard plus external → the eight names, in `OUTSIDER_REFUSED_TOOLS` order. External plus an agent listing `['Bash', 'routine_create', 'artifact_publish']` → exactly `['routine_create', 'artifact_publish']`. External plus an agent listing none → `undefined`. Not external → input unchanged.
  - Session-open: update "an external turn of a wildcard agent has both proposal tools in disallowedTools" to expect all eight. Add "a member's channel turn (`source 'user'`, `audience 'shared'`) of a wildcard agent hides none of them" and "a routine run keeps the routine and publish tools". Rename every `proposalToolScope` reference.
- [ ] **Step 2: Run** `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/orchestrator.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the constant, the rename and the call site.
- [ ] **Step 4: Run** `pnpm --filter @ax/chat-orchestrator test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat-orchestrator): an outsider's turn isn't offered the tools it can't use (TASK-1122)`

### Task 6: No cold-start catalog requests from an outsider's turn [tier: sensitive]

**Security-checklist:** required (untrusted text reaching the admins' queue).

**Files:**
- Modify: `packages/skill-broker/src/tools/coldstart.ts:1` (value import of `isOutsiderTurn` from `@ax/core`), `:3-17` (header: one line on the rule), `:70-76` (first statement of `fireColdStartSubmit`)
- Test: `packages/skill-broker/src/__tests__/coldstart.test.ts` (`describe('fireColdStartSubmit')`, `:53+`)

- [ ] **Step 1: Write the failing tests:** "an outsider's turn files nothing and returns normally" (`catalog:submit` spy never called; resolves `undefined`); "a source this build doesn't know files nothing"; "a routine's turn still files" (spy called once with `requestedByUserId: ctx.userId`).
- [ ] **Step 2: Run** `pnpm --filter @ax/skill-broker exec vitest run src/__tests__/coldstart.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `if (isOutsiderTurn(ctx)) return;` as the first statement. Comment: TASK-1122, the same harm as `connector_propose` (TASK-1091): the admins' queue, outsider-worded, in the connector's name. The miss still reaches the model.
- [ ] **Step 4: Run** `pnpm --filter @ax/skill-broker test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(skill-broker): an outsider's turn files no catalog requests (TASK-1122)`

### Task 7: `conversation.store-runner-session` binds only the session's own conversation [tier: sensitive]

**Security-checklist:** required (an IPC handler; the runner is untrusted).

**Files:**
- Modify: `packages/ipc-core/src/handlers/conversation-store-runner-session.ts:1-13` (import `refuseUnboundConversation` from `./bound-conversation.js`), `:15-50` (authz comment: a new step), `:53-63` (after the parse, before `bus.call`)
- Test: `packages/ipc-core/src/handlers/__tests__/conversation-store-runner-session.test.ts`

**Interfaces:** `refuseUnboundConversation(ctx, parsed.data.conversationId, 'conversation.store-runner-session', 'store_runner_session_foreign_conversation_refused')`. A non-null return is returned as-is (403, `'a runner may act only on its own conversation'`).

- [ ] **Step 1: Write the failing tests:** "refuses a conversation other than the session's bound one, without calling the hook" (ctx bound to `cnv_mine`, payload `cnv_other` → 403; `bus.call` not called); "refuses a session bound to no conversation" (403, no call). Give the existing tests' ctx `conversationId: 'cnv_abc'`. The existing 404 test for `cnv_foreign` now binds its ctx to `cnv_foreign`, so it still exercises the hook's own not-found.
- [ ] **Step 2: Run** `pnpm --filter @ax/ipc-core exec vitest run src/handlers/__tests__/conversation-store-runner-session.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the guard. Comment: the store scopes by user only, so without this a runner could bind an id onto another of its user's conversations (a channel connector's private chats included), and that conversation's next pod joins the id into a filename.
- [ ] **Step 4: Run** `pnpm --filter @ax/ipc-core test`, `pnpm --filter @ax/ipc-server test`, `pnpm --filter @ax/ipc-http test`. Expected: PASS. If an integration fixture calls the action from a session with no conversation, bind its conversation in the fixture; never loosen the guard.
- [ ] **Step 5: Commit** `fix(ipc-core): a runner binds its session id only to its own conversation (TASK-1122)`

### Task 8: Correct the lines that made the card look settled, and add the changeset [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md:74-75` (§2), `:165-167` (§2a), `:391-392` (§5), `:510-512` (§6)
- Modify: `packages/core/src/context.ts:277-281` (the `'external'` doc), `:292-293` (the `audience` doc)
- Create: `.changeset/slack-outsider-writes.md`

- [ ] **Step 1: Edit the design.**
  - §2: replace "No identity edits, skill authoring or connector requests are allowed, and both proposal tools are hidden from external turns." with "An external turn can change nothing the agent later reads as its own: no identity edits, skill authoring, connector requests, routine or task changes, published artifacts or charts, or catalog requests, and the agent's files are read-only in it (TASK-1122). The tools it can't use are hidden from it. The write-path audit is in `docs/plans/2026-11-17-task-1122-outsider-persist-audit-plan.md`."
  - §2a: after "…visible to anyone in the channel.", add "An outsider's turn can read them but not change them: its session mounts the agent's files read-only (TASK-1122)."
  - §5: the artifacts bullet adds "(a member's turn only: an outsider's turn can't publish)".
  - §6: after the TASK-1091 audit-table sentence, add "What an external turn can write outside memory is audited in `docs/plans/2026-11-17-task-1122-outsider-persist-audit-plan.md`."
- [ ] **Step 2: Edit `context.ts`.** "may make no identity or skill edits" becomes "may change nothing the agent later reads as its own: identity, skill, connector-request, routine and artifact writes are refused, and its files are read-only (TASK-1122)". Append to the audience doc: "(an outsider's `source` is what makes files read-only)".
- [ ] **Step 3: Write the changeset.** Patch bumps for `@ax/routines`, `@ax/ipc-core`, `@ax/sandbox-k8s`, `@ax/agent-runner-core`, `@ax/chat-orchestrator` and `@ax/skill-broker`. One paragraph in the CLAUDE.md voice: what an outsider's Slack turn can no longer change, that its files are read-only and its first turn in a thread starts a fresh sandbox, and that members' turns are unchanged.
- [ ] **Step 4: Run** `pnpm build && pnpm lint`, then the full gate from Global Constraints. Expected: PASS.
- [ ] **Step 5: Commit** `docs: what an outsider's turn can't change (TASK-1122)`

## PR description requirements (not a task)

- **Security review:** run the `security-checklist` walk over Tasks 1, 2, 3, 6 and 7, plus the PR as a whole. It covers the sandbox boundary (a read-only NFS volumeMount under gVisor; the runner is non-root with capabilities dropped, so it can't remount), the IPC handlers, and untrusted text reaching the admins' queue.
- **Boundary review:** no new or changed hook signatures, IPC actions or wire fields. `sandbox:resolve-mounts` gains a new caller of its existing `readOnly` input. `artifact.publish` and `conversation.store-runner-session` gain refusals. Name the env `AX_USERFILES_READONLY` (sandbox → runner, beside `AX_USERFILES_ROOT`).
- **The audit:** the table above, or a link to it, with the verdict counts.
- **Residuals:**
  - A routine write an outsider's turn left waiting in Today before this ships still runs if the connector approves it, because replays run as `'routine'`.
  - Outsider sessions still spend the connector's usage budget.
  - An outsider session can still `blob.put`; blob-gc collects unreferenced blobs.
  - An outsider's first turn in a thread cold-starts a Sandbox.
  - A connector write the connector's policy allows still runs with their access, by design.

## Follow-ups (return in the handoff; auto-ship files the cards)

1. Shared-pool storage helper: a read-only `user-files` bind, so an outsider's session can use a warm standby.
2. Measure on kind whether model-run code can read the runner's `AX_AUTH_TOKEN` through `/proc/<pid>/environ`. INFERRED risk: if it can, every IPC action is model-reachable, and `tool.execute-host` doesn't re-run `tool:pre-call`, so host-tool holds could be skipped.
3. Validate `runnerSessionId` at use (`agent-claude-sdk-runner/src/jsonl-transcript-source.ts:154`) as defense in depth.
4. `artifact.publish` accepts an `artifactId` with `visual: true` in every session, so a visual can add a version to a normal artifact.
5. A privacy call for Vinay: outsiders can read the agent's routine briefs (`routine_list`/`routine_get`) and see the artifact list in their prompt.
6. kind only: the `/var/run/ax` hostPath is read-write, and `deploy/charts/ax-next/templates/host/deployment.yaml:64-65` says it is read-only.
