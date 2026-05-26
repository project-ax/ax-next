# Just-in-Time Capability Acquisition — Design

**Status:** Draft for review · **Date:** 2026-05-26
**Scope:** The in-chat "spine" by which a user (and the agent on their behalf) acquires a missing capability — a skill, a host, a credential — at the moment the conversation needs it, with the human in the loop. Smart defaults, the out-of-band settings mirror, and the full admin experience are **derived** pieces, designed in **Part II** of this doc (see §12).

---

## 1. Problem

AX is powerful but its power is entirely **out-of-band and mostly admin-only**. Today:

- **Skills** are added by hand-authoring a `SKILL.md` in settings (admin "Skills" tab → global scope, or user "My Skills" → private scope). There is no catalog, no marketplace, no in-chat discovery or install.
- **Egress hosts** come from a *static allowlist* computed once at sandbox spawn (`agent.allowedHosts` ∪ each attached skill's `capabilities.allowedHosts`). A blocked host returns a dead 403. No in-session approval.
- **Credentials** are entered in a separate destination form and bound to a skill's slots **by an admin, at agent-attach time** (`PATCH /admin/agents/:id/skill-attachments`). Credentialed skills cannot be default-attached. No in-chat prompt.

So the user's canonical ask — *"check my Linear issues"* — is impossible for a non-admin today without an admin first authoring a Linear skill, attaching it, and someone pasting a key. A multi-step dance across two roles, entirely outside the conversation.

**Goal:** hide all of that until the moment it's needed. When the conversation needs a capability, surface a minimal in-context approval *right where the user is*, keep the human in the loop on every security decision, and make settings the out-of-band mirror of the same controls. The common path should need **zero** prompts (smart defaults); the uncommon path should be **one card**, not a trip to an admin console.

## 2. Current state (ground truth)

A reader needs this to evaluate the design. All verified against the code on `main` as of this date.

- A **skill** is a `SKILL.md`: YAML manifest + markdown body. The body is what the SDK indexes; the manifest declares capabilities: `allowedHosts`, `credentials` (slots, kind `api-key`, no inline secrets), `mcpServers`, `packages` (`npm`/`pypi`), `sourceUrl`.
- **Storage today is two text columns** (`manifestYaml` + `bodyMd`, `skills/src/types.ts:28`) — there is **no** mechanism to bundle additional files (scripts, data, a vendored server). Agent-authored skills *can* hold extra files because `.ax/skills/<id>/` is a real workspace directory; catalog skills cannot. This design closes that asymmetry (§9.2).
- **Materialization & trust domains** (this is load-bearing for §8):
  - **Catalog / attached skills** materialize into `$CLAUDE_CONFIG_DIR/skills/<id>/` — and `CLAUDE_CONFIG_DIR = <sandbox-HOME>/.ax/session` (`agent-claude-sdk-runner/src/git-workspace.ts:263`). So catalog skills live at **`.ax/session/skills/`**, host-controlled, `chmod 0555/0444`, re-materialized from the catalog store every session (`installed-skills.ts`). SDK `user` source.
  - **Agent-authored skills** live in the **workspace** at **`.ax/skills/`**, surfaced via a narrow `.claude/skills → ../.ax/skills` symlink (`git-workspace.ts:182`, `main.ts:228`). Agent-**writable**, git-tracked, policed by `@ax/validator-skill` at the `workspace:pre-apply` boundary. SDK `project` source.
- **Session model:** the runner runs **one persistent `query()` for its whole life** (`main.ts:73`). Skills, MCP servers, and the subprocess env are read **only at session init** — there is no hot-reload. Skills are therefore **frozen at sandbox spawn**.
- **Egress** is gated per-session by the credential-proxy against the unioned allowlist (`credential-proxy/src/listener.ts`). Credentials never enter the sandbox in plaintext: each slot resolves to an `ax-cred:<hex>` placeholder, substituted on the wire by the MITM proxy. The placeholder is also forwarded into the SDK subprocess env so the model's Bash tool can reference `$SLOT` (`proxy-startup.ts:204`).
- **Package registries** auto-allowlist (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`) **only when a skill declares `capabilities.packages`** (`orchestrator.ts:1167`) — *not* when an MCP server merely uses `command: npx`.

## 3. Risk tiers (the real fault line)

Skills are not a smooth spectrum; they fall into three tiers, and the line that matters for trust is **"does it download and run code from a public registry?"**

| Tier | What it is | Supply-chain exposure |
|---|---|---|
| **Inert** | instruction-only (no egress/code/creds) | none |
| **Bounded** | code is *fixed & reviewable* — `http`-transport MCP (one host, *zero* local code), or **bundled files** (scripts/data shipped with the skill, §9.2) run via CLI | only the declared hosts; the code was vetted at admit, not downloaded |
| **Registry** | code is *downloaded unreviewed at runtime* via `npx`/`uvx`/`pip` | whole registry + arbitrary transitive code, executed in-sandbox |

The fault line is **provenance, not presence of code**: Bounded code is fixed and reviewed at admit (or absent, for http MCP); Registry code is fetched unreviewed from a public registry every run. The catalog-admit review (§6) is what makes Bounded *bundled* code acceptable and is what guards the **Registry** tier. (Note: a *bundled* script that itself shells out to `pip`/`npx` is Registry-tier — the trigger doesn't matter, the registry download does.)

## 4. Locked design decisions

Each was chosen deliberately during brainstorming; rationale included so a future reader can see *why*, not just *what*.

1. **Anchor on the in-chat spine.** Smart-defaults, settings, and admin UX are derived from it (§12).
2. **Surfacing = model-brokered, primary; reactive walls, secondary.** The agent has an always-on broker tool to match intent → catalog → propose. Separately, a raw egress 403 becomes an in-chat "allow host?" prompt, covering ad-hoc fetches no skill declares.
3. **Hosts + credentials are always the user's own call, for their own session.** A vetted skill declares exactly which hosts/slots it needs; granting only widens *that user's* already-isolated sandbox and stores *their own* secret. No admin in this loop.
4. **One bundled approval card.** Because the manifest declares hosts + credential slots, choosing a skill tells us everything to ask for — install + approve hosts + enter key(s) collapse into a single card, not three wall-hits.
5. **Two modes.**
   - **Curated (default):** broker proposes from a **self-healing catalog**. In-catalog → instant in-chat self-install. Not-in-catalog → a one-time *"admit to catalog"* request to the admin; once admitted, self-serve for everyone. The agent never authors.
   - **Open (admin enables `allow_user_installed_skills`):** all of the above **plus** the agent may author + install a **user-scoped** skill on the fly (from scratch or a web template), gated by the same card.
6. **The card is the security boundary in open mode.** If the agent — possibly nudged by injected content — authors a skill that wants `evil.com` or an arbitrary package, the user sees exactly that on the card before anything spawns.
7. **Two acquisition classes with different mechanics** (§7).
8. **stdio MCP is out of the MVP broker/catalog** (§9.1). `http` MCP stays in.
9. **Catalog skills carry bundles** (file trees, not just SKILL.md), stored **content-addressed in git** and **foundational** (the skill model is bundle-native from the first slice) (§9.2).

## 5. The risk-aware policy

| Tier | Curated (default) | Open |
|---|---|---|
| **Inert** | self-serve | self-serve |
| **Bounded** | catalog → instant; else admit-request | self-serve / agent-authored |
| **Registry** | catalog → instant; else admit-request | self-serve / agent-authored |

Hosts + credentials: always the user's own call, on the card, regardless of tier or mode.

## 6. The spine — end-to-end flows

### A. Happy path (catalog skill, model-brokered)

```
You:   check my Linear issues
       · agent calls broker tool → finds "linear" in catalog
       ┌───────────────────────────────────────────┐
       │  Connect Linear                              │
       │  Lets me read & update your Linear issues.   │
       │  Will access:   api.linear.app               │
       │  Needs a key:   Linear API key  [_________]  │
       │            [ Not now ]      [ Connect ]      │
       └───────────────────────────────────────────┘
You:   (paste key, Connect)  ··· connecting ···
Agent: Here are your 3 open issues: …
```

1. Broker tool (always-on, Inert) matches intent → catalog hit.
2. Manifest → hosts + credential slots → **one bundled card**.
3. The key field posts **straight to the host credential store** (reuses the existing destination-credential route, user scope) — never into the model or transcript; resolved to an `ax-cred:` placeholder.
4. Hosts allowlisted; skill attached **for this user** (§11.2); sandbox re-spawns; session resumes; the still-pending original ask is answered. **Seamless feel, Opt-2 plumbing** (§7).

### B. Reactive wall (ad-hoc host, no skill)

```
Agent: (fetch status.example.com → proxy 403)
       ┌───────────────────────────────────────────┐
       │  Allow access to status.example.com?         │
       │  [ Just this once ]   [ Always for this agent ]│
       └───────────────────────────────────────────┘
```

- Granting widens the **live** session allowlist (`proxy:add-host`, §11.4) — **no re-spawn**; the agent retries.
- "Always" persists to a per-`(user, agent)` grant list, revocable in settings.

### C. Open mode (agent authors a skill)

Same card, one banner line: *"⚠ This is a new skill your assistant just wrote."* The user still approves hosts/creds — the backstop. The authored skill is user-scoped, written to `.ax/skills/`, promoted via the existing workspace path, validator-policed.

### D. Share-to-catalog (promotion across trust domains)

A user/agent-authored skill can be submitted for org-wide use. This is the **same admit-to-catalog request** as a cold-start, sourced from the user's own skill — so the catalog self-heals from both first-party candidates and user contributions. Admin review **is** the supply-chain gate (and bites hardest on Registry-tier).

```
DRAFT                          SUBMITTED            CATALOG
.ax/skills/<id>      ──submit──▶  admin review  ──approve──▶  catalog DB
(workspace, RW, self)                                          │
                                                               ▼ (each session)
                                                  .ax/session/skills/<id>
                                                  (CONFIG_DIR, RO, org-wide)
```

On admission the canonical source becomes the **catalog DB**; it materializes read-only into `.ax/session/skills/` for everyone, **including the author**. The promotion carries the **entire bundle** — every file under `.ax/skills/<id>/`, not just `SKILL.md` (§9.2); without bundle support this step silently drops the skill's other files. Because `.ax/skills/<id>/` is already a git tree in the author's workspace, admission is mechanically *"register this tree SHA in the catalog"* — and the SHA guarantees the bytes that ship are exactly the bytes the admin reviewed (no review-vs-ship drift). The author's writable `.ax/skills/<id>` working copy **must be retired** — a hard requirement, for two reasons:

1. **Duplicate-id collision** — both copies surviving means the SDK discovers the same id from `project` (`.ax/skills`) *and* `user` (`.ax/session/skills`).
2. **Integrity** — an editable local copy would let the agent fork the vetted skill and re-add egress/credentials the admin never approved, defeating the read-only trust domain.

Re-editing later = author a *new draft* and **re-submit** (re-runs review). The live catalog skill is never mutated in place.

## 7. Turn & re-spawn mechanics

| Acquisition | Re-spawn? | Mechanism |
|---|---|---|
| **Host grant** (wall) | **No** | widen live allowlist (`proxy:add-host`) + model retries |
| **Skill install / author** | **Yes** | the SDK reads skills/MCP/env only at init, so a fresh skill needs a re-init |

For the skill case, **seamless feel on Opt-2 plumbing**:

- Engineer the robust path: the brokering turn is held as **pending** (the broker tool call yields without committing a final assistant turn). On approval, the orchestrator installs/attaches/binds, re-spawns, calls the existing `resume()` to rehydrate the transcript, and the still-pending original user message is answered.
- Tune the card + system prompt so the agent **doesn't narrate** the handoff and any synthetic `continue` stays hidden — it reads as one continuous answer with a permission interlude. Degrades gracefully (to a visible "approve and I'll continue") if the model gets chatty.

## 8. On-disk layout & trust domains

(See §2 and §6D.) The split between `.ax/skills` (workspace, agent-writable, per-user, `project` source) and `.ax/session/skills` (config dir, host-controlled read-only, org-wide, `user` source) is the integrity backbone. Acquisition either:

- writes a draft into the **writable** domain (open-mode authoring), or
- materializes a vetted entry into the **read-only** domain (catalog install),

and promotion (§6D) is a **move across domains**, never an in-place edit of vetted bytes.

## 9. Scope decisions: skill format

### 9.1 stdio MCP is out of the MVP

The broker/catalog MVP surfaces only **non-stdio** forms: **Inert** (instructions), **Bounded → `http` MCP only**, **Registry → CLI only** (`npx`/`uvx`/`pip` run from Bash). Note this drops *both* stdio forms from the §3 taxonomy — a vendored `node` server **and** an npx-launched MCP server are both stdio transports, so neither is surfaced.

**Why drop stdio:** it is the heaviest tier — it spawns **eagerly at session boot** (one resident process per skill, held across keepalive idle whether used or not), an npx/uvx server **downloads its deps at boot** (cold-start latency), and it carries the **registry-coupling gotcha** (must also declare `packages` or it won't start). A CLI tool sheds all three: lazy invocation, no resident process, no boot download.

**What covers the gap:** CLI (Registry tier) handles the common "wrap a SaaS API" case directly (`gh issue list`, `curl api.linear.app` with `$LINEAR_API_KEY` + `api.linear.app` allowlisted); modern models drive CLIs from the body well. `http` MCP stays in for typed tools without any stdio baggage.

**Honest caveat:** this is an **operational/UX** simplification, **not a security** one — a CLI still `npx`s arbitrary registry code, so the supply-chain fault line (§3) is unchanged. The win is lifecycle + cold start + losing the coupling gotcha.

**Deferred (earn-it-later):** integrations that ship *only* as stdio with no CLI/REST/http-MCP equivalent, and stateful local servers (browser/DB sessions). The existing, tested stdio code is **not removed** — it stays reachable via the admin-attach path, simply not surfaced in the broker.

### 9.2 Skill bundles are in (catalog skills carry files, not just SKILL.md)

A skill is upgraded from "two text columns" to a **bundle**: a file tree rooted at the skill dir, with `SKILL.md` at the root plus arbitrary supporting files (`scripts/*.py`, reference data, templates, and — once §9.1 is lifted — a vendored server). This is **required**, not cosmetic:

- **It fixes the §6D data-loss bug.** Promoting a multi-file agent-authored skill to a SKILL.md-only catalog silently drops every file but `SKILL.md`. Share-to-catalog only works correctly once the catalog carries the whole tree.
- **It's the safer code path.** A bundled, reviewed `scripts/foo.py` run via CLI beats `npx some-unreviewed-package` — same in-sandbox execution, but the bytes were vetted at admit (Bounded, not Registry — §3).

**Storage — content-addressed in git.** A bundle is stored as a **git tree** in the host-side git storage that already backs workspaces (`git-workspace.ts` infra); a catalog entry is `{ skillId, scope, version, treeSha }` plus a parsed index (`manifestYaml`/`bodyMd`) over the root `SKILL.md` blob. Reusing the existing git substrate buys four things for free: **integrity** (the tree SHA pins the exact bytes — tampering changes the SHA, so the read-only trust domain is guaranteed cryptographically, not by convention), **dedup** (identical blobs are shared), **versioning** (a new version is a new tree/commit), and the promotion story in §6D (admission = *register a tree SHA*, which proves shipped-bytes == reviewed-bytes).

**Security envelope (non-negotiable):**
- **Path safety** — relative paths only; reject `..`, absolute paths, and symlinks (or refuse to follow them). A bundle cannot escape its own dir or point at host files. (Mirrors v1 `safePath`.)
- **Read-only materialization** — the whole tree lands in `.ax/session/skills/<id>/` at `0444`/`0555`, exactly like SKILL.md today. **No execute bit** — scripts run via their interpreter (`python scripts/foo.py`), never by exec permission.
- **Veto list** — a bundle MUST NOT ship `.mcp.json` (the only `.mcp.json` is the one *generated* from the manifest — a bundled one would bypass the command-whitelist) or any SDK auto-config (`.claude/*`, `CLAUDE.md`, etc.). Reuse `@ax/validator-skill`'s existing veto set.
- **Caps** — total bundle size + file count, enforced host-side and **re-checked at the runner trust boundary** (defense-in-depth, the `validateMcpEntry` pattern — a buggy/compromised host could otherwise write arbitrary files into the sandbox).
- **Validation fires at the git-extract boundary.** Git can natively represent symlinks (mode `120000`) and the executable bit (`100755`), so the path-safety and no-exec-bit rules are enforced when a tree is *materialized*, not inferred from the storage layer. Content-addressing gives integrity/dedup/versioning underneath; it does **not** replace mode/path validation.

**Review burden (the real cost):** admit now means **reviewing code**, not just a manifest + prose. The admit UI needs a file-tree/diff view, and the review is heavier. This is the catalog-as-supply-chain-gate doing exactly its job — but it raises the bar on what "admit" entails, and it's why bundled code is acceptable org-wide only *after* that review.

**Open-mode caveat:** an agent-authored bundle is **not** admin-reviewed. That's acceptable because bundled code grants nothing beyond what the agent can already do via its Bash tool in the same sandbox, and the approval card still gates the only thing that crosses a trust boundary (egress + credentials). The code-review safety only attaches when the skill is *admitted to the catalog*.

**Phasing note (per the Phase 1a plan, `2026-05-26-jit-phase-1a-bundle-contract-impl.md`):** the bundle *model* (a skill is a set of files) and the materialization *contract* (`files[]`) are foundational and ship in Phase 1a on a **DB files-table backing** — `SKILL.md` stays in `manifest_yaml`/`body_md`, extra files in `skills_v1_skill_files`. The **git-tree backing** is deferred to P5/P6 (share-to-catalog), its first consumer of SHA-based promotion. Because the *model* is bundle-native day one, swapping the byte-store later is internal — no contract migration.

**Sequencing — foundational.** Bundles are built into the skill model from the first slice (decision: *not* deferred). Storage, the materialization contract, and validation all handle file trees from the start, even though the earliest catalog skills are often single-file (a SKILL.md-only skill is just a one-file tree — instruction + declared hosts/creds + a body that drives `curl`/CLI). Building it bundle-native up front avoids a later migration off a text-column model. The vendored-`node`-as-MCP-server *use* of a bundle stays stdio-deferred (§9.1) — but the bundle *mechanism* is foundational.

## 10. Security model

This design touches sandbox boundaries, egress, credentials, and untrusted content. The `security-checklist` skill MUST run during implementation; the notes below are the starting threat model.

- **Credential trust path (invariant):** the in-chat credential field posts directly to the host credential store and is **never** routed through the model or written to the transcript. Stored encrypted, user-scoped, resolved to `ax-cred:` placeholder. Same posture as the existing destination form.
- **Card-as-backstop:** in open mode, agent-authored skills are gated by the user-facing host/credential card. Untrusted content steering the agent to author a malicious skill is contained because the user sees the declared hosts/creds before any spawn, and the skill is user-scoped (blast radius = self).
- **Trust-domain integrity:** vetted catalog bytes live read-only in `.ax/session/skills`; the writable `.ax/skills` copy is retired on admission (§6D). No path lets the agent edit vetted bytes.
- **Capabilities minimized:** acquisition grants exactly what the manifest declares — specific hosts, specific slots — never blanket egress. `proxy:add-host` grants a single host to a single session.
- **Mode default is conservative:** `allow_user_installed_skills` defaults off; agent-authoring is opt-in per deployment.

## 11. What this requires building

### Boundary review for new hooks (per CLAUDE.md)

- **`proxy:add-host`** (credential-proxy) — widen a running session's allowlist. *Alternate impl:* any egress gate (k8s NetworkPolicy patch, etc.). *Fields:* `{ sessionId, host }` — no backend-specific leak. *Subscriber risk:* low; additive. *IPC:* yes — schema lives in `@ax/credential-proxy`.
- **`skills:search-catalog`** (skills) — intent/keyword → candidate skill summaries `{ id, description, tier, hosts, slots }`. *Alternate impl:* keyword vs vector search; payload is impl-agnostic. *Subscriber risk:* none (read).
- **Per-user attachment hooks** (§11.2) — `skills:attach-for-user` / `skills:list-user-attachments`. *Alternate impl:* a join table or a JSON column. *Fields:* `{ userId, agentId, skillId, credentialBindings }`.
- **`catalog:submit` / `catalog:list-requests` / `catalog:admit`** (skills) — the admit queue. *Alternate impl:* a generic approval queue. *Fields:* `{ skillId, requestedBy, draftSkillMd }`.

### Components

1. **Broker tool** — an always-on host MCP tool (Inert, like `web_search`): `search_catalog` + `request_capability(skillId)`. `request_capability` drives the orchestrator's pause→card→approve→install flow.
2. **Per-user skill attachment** — *new storage.* Today `agents.skill_attachments` is agent-global and admin-only; self-serve needs a user-scoped layer so a user activates a catalog skill on their agent without affecting others. The orchestrator unions three sources — default-attached, agent-global, and **per-user** — with precedence **per-user > agent-global > default-attached** on id collision, and a user-scoped skill's *content* overriding a global skill of the same id (consistent with today's `skills:resolve(ownerUserId)` override behavior).
3. **Bundled approval card** — a chat-surfaced card (new SSE frame `chat:permission-request`, mirroring the `chat:turn-error → SSE` pattern from PR #137), with a secure credential field that bypasses the model and an "Approve/Not now" control.
4. **`proxy:add-host`** — live allowlist widening for the reactive-wall path.
5. **Pending-turn → re-spawn → resume** orchestration — hold the brokering turn, re-spawn on approval, `resume()`, answer the pending message; hide the synthetic continue (§7).
6. **Admit-to-catalog queue** — submit (cold-start *and* share-to-catalog), admin review/admit, promotion + working-copy retirement (§6D), dedupe.
7. **`allow_user_installed_skills`** deployment flag — preset + chart; read by orchestrator/broker to gate open mode.
8. **Skill bundles** (§9.2) — *foundational storage + contract change, built in the first slice.* Skills are stored as **content-addressed git trees** in the existing host-side git storage; a catalog row is `{ skillId, scope, version, treeSha }` + a parsed SKILL.md index. The sandbox materialization contract carries a **tree**, not an inline `skillMd` string — and the current `AX_INSTALLED_SKILLS_JSON` env-var inlining doesn't scale to trees, so the plan must choose between extracting host-side vs. having the runner **fetch-by-SHA over the git wire it already speaks**. Host-side validation + runner-side re-validation of paths/modes/caps/veto-list at the **extract** boundary (git can store symlinks + exec bits); read-only tree materialization; an admit-time file/diff view.

## 12. Derived pieces (designed in Part II)

These were the deferred set; they are now designed in **Part II** of this doc:

- **Smart defaults** — what a fresh agent ships with (e.g. default Inert skills, web tools, memory) so the common path needs zero card.
- **Settings mirror** — the out-of-band home: a per-user "Connections" view (your installed catalog skills, host grants, credentials) and the admin "Catalog" view — the same controls the in-chat cards write, reachable intentionally.
- **Admin experience** — catalog management, the admit-request queue UI (Needs-Input-lane shape), the mode toggle.

## 13. Error handling

- **Cold-start, curated mode** — broker finds no catalog hit → files an admit-request (deduped) → "I've asked your admin to add Linear; I'll be able to do this once it's approved." Not an error.
- **User declines the card** — agent proceeds without the capability and says what it therefore can't do. Graceful.
- **Invalid credential** — card shows inline validation (reuse provider key-validation where the destination supports it).
- **Re-spawn failure** — surface via the existing `chat:turn-error` → SSE path; the conversation is not lost.

## 14. Testing

- **Bug-fix-test policy applies** (CLAUDE.md): any bug found gets a regression test before the fix is done.
- **Canary e2e** (extend `skills/src/__tests__/e2e/skill-install.canary.test.ts`):
  - broker → card → approve → re-spawn → resume answers the *original* message (happy path);
  - reactive-wall live grant (no re-spawn) + retry;
  - open-mode authoring gated by the card;
  - share-to-catalog promotion: verify the workspace copy is retired and no duplicate-id collision occurs.
- **Manual acceptance** on the kind cluster (Playwright via `k8s-acceptance-loop`): the Linear-style flow end to end, plus the decline and invalid-key paths.

---

# Part II — Derived pieces (the out-of-band mirror)

**Principle:** settings is the *mirror* of the cards, not a parallel system — every capability the spine grants has exactly one home where you see, manage, and revoke it (invariants #4 and #6). The cards are the *just-in-time* face; settings is the *deliberate* face of the same records.

## P1. Scope of a user's capabilities

- **Skills (which are active) and host-grants are per-`(user, agent)`** — a research agent and a coding agent do different jobs.
- **Credentials are user-scoped and shared** — entered once, reused across all the user's agents and every skill that needs the same service.

So a user's world is two-level: a per-agent *"what this agent can do"* plus a shared *"my keys"* vault.

## P2. Credential vault — service-keyed

A credential slot in the manifest gains an optional **`account`** tag (e.g. `account: linear`). The vault holds **one entry per service** for the user; any skill whose slot declares `account: linear` binds to that entry automatically. Backward-compatible: a slot with **no** `account` keeps today's per-skill behavior (`skill:<id>:<slot>`).

Effects:
- The bundled card (§6A) checks the vault first: a Linear key already there → *"use your existing Linear key"* (one tap, no re-entry); otherwise prompt once and store it under `account: linear`.
- Revoking a vault entry pulls the credential out from under every skill that referenced it (surfaced via the "used by" hint).

## P3. The user's home — "Connections"

Promote user settings from the `UserMenu` modals to a **real user-facing Settings surface** that reuses the `AdminShell` shadcn chrome; admins simply see *additional* tabs. (Not a third modal dialect — invariant #6. Alternatives — a bigger modal, an in-chat side panel — don't scale to the two-level structure.)

```
┌─ Settings ─────────────────────────────────────────────┐
│  Connections   Keys   [Routines]        (admin: Catalog…)│
├─────────────────────────────────────────────────────────┤
│  CONNECTIONS                          Agent: [Research ▾] │
│                                                           │
│  What this agent can do                                   │
│   ● Web search          default        (on, can't remove) │
│   ● Memory              default                           │
│   ● Linear              you · 2d ago         [Remove]     │
│                                                           │
│  Allowed sites (this agent)                               │
│   • status.example.com   always · 5d ago     [Revoke]     │
│                                                           │
│  ───────────────────────────────────────────────────     │
│  MY KEYS  (shared across all your agents)                 │
│   🔑 Linear      ●●●●●●  used by: Linear        [Replace] │
│   🔑 GitHub      — not set —                     [Add]    │
└─────────────────────────────────────────────────────────┘
```

- **Per-agent** ("what this agent can do"): active skills (defaults marked + locked; user-added removable) and the always-allow **host grants**, with an agent switcher. Per-`(user, agent)`.
- **Shared "My Keys"** vault: service-keyed credentials with a "used by" hint — the out-of-band twin of the card's key field.

## P4. Smart defaults — how they surface

The first-party baseline (broker, web search/extract, memory, the wizard's default model) appears in every agent's skill list **marked `default` and locked** — the floor, not removable. Admin **org defaults** (the existing `default_attached` machinery, extended) also render as `default`. A user's own in-chat installs stack above, per-agent and removable. "Default" is an honest, visible label; the only things a user manages are the things *they* added.

## P5. Admin experience

- **Catalog** (reframe the existing admin "Skills" tab): browse + version skills, the read-only **bundle file-view** (§9.2 tree), admit-from-source, mark **org defaults**, show each skill's tier. This is the set the broker proposes from.
- **Admit queue** (new admin inbox, Needs-Input-lane shape): cold-start *"a user needed X"* requests **and** share-to-catalog submissions land here. Review = **read the bundle** (file/diff view — admit now means code review, §9.2) → **Admit** (promote + retire the author's working copy, §6D) / **Reject**. Dedup on skill id.
- **Mode toggle:** `allow_user_installed_skills`, a plain deployment setting (off by default).

## P6. The mirror property

Every card action has exactly one settings home; revoke works from either side (invariant #4 — card and settings row read/write the *same* record):

| In-chat card | settings home | revoke from |
|---|---|---|
| Connect a skill | agent's skill list | either |
| Enter a key | My Keys vault | either |
| Allow a host ("always") | agent's allowed sites | either |
| Submit to catalog | admin Admit queue | — |

## P7. Build additions (beyond §11)

1. **User Settings surface** in `channel-web` — reuse the `AdminShell` chrome; new `Connections` + `Keys` tabs, with admin-only tabs gated as today.
2. **Manifest `account` tag** + a **service-keyed credential vault** (`account:<service>` destination alongside `skill:<id>:<slot>`) + the card's "use existing key" lookup.
3. **Per-`(user, agent)` host-grant store** (the persistent "always-allow" list) loaded into the allowlist at session open + a revoke path — complements the live `proxy:add-host` (§11.4).
4. **Catalog tab** (extend the Skills tab) + the **Admit queue** (the `catalog:submit`/`list-requests`/`admit` hooks named in §11) with a bundle file/diff view.
5. **Org-default editing** layered on `default_attached`.

## P8. Testing (derived)

- **Canary/e2e:** a card grant appears in the right settings home and revoking *there* propagates (the mirror property); a second skill declaring the same `account` reuses the vaulted key with no re-prompt; an admit approve promotes + retires the working copy.
- **Manual acceptance:** connect a skill in chat → see it under Connections → revoke → confirm the next turn no longer has it.

---

## Appendix — decisions log (for traceability)

1. Anchor = the just-in-time spine.
2. Policy = tiered + self-healing curated catalog (default) / open self-serve via `allow_user_installed_skills`.
3. Approval point = self-healing catalog (catalog admission *is* the approval).
4. Surfacing = model-brokered + reactive egress walls.
5. Bundling = manifest-derived single card.
6. Re-spawn = host-grant live; skill-install re-spawns; seamless feel on Opt-2 plumbing.
7. Catalog source = first-party set + admin additions (default); agent-authored in open mode; share-to-catalog feeds it.
8. On-disk = `.ax/skills` (RW, authored) vs `.ax/session/skills` (RO, catalog); promotion is a cross-domain move with working-copy retirement.
9. stdio MCP out of MVP broker; http MCP in.
10. Catalog skills carry **bundles** (file trees), not just SKILL.md — **foundational** (bundle-native from the first slice), stored **content-addressed as git trees** (integrity via tree SHA, free dedup/versioning, drift-free promotion), materialized read-only + path-safe + no-exec-bit + veto-listed at the extract boundary.

### Part II (derived)

11. Settings is the **mirror** of the cards — one source of truth, one design language (invariants #4/#6).
12. Scope: **skills + host-grants per-`(user, agent)`; credentials user-scoped + shared**.
13. Credential vault is **service-keyed** via an optional manifest **`account`** tag; backward-compatible (no tag = today's per-skill behavior).
14. Smart defaults = a **first-party baseline** (broker, web, memory, model) + admin org-defaults, surfaced **marked + locked** in each agent.
15. User settings **promoted to a real surface** (reusing `AdminShell` chrome), not modals.
16. Admin gets a **Catalog** (reframed Skills tab) + an **Admit queue** (Needs-Input shape, bundle code review) + the **`allow_user_installed_skills`** toggle.
