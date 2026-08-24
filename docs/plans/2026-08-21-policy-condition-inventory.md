# Policy-condition inventory (AW-1)

**Date:** 2026-08-21
**Task:** AW-1 / TASK-222 — `docs/plans/2026-08-21-agent-workspace-plan.md` › Task AW-1
**Design under test:** `docs/plans/2026-08-21-agent-workspace-design.md` §4.3
**Deliverable:** this document. No code ships with it.

---

## Why this document exists

Design §4.3 builds the permissions rail — the "What it may do alone" block — on top of
a `PolicyRule` table whose rows each carry an authored `capability` sentence. The design
assumes such a set of enforced policy conditions already exists and mostly needs
sentences written for it. §9 says so directly:

> authoring `capability` clauses for the existing policy is useful on its own and
> surfaces how many rules currently have no describable meaning.

**There is no existing policy to author clauses for.** `tool:pre-call` — the one hook in
the repo designed to adjudicate a tool call — has **zero production subscribers**. The
chain always returns `allow` with the call unmodified. Enforcement today is scattered
across twenty other places, most of which sit below or beside the tool-call path and key
on things (hostnames, file paths, raw bytes) that no `PolicyRule` can express.

So the real question AW-1 answers is not "what sentences do we write for our rules?" but
**"which of today's scattered enforcement points deserve to become rules at all?"** —
and the answer is: fewer than the prototype implies.

This document is the input to AW-3 (`@ax/tool-policy`). Every seed rule in the last
section is meant to be pasted into `packages/tool-policy/src/rules.ts`.

---

## Method

Every file in the plan's Step-1 list was opened and read; nothing here is inferred from
naming. Line numbers are as of commit `d8be0a7c` on `main`.

**What counts as an enforcement point:** any construct that can stop, alter, or refuse a
tool call — or the workspace write / network reach a tool call produces. That is broader
than "vetoes a tool call", deliberately: a rail that only described the tool-call gate
would understate reach, and understating reach is the direction H4 forbids.

**Three corrections to the plan's Step-1 list:**

- `authored-caps.ts` lives at **`packages/agents/src/authored-caps.ts`**, not
  `packages/skills/src/`. (The design cites it correctly; the plan's file list does not.)
- The list's `validator-{skill,routine,identity,service}/` is wrong about **`validator-service`**:
  it is **not** a workspace-write veto. `packages/validator-service/src/plugin.ts:111`
  declares `subscribes: []`; it registers a *service* hook, `services:validate` (`:114`),
  whose only production caller is `packages/chat-orchestrator/src/orchestrator.ts:2157`
  **at session open**, over the folded connector/skill service list. It never sees a
  `FileChange`. There are exactly **three** production `workspace:pre-apply` subscribers —
  `validator-skill:126`, `validator-identity:138`, `validator-routine:28`.
- The list omits the **JIT approval-card path** (`chat:permission-request`) and the
  **propose-tool chokepoints** (`skill_propose`, `connector_propose`), which are the
  closest things the repo has to a `hold` today. They are inventoried below as E15–E20.

---

## The inventory

Twenty enforcement points. `†` in the "Describable" column means *describable, but not as
a `PolicyRule` `capability` clause* — it renders as a §4.3.4 grant row or a §4.3.3
mechanical row instead. See the notes under the table.

| Enforcement point | File:line | What it actually gates | Input it keys on | Describable to a user? | Candidate `capability` clause | Verdict it would carry |
|---|---|---|---|---|---|---|
| **E1** Governed-path re-rooting | `packages/agent-runner-core/src/governed-paths.ts:211` (`resolveGovernedPaths`), mutation loop `:239` | Nothing is stopped. Rewrites path arguments so a write to `.ax/**` / `.claude/**` lands on the git-backed tier instead of ungoverned NFS | Tool input keys `file_path` / `path` / `notebook_path` only (`:30`); `POLICY_PREFIXES` + `POLICY_EXACT_PATHS` from `packages/core/src/workspace-policy.ts:57` | **no** — pure implementation detail; no reason string, no user signal | — | *(alter only — no verdict)* |
| **E2** Pre-call fail-closed deny | `packages/agent-runner-core/src/tool-policy.ts:70` | Denies the call when the `tool.pre-call` IPC round-trip throws or fails schema validation | A caught `Error`; its raw `.message` becomes the model-visible reason | **no** — an infrastructure failure wearing a policy costume | — | `deny` |
| **E3** Host-verdict interpretation | `packages/agent-runner-core/src/tool-policy.ts:77-94` | The seam that applies whatever the host decided. Sole **production** reader of `parsed.verdict` (`test-harness/src/stub-runner.ts:104` also reads it) | `ToolPreCallResponse` (`packages/ipc-protocol/src/actions.ts:89-98`) — a union of `allow` / `reject` only | **no** — a seam, not a condition | — | `allow` \| `deny` |
| **E4** The `tool:pre-call` subscriber chain | fired at `packages/ipc-core/src/handlers/tool-pre-call.ts:35` | The one chokepoint designed to hold rules. **Zero production subscribers** — always answers `allow` with the unmodified call | `ToolCall {id, name, input}` | *n/a — empty today* | — | `allow` (unconditionally) |
| **E5** aisdk policy wrapper | `packages/agent-aisdk-runner/src/tools/policy-wrap.ts:74`, deny branch `:85` | Every aisdk tool `execute`. Boot-time guards `mergeToolSets` `:170` and `assertAllToolsWrapped` `:198` make bypass unrepresentable | The `PreToolVerdict` from E3 | **no** — a seam. Its `denialText` `:139` is the repo's most user-visible enforcement string, but it is addressed to the model | — | `allow` \| `deny` |
| **E6** claude-sdk pre-tool adapter | `packages/agent-claude-sdk-runner/src/pre-tool-use.ts:57-63`; `can-use-tool.ts:44` | Same seam on the other runner. Maps deny → `permissionDecision:'deny'`. The SDK's native `'ask'` exists and is never emitted | The `PreToolVerdict` from E3 | **no** — a seam | — | `allow` \| `deny` |
| **E7** `DISABLED_BUILTINS` | `packages/agent-claude-sdk-runner/src/tool-names.ts:59-64`; enforced `:76`, `main.ts:480`, `pre-tool-use.ts:35`, `can-use-tool.ts:44` | Four named SDK builtins refused before any IPC: `WebFetch`, `WebSearch`, `Task`, `AskUserQuestion` | The raw SDK tool-name string. Exact match | **yes** — four distinct, explainable conditions. Today all four share the string `'tool disabled by policy'` | four; see seed rules | `deny` |
| **E8** Egress allowlist / CONNECT gate | `packages/credential-proxy/src/listener.ts:248` (`findAllowingSession`), rejects `:521`, `:935` | Whether one outbound request or CONNECT tunnel leaves the host at all | **Hostname only.** No tool name, no user, no agent, no path | **yes**† — but only ever "reach `<host>`"; the layer has no idea a tool call is in flight. §4.3.4 grant row | — | `deny` |
| **E9** SSRF / private-IP gate | `packages/credential-proxy/src/private-ip.ts:86-106`; call sites `listener.ts:546`, `:973` | Connections to RFC1918 / loopback / link-local / cloud-metadata addresses, including via DNS rebinding | Resolved IP + the session's `allowedIPs` escape hatch | **no** — a security floor, not a capability. Belongs in a security note, not the rail | — | `deny` |
| **E10** Canary exfil tripwire | `packages/credential-proxy/src/request-framer.ts:8`; enforced `listener.ts:810-819`, `blockCanary` `:786` | Tears down an in-flight TLS tunnel whose decrypted bytes carry a session canary token | Decrypted request bytes | **no** — no tool or operation context is available at that layer | — | `deny` |
| **E11** Credential substitution | `packages/credential-proxy/src/registry.ts:139` (`replaceAllBuffer`, used at `listener.ts:848`; `:815` goes through `framer.process`) | Nothing. Rewrites `ax-cred:<hex>` placeholders into real secrets on the way out. The only *alter* in the network layer | Outbound bytes | **no** | — | *(alter only)* |
| **E12** Host grants (always-allow) | `packages/host-grants/src/store.ts:40`; becomes reach at `packages/chat-orchestrator/src/orchestrator.ts:2218-2229` | Pre-authorizes hostnames into the proxy allowlist **at session open**. Never consulted during a turn | `(owner_user_id, agent_id, host)` — four columns, no expiry, no scope, no reason (`migrations.ts:17-24`) | **yes**† — but only ever "reach `<host>`". §4.3.4 grant row, mechanically derived | — | `allow` |
| **E13** `connectors:resolve` scoping | `packages/connectors/src/plugin.ts:497` → `store.getByIdNotDeleted`, `store.ts:229-238`; reject `:498-505` | Turns a connector id into real sandbox reach. **Pending authored drafts live in a different table (`connectors_v1_authored`) that `connectors:resolve` never reads** — they *are* read, by `connectors:list-authored` (`plugin.ts:674`) to build the approval card in E19 — zero reach is structural, not a check | `(userId, connectorId)`. No agent, no session, no operation | **yes**† — at connector granularity only ("this connection isn't set up"). §4.3.4 grant row | — | `allow` \| `deny` (`not-found`) |
| **E14** Approved-caps store | `packages/skills/src/approved-caps-store.ts:126` (`list`), subject split `:68-76`; `mcp` kind hard-rejected at `packages/skills/src/plugin.ts:993-1007` | Records what a human approved at the capability wall, per `(owner, agent, {skillId\|connectorId}, kind, value)`. **`skills:approved-caps-list` is read by the workspace rail** (`channel-web/src/server/routes-workspace.ts:2523`, the "Granted by you" group — TASK-235/#439, fixed by TASK-264/#447), and written by the connector approval wall (`chat-orchestrator/src/orchestrator.ts:3146`). It reports; it still does not *gate* — nothing consults it during a turn *(corrected 2026-08-23 — this row read "no production caller" when written on 2026-08-21, before TASK-235 landed)* | `kind ∈ {host, slot, npm, pypi, mcp}` + `value` | **yes**† — a second §4.3.4 grant source the design does not mention | — | `allow` (the `mcp` kind rejection is a real `deny`) |
| **E15** Authored-skill zero-reach projection | `packages/agents/src/authored-caps.ts:35`; enforced upstream at `packages/skills-parser/src/manifest.ts:179-192` | Nothing directly. A skill manifest carrying `capabilities:` (or any of `allowedHosts`/`credentials`/`mcpServers`/`packages`) is a hard **parse failure** — so an authored skill is always zero-reach instruction text | `manifestYaml` | **no** — structural. Correctly produces *no rail row at all* | — | *(no verdict)* |
| **E16** MCP agent-scope filter | `packages/mcp-client/src/scope.ts:50-83` (`filterByAgentScope`); assembly at `tool-dispatcher-plugin.ts:125-163` | Which MCP-sourced tool descriptors appear in the catalog handed to the model, per session | `mcp.<configId>.` name prefix vs the session's frozen `agentConfig.mcpConfigIds`. Wildcard escape hatch at `scope.ts:56` | **only as a tool name** — the vendor's `description` flows in verbatim (`connection.ts:270` → `tool-names.ts:196`, "no editorializing") and is untrusted (H5) | — | §4.3.3 mechanical row |
| **E17** Skill safety scan → quarantine | scan `packages/validator-skill/src/plugin.ts:184`; gate `packages/skills/src/propose-gate.ts:29-34`; persist `packages/skills/src/plugin.ts:1129` | A proposed skill whose text trips the injection/exfil scan is persisted but **never projected** to the model | Full bundle text (`manifestYaml + bodyMd + files`), not paths. Scanner outage degrades to *clean* (`plugin.ts:1112-1119`) | **yes** — "held back because its instructions look like they try to override your agent" | — | `deny` (post-hoc; the tool call itself succeeds) |
| **E18** Workspace-write vetoes (**3** validators) | skill `packages/validator-skill/src/plugin.ts:132`; identity `packages/validator-identity/src/plugin.ts:183,207,221`; routine `packages/validator-routine/src/plugin.ts:42,48,66` | **Two different things.** skill + identity gate writes to *protected paths* (`.claude/settings*.json`, `.claude/agents/**`, `CLAUDE.md`, `.ax/{BOOTSTRAP,IDENTITY,SOUL,AGENTS}.md`). routine does **not** protect a path — routine writes are allowed; it rejects malformed frontmatter (`:42`), a duplicate webhook `trigger.path` (`:48`), and a non-canonical `hmac.secretRef` (`:66`) | `workspace:pre-apply` change set: `FileChange.path` + `kind`, and for identity/routine the byte content | **yes** — e.g. "agents aren't allowed to edit their own settings files" | — | `deny` — **but not a tool-call verdict**; fires at turn-end commit. Rollback at `commit-notify-resync.ts:192-193` is `--mixed` unless `recoverable === false` — which `packages/ipc-core/src/handlers/workspace-commit-notify.ts:294` hard-codes for **every** pre-apply rejection, so a veto is always a `git reset --hard`. The reason reaches **stderr only** (`commit-notify-resync.ts:186`) |
| **E19** JIT approval cards | `request_capability` → `packages/skill-broker/src/tools/request-capability.ts:307`; egress wall → `packages/chat-orchestrator/src/orchestrator.ts:1222`; connector → `:1043` | **Nothing.** `chat:permission-request` is a fire-and-forget subscriber hook. The turn runs to completion; the card is UI | skill's resolved connectors / `(sessionId, host)` / pending draft row | **yes** — the card *frame* is authored in-repo (`PermissionCard.tsx:352-433`), but on the authored path it interpolates model-supplied values (`Connect {request.name}` `:352`; hosts/slots via `renderReach` `:363`,`:436` come from the agent's own draft) — so it is source 1 wrapping source 3, not pure source 1 | see seed rules | `allow` today — the tool executes |
| **E20** Propose-tool chokepoints | `connector_propose` → `packages/tool-connector-propose/src/plugin.ts:185` → `packages/connectors/src/plugin.ts:671`; `skill_propose` → `packages/skills/src/plugin.ts:1123` | `connector_propose` persists a **pending, zero-reach draft** — the strongest real gate in the repo. `skill_propose` on the self-authored path goes straight to `active` with **no card and no human** (`propose-gate.ts:35`) | model-supplied draft; scope is host-derived from `toolCtx`, never the model (`plugin.ts:166-169`) | **yes** | see seed rules | `allow` today — both tools execute |

### Notes on the table

**On "verdict it would carry today."** The column is filled honestly, per the plan's
instruction. That is why E19 and E20 read `allow`: the propose/request tools **execute**,
and the human approval happens *afterwards*, on the row or card they produced. Nothing in
this repo stops a tool call and waits. Promoting those to `hold` in AW-3 is a change of
behaviour, not a codification of it — see the seed-rule caveats.

**On `†`.** E8, E12, E13 and E14 are describable, but not as a clause on a rule matching a
tool name. They key on hostnames and connector ids, which is §4.3.4's "Granted by you"
group. Filing them as `PolicyRule`s would be a category error and would put a sentence on
the rail that no `tool:pre-call` subscriber can enforce.

**Two enforcement points nothing on the rail can currently see.** E18's vetoes send their
reason to stderr — not to the model, not to the user, not to any hook. And E14's rows are
written but never read. Both are noted as follow-ups rather than fixed here.

---

## 1. How many enforced conditions have a describable meaning?

**Half of the twenty enforcement points — ten — have no describable user-facing meaning at
all. Of the ten that do, only three can be expressed as a `PolicyRule` keyed on a tool
name. Those three rows yield seven distinct conditions, and only four of the seven
reflect something actually enforced today: the `DISABLED_BUILTINS` denies, on one
runner.**

Breakdown, by enforcement point:

| | Rows | Which |
|---|---|---|
| Describable **as a `PolicyRule` clause** | **3** | E7 (→ 4 `deny` conditions), E19 + E20 (→ 3 `hold` conditions, **new policy** — see below) |
| Describable, but as a §4.3.4 **grant row** | 4 | E8 egress allowlist, E12 host grants, E13 connector resolve, E14 approved caps |
| Describable, but **not on the tool-call path** | 2 | E17 skill quarantine, E18 workspace-write vetoes |
| Describable **only as a tool name** (§4.3.3 mechanical) | 1 | E16 MCP catalog |
| **Not describable at all** | 10 | E1, E2, E3, E5, E6, E9, E10, E11, E15, and E4 (empty) |

The three-versus-seven distinction matters for AW-3. E19 and E20 are describable and do
become rules — but their verdict *today* is `allow` (the tools execute; approval happens
downstream on the row or card they produce). So **the rule table AW-3 can seed from
conditions the repo already enforces is four `deny` rules.** Everything else is either new
policy, a catalog-allow fact, a grant row, or a mechanical MCP row.

The ones that do **not** have a describable meaning, and why:

- **E1 governed-path re-rooting** — the user does not have a mental model of "the git tier
  versus NFS", and does not need one. Correctly invisible.
- **E2 fail-closed deny** — an IPC timeout is not a policy. It currently leaks a raw
  `Error.message` (`socket hang up`, a zod dump) into the transcript as if it were one.
- **E3, E5, E6** — seams. They apply a verdict; they do not decide one.
- **E4** — the chain is empty. There is nothing to describe.
- **E9 private-IP gate, E10 canary tripwire** — security floors that operate on IPs and
  raw bytes. They belong in a security note, not in a list of things the agent may do.
- **E11 credential substitution** — invisible by design.
- **E15 authored-skill zero-reach** — correctly produces no row; the connector rows
  already cover the reach. (§4.3.3's claim here is **confirmed**.)

**So: yes, "almost none."** The card anticipated this outcome and named its consequence
correctly — AW-3's rule table starts nearly empty, and the rail is mostly §4.3.3
mechanical rows and §4.3.4 grant rows. That is a materially different surface from the
prototype, which shows nineteen hand-written `allow`/`hold`/`deny` rows across five
agents (`workspace-seed.ts:497-523`) and exactly one unmapped row.

**A further finding the design did not anticipate: not one enforcement point *on the
tool-call path* keys on a predicate over tool input.** Every such condition matches on the
tool *name* alone. (The points that key on richer input — E8 on a hostname, E12/E13 on
grant tuples, E17 on bundle text, E18 on a file path and its bytes — are the ones that sit
*off* the tool-call path, which is why none of them can back a `PolicyRule` either way.)
§4.3.1's `match: { tool: string; when?: PredicateSpec }` therefore has **zero day-one
users**. AW-3 should ship `match: { tool: string }` and add `when` when the first rule
needs it — per the plan's own YAGNI rule. The prototype's fixture sources
(`gmail.send · intent=scheduling`, `calendar.move_event · attendees>1`) are precisely the
predicate-shaped rules that do not exist.

**And the prototype's rail names a tool catalog that does not exist.** Every `source` in
`packages/channel-web/mock/workspace-seed.ts:495-525` — `gmail.read`, `slack.history`,
`calendar.respond`, `travel.book`, `payment.*` — refers to a tool no plugin registers. The
real catalog is eleven tools: `memory_search`, `memory_read_section`, `memory_note`,
`search_catalog`, `request_capability`, `web_search`, `web_extract`, `artifact_publish`,
`skill_propose`, `connector_propose`, and namespaced `mcp.<serverId>.<tool>` — plus the
runner's own builtins. Those differ by runner, and the difference matters for the rail:

- **aisdk** registers a closed set of seven — `Bash`, `Read`, `Write`, `Edit`, `Glob`,
  `Grep`, `Skill` (`agent-aisdk-runner/src/tools/builtins.ts:160,189,219,243,278,303` +
  `skill-tool.ts`).
- **claude-sdk** passes `allowedTools: ['Skill', ...agentConfig.allowedTools]` with
  `agentConfig.allowedTools` **empty by orchestrator default**, which the SDK reads as
  *no per-agent restriction* (`main.ts:474-480`). Its live catalog is therefore the SDK's
  own default set minus `disallowedTools` — so it also includes `NotebookEdit` and `LS`
  (`governed-paths.ts:26`), `MultiEdit` (`git-workspace.ts:367`), and `TodoWrite`
  (`agent-claude-sdk-runner/SECURITY.md:53`, which enumerates the runner's builtin set).
  Note `TodoWrite` is *not* registered by aisdk (`agent-aisdk-runner/src/tools/builtins.ts:36`),
  so it is a genuine per-runner difference, not a shared builtin.

AW-14 must re-skin the prototype against *that* list, not reproduce the fixture — and must
not present the aisdk seven as if they were the whole catalog, which would understate reach
on the runner most sessions actually use (H4).

---

## 2. Who authors `capability` clauses?

| Source | Author | Reviewable? | Where it lives |
|---|---|---|---|
| **Built-in rules** | **Us, in-repo.** | Yes — same diff, CI-linted | `packages/tool-policy/src/rules.ts` (AW-3) |
| **Connector manifests** | **Nobody. There is no field.** | n/a | — see below |
| **MCP server tools** | **Nobody** — mechanical row only | n/a | Vendor `description` rendered as attributed evidence, never as our claim |
| **Dynamic grants** | Derived from the grant record | Mechanically | `host_grants_v1_grants` → "reach `<host>`"; `skills_v1_approved_caps` → per-`kind` template |
| **Agent-authored skills** | Never a row | n/a | Zero-reach by construction (E15) |

**The connector row is the problem.** §4.3.3 asserts that a connector manifest supplies
its own `capability` clause per exposed operation. It does not, and it has nowhere to put
one:

- `Connector` (`packages/connectors/src/types.ts:204-233`) carries `description` and
  `usageNote` — **one blurb for the whole connector**, and `usageNote` is model-facing
  (folded into the connector's synthetic `SKILL.md` at `types.ts:341-350`), not
  user-facing.
- `Capabilities` (`packages/skills-parser/src/capabilities.ts:50-67`) is
  `allowedHosts` / `credentials` / `mcpServers` / `packages` / `services`. There is no
  operation list at all — a connector's reach is expressed as hosts and credential slots,
  never as named operations.
- `McpServerSpec` (`capabilities.ts:24-33`) has no `tools` field; the tool list is
  discovered from the server at runtime.
- `CapabilitySlot.description` (`capabilities.ts:12-22`) is per **credential slot**
  ("what this API key is for"), not per operation.
- Neither `Capabilities` zod mirror is `.strict()` — `packages/connectors/src/types.ts:169-177`
  and `packages/skills-parser/src/capabilities.ts:115-121` are both plain `z.object`. So an
  added `capability` key is **silently stripped on read**, not rejected. That is worse than a
  gate, not better: a clause an operator wrote would vanish with no error. (`.strict()` *is*
  used elsewhere in that file — `OAuthSlotSchema:111`, `ServiceDescriptorSchema:167` — and
  `:89-90` notes the api-key variant deliberately opts out. The capability path is simply not
  one of them.)

**Recommendation for AW-14:** render connectors as §4.3.4 grant rows derived from the
connector record (`name` + `allowedHosts`), sourced by connector id. Adding a
per-operation clause is a schema change across two packages (`skills-parser` and
`connectors`, which deliberately re-declare rather than import) plus a UI for operators to
write it — and, critically, **there is no enforcement point positioned to read it**: the
proxy sees bytes, and `connectors:resolve` runs before the turn starts. That is its own
card, not a line item in AW-14.

---

## 3. Which of §4.3 does this invalidate?

### 3.1 INVALIDATED — §4.3.3, connectors

> **"A connector manifest supplies its own `capability` clause per exposed operation.
> Operator-configured and reviewable, so it renders normally — with the connector id as
> the source rather than a rule id."**

No such field exists, and connectors have no concept of an "exposed operation" (§2 above).

**Replaces it:** *A connector renders as a grant row in the "Granted by you" group,
mechanically derived from the connector record — its `name` and its `allowedHosts` —
sourced by connector id. Per-operation clauses require a new field on `Capabilities`, its
two zod mirrors, an operator-facing editor, and an enforcement point able to read it; none
of those exist and none are in this epic.*

### 3.2 INVALIDATED — §9, the premise of P3

> **"P3 before P4 is deliberate — authoring `capability` clauses for the existing policy
> is useful on its own and surfaces how many rules currently have no describable
> meaning."**

There is no existing policy. `tool:pre-call` has no production subscriber; there is no
`PolicyRule` type, no rule table, and no evaluator.

**Replaces it:** *P3 is not an authoring pass over existing rules — it is the creation of
the first rule table, and of the first `tool:pre-call` subscriber that enforces it. Four
rules encode conditions enforced elsewhere today (the `DISABLED_BUILTINS` denies); the
rest are either new policy (the `hold` rules) or catalog-allow facts.*

### 3.3 NARROWED — §4.3.1, the implication that rows come from rules

> **"The rail renders `capability` through a frame chosen by `verdict`, and prints `id`
> beside it as the source."**

True for rules, but on today's catalog **most rail rows will not come from a rule.** The
realistic day-one rail is roughly: 4 rule-sourced denies, ~7 catalog-allow rows, 2–3
`hold` rows, plus grant rows and mechanical MCP rows.

**Replaces it:** *Each row carries its own provenance — `rule` \| `catalog` \| `grant` \|
`mcp` \| `unmapped` — and the rail renders the frame from the verdict in every case. A
`catalog` row asserts only "this tool is reachable and no rule gates it", which is a true
statement about the system and must not be dressed up as a reviewed policy decision.*

### 3.4 EXTENDED — §4.3.4, dynamic grants

> **"JIT host grants (`@ax/host-grants`) and connector approvals change the answer at
> runtime."**

Correct, but **incomplete**. There is a second durable grant store the design does not
mention: `skills_v1_approved_caps` (`packages/skills/src/approved-caps-store.ts`), keyed
on `(owner, agent, {skillId|connectorId}, kind, value)` with `kind ∈ {host, slot, npm,
pypi, mcp}`. A rail that reads only `@ax/host-grants` **understates reach** — the H4
direction we are not allowed to be wrong in.

**Adds:** *The "Granted by you" group reads both `host-grants:list` and
`skills:approved-caps-list`.*

**Update 2026-08-23 (TASK-241):** this shipped. AW-14 **is** TASK-235 (PR #439, bug-fixed
by TASK-264 / PR #447), and it **is** `skills:approved-caps-list`'s first real reader —
`packages/channel-web/src/server/routes-workspace.ts:2523`, `hasService`-guarded at
`:2457`, with a second reader for `skills:approved-caps-revoke` behind the group's Revoke
control. As written on 2026-08-21 this paragraph said the hook had "no production caller";
that was true then and is false now. The stale `optionalCalls` degradation it cited
(`packages/agents/src/plugin.ts`) described behaviour TASK-100 removed and has been
deleted — `@ax/agents` never calls this hook.

### 3.5 CONFIRMED — §4.3.3, agent-authored skills

> **"an authored skill never adds a rail row of its own"**

Confirmed in code. `packages/skills-parser/src/manifest.ts:179-192` makes a
`capabilities:` block — and each of `allowedHosts` / `credentials` / `mcpServers` /
`packages` — a **hard parse failure**. `MODELED_KEYS` is `{name, description, version,
sourceUrl, connectors}`. Reach flows only through `connectors:resolve`. The pleasant
property from TASK-100 holds; do not lose it.

### 3.6 CONFIRMED — §4.3.5, the unmapped row

Confirmed and *more load-bearing than the design assumes*. With only four rule-backed
conditions, the unmapped state is not a rare edge case for third-party sources — it is
where a large fraction of the real catalog lands on day one. §4.3.5's "for built-in rules
this state is a CI failure" still holds (every rule in `rules.ts` gets a clause), but the
rail must be designed expecting many non-rule rows, not one deliberate example.

---

## Seed rules for AW-3

Paste into `packages/tool-policy/src/rules.ts`. Every `capability` is a bare infinitive
clause, ≤60 characters, no leading "to", no verdict words (`never`/`always`/`asks`/`can`),
no tool identifiers — the shape `capability-lint.ts` must enforce.

Rules match on the **ax-native tool name** (post-classifier, `mcp__` prefixes already
stripped — the `axToolName` parameter at `packages/agent-runner-core/src/tool-policy.ts:54`,
sent as `call.name` at `:64`).

### Denies — codify what `DISABLED_BUILTINS` already enforces

These four are the only rules in this table that describe a condition enforced in the repo
today (E7). Today all four share the string `'tool disabled by policy'`; each has a
distinct, documented cause (`tool-names.ts:18-46`).

> **These four rules will never fire in the evaluator, and that is expected.** They are
> **rail rows, not enforcement.** `classifySdkToolName` returns `{ kind: 'disabled' }` with
> **no `axName`** (the union variant at `tool-names.ts:70`; the `return { kind: 'disabled' }` at `:77`), and `pre-tool-use.ts:35-44` returns `deny` before
> `policy.preToolUse` is ever called — so a disabled builtin never reaches `tool:pre-call`
> to be matched. On the aisdk runner the four are not registered at all. AW-3 must not
> "verify" them with an evaluator test that asserts a `deny` verdict from a live call; test
> them as table rows whose rendering is correct, and keep `DISABLED_BUILTINS` as the
> enforcement. If AW-3 wants one source of truth, the right move is to *derive* these four
> rows from `DISABLED_BUILTINS` rather than hand-copy the names into `rules.ts`.

```ts
{
  id: 'builtins.web-fetch',
  match: { tool: 'WebFetch' },
  verdict: 'deny',
  capability: 'reach websites outside the recorded connection',
  subject: 'agent',
},
{
  id: 'builtins.web-search',
  match: { tool: 'WebSearch' },
  verdict: 'deny',
  capability: 'search the web outside the recorded connection',
  subject: 'agent',
},
{
  id: 'builtins.task',
  match: { tool: 'Task' },
  verdict: 'deny',
  capability: 'start a hidden helper agent',
  subject: 'agent',
},
{
  id: 'builtins.ask-user-question',
  match: { tool: 'AskUserQuestion' },
  verdict: 'deny',
  capability: 'ask you a multiple-choice question',
  subject: 'agent',
},
```

### Holds — new policy, not a codification

**Read this before implementing.** None of these three tools is held today; all three
execute and raise their approval *afterwards* (E19, E20). Promoting them to `hold` moves
the gate earlier and gives it a durable Decision row instead of a turn-scoped card. Two
consequences AW-4/AW-5 must handle:

1. **A `hold` at pre-call means the tool never runs, so the pending row/card it would have
   created never exists.** The Decision row must therefore carry the *replay*, not point
   at a draft. For `request_capability` and `connector_propose` this is fine — both are
   `executesIn: 'host'`, so AW-5's `tool.execute-host` replay works.
2. **`skill_propose` is `executesIn: 'sandbox'`** (`packages/tool-skill-propose/src/descriptor.ts:82`),
   so the host **cannot** replay it. A `hold` on it is executable only on the attended
   path, by the still-warm agent re-issuing the call. It is seeded below because it is the
   plan's named example, but AW-5 must treat it as the first real case of "a `hold` the
   host cannot replay."

`request_capability` is the rule AW-4's canary should use: `@ax/skill-broker` is pushed
**unconditionally** into the k8s preset (`presets/k8s/src/index.ts:990`), so the tool is
always in the catalog, and it is host-executed and therefore replayable.

```ts
{
  id: 'skills.request-capability',
  match: { tool: 'request_capability' },
  verdict: 'hold',
  capability: 'gain access to a new service or key',
  subject: 'agent',
},
{
  id: 'connectors.propose',
  match: { tool: 'connector_propose' },
  verdict: 'hold',
  capability: 'set up a new connection for you',
  subject: 'agent',
},
{
  id: 'skills.propose',
  match: { tool: 'skill_propose' },
  verdict: 'hold',
  capability: 'install a skill it wrote for itself',
  subject: 'agent',
},
```

> `skill_propose` and `connector_propose` are registered only when
> `allowUserInstalledSkills` is on (`AX_ALLOW_USER_INSTALLED_SKILLS=true`;
> `presets/k8s/src/index.ts:1121`, `:1135`). A rule matching an unregistered tool is inert,
> not an error — but do not build the canary on one.

### Allows — catalog facts, marked as such

These describe tools that are reachable and that nothing gates. They are **not** reviewed
policy decisions, and AW-3 should carry a provenance marker so the rail can render them
per §3.3 above rather than implying a rule was deliberated.

```ts
{ id: 'web.search',           match: { tool: 'web_search' },          verdict: 'allow', capability: 'search the web',                    subject: 'agent' },
{ id: 'web.extract',          match: { tool: 'web_extract' },         verdict: 'allow', capability: 'read a web page you name',          subject: 'agent' },
{ id: 'memory.search',        match: { tool: 'memory_search' },       verdict: 'allow', capability: 'look things up in its own memory',  subject: 'agent' },
{ id: 'memory.read-section',  match: { tool: 'memory_read_section' }, verdict: 'allow', capability: 'read a section of its own memory',  subject: 'agent' },
{ id: 'memory.note',          match: { tool: 'memory_note' },         verdict: 'allow', capability: 'write a note to its own memory',    subject: 'agent' },
{ id: 'skills.search-catalog',match: { tool: 'search_catalog' },      verdict: 'allow', capability: 'look through the skill catalog',    subject: 'agent' },
{ id: 'artifacts.publish',    match: { tool: 'artifact_publish' },    verdict: 'allow', capability: 'publish a file for you to open',    subject: 'agent' },
```

> `web_search` / `web_extract` need a provider API key; the memory tools need
> `@ax/memory-strata`. Inert where absent.

### Deliberately not seeded

- **`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`.** A `hold` on `Bash` would fire on
  every command and make the surface unusable; an `allow` row saying "run any command on
  its own" is true but is the whole blast radius in one line, and belongs in a designed
  §4.3 treatment rather than a seed rule. AW-14 owns how the sandbox builtins are
  presented. (Explorer note: `Bash` is attractive as a canary because it crosses
  `PreToolUse` unconditionally — but that is exactly why a rule on it is dangerous.)
- **Anything with a `when` predicate.** No enforced condition keys on tool input today
  (§1); ship `match: { tool }` and add `when` when a rule earns it.
- **Host / connector / approved-cap rows.** Grant rows (§4.3.4), not `PolicyRule`s.
- **MCP tools.** Mechanical rows (§4.3.3); their only text is the vendor's, which is
  evidence, never our claim.

---

## Follow-ups this inventory surfaces

Not fixed here; each wants its own card.

1. **`DISABLED_BUILTINS` denials all say `'tool disabled by policy'`** — four distinct
   causes, one meaningless string. Once AW-3 exists, the rule's `capability` should supply
   the reason.
2. **The fail-closed deny leaks raw `Error.message` to the model** (E2,
   `tool-policy.ts:73`). An IPC timeout renders as a policy sentence.
3. **Workspace-veto reasons reach stderr only** (E18). A `git reset --hard` discards the
   agent's turn work and neither the model nor the user is told why.
4. ~~**`skills:approved-caps-list` has no production caller** (E14) — grants are recorded
   and never read. Either the rail becomes its reader (AW-14) or the store is dead code.~~
   **RESOLVED 2026-08-22 (TASK-241 records it):** the rail became its reader. AW-14 shipped
   as TASK-235 (PR #439, fixed by TASK-264 / PR #447) —
   `packages/channel-web/src/server/routes-workspace.ts:2523`. The rows are read; they are
   still not consulted to *gate* a turn, which is by design (they are a report, not an
   enforcement point).
5. **A self-authored, clean-scanning skill installs with no card and no human**
   (`propose-gate.ts:35`). Deliberate post-TASK-100, but it means "install a skill it
   wrote for itself" is currently unattended.
6. **Connector manifests need a per-operation capability field** if §4.3.3 is ever to work
   as written — schema change across `skills-parser` + `connectors`, an operator editor,
   and a reader that does not yet exist. Note neither `Capabilities` mirror is `.strict()`,
   so a field added to one and not the other would be silently dropped, not caught.
7. **A stale comment claims a single pre-apply rejecter.**
   `packages/ipc-core/src/handlers/workspace-commit-notify.ts:289-290` says "Today the ONLY
   pre-apply rejecter is @ax/validator-skill's SDK-config veto". `validator-identity` and
   `validator-routine` also reject. The adjacent `recoverable: false as const` (`:294`) is
   what makes every veto a hard reset, so the comment matters more than a comment usually
   does.
