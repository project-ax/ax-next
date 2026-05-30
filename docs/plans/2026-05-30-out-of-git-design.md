# Everything out of git — transcripts, blobs, and skills onto DB + a content-addressed store

**Status:** Proposed (needs human sign-off before any code moves — Part C reworks a subsystem merged days ago)
**Date:** 2026-05-30
**Author:** Vinay (with Claude)
**Related:**
- `2026-05-24-current-architecture.md` (host/runner split, transcript source-of-truth, workspace contract)
- `2026-05-01-workspace-redesign-design.md` (three-tier git topology this walks back)
- `2026-04-29-runner-owned-sessions-design.md` (runner-native transcripts — Phase D/E partially reverted here)
- `2026-05-15-attachments-and-artifacts-design.md` (LFS-backed attachments re-homed here)
- `2026-05-22-conversations-get-latency-rootcause.md`, `2026-05-19-conversations-get-zero-turns-investigation.md`, `2026-05-23-chat-transcript-loss-fix-impl.md` (the incident record this addresses)
- `2026-05-29-skill-authoring-lazy-redesign-design.md` (the lazy redesign Part C adjusts — keeps most of it, swaps the substrate and tightens the gate)
- `2026-05-29-skill-authoring-phase-3-bundle-projection-design.md` (the workspace-draft projection Part C replaces)
- `2026-05-29-skill-authoring-phase-4-lazy-approval-design.md` (the reactive cap approval Part C re-times to before-materialize)
- `2026-05-27-agent-authored-skills-skill-creator-design.md` (authored-skills flow)
- `2026-05-26-just-in-time-capabilities-design.md` (JIT caps, approval-card SSE frame, reactive egress wall)
**Supersedes (in part):** the "transcript lives in the committed jsonl" rule (current-arch §5); the LFS-backed-attachments storage decision (attachments design §Storage); the "skill drafts live in committed `.ax/draft-skills/`" decision (phase-3 projection); the lazy *reactive-at-the-wall* capability approval timing (phase-4).

> **Note:** this doc merges and supersedes two same-day drafts — `2026-05-30-storage-out-of-git-design.md` (transcripts + blobs) and `2026-05-30-skills-out-of-git-design.md` (skills). They told one story across two files; this is the single source.

---

## TL;DR

Git is the source of truth for four things it's a poor fit for: the **conversation transcript** (an append-only, single-writer event log), **attachments** (opaque inbound blobs), **agent artifacts** (opaque outbound blobs), and **skills** (opaque, content-addressed bundles). The data that genuinely wants git — real project code — already bypasses the ax git pipeline (agents clone external repos into `/ephemeral`). That inversion is why chat throws errors on most turns, and why "author a Linear skill and run it" stays expensive.

This proposal moves all four off git, onto two substrates:

- a **DB** (Postgres rows) for structured/append-only state — the display event log, the resume transcript, skill rows, attachment/artifact metadata; and
- a content-addressed **`blob:*` store** for opaque bytes — attachments, artifacts, and skill bundles.

Concretely:

1. **A content-addressed `blob:*` store** (Part A) — `fs` (dev / single-replica) and `s3` (prod) backends. The shared substrate everything else lands on.
2. **Transcript out of git** (Part B) — split the one over-loaded jsonl into a **display event log** (redisplay SoT) and a **resume jsonl** stored as opaque rows (resume SoT). (Largely reverts Phase D/E.)
3. **Attachments & artifacts onto the blob store** (Part C) + a `/ephemeral` working tier — they leave git entirely.
4. **Skills onto DB + blob** (Part D) — author into `/ephemeral`, propose over IPC, store as rows + a blob, with a **hybrid materialization gate** (free for self-authored zero-cap instruction skills; approve-before-materialize for anything with reach or outside authorship).
5. **Delete the half-wired git-LFS layer** (Part E) and promote its content-addressed store to the `fs` blob backend.

Net: git stops being load-bearing on every chat turn. It survives only as an **opt-in** backend for the rare versioned-project workload, plus small identity state. The trust boundary (sandbox edge, credential proxy, IPC validation, skill `pre-apply` veto, capability approval, egress wall) is untouched or *tightened* — this is removing premature/over-applied machinery, not conceding security.

---

## The problem

### The inversion

| Data | Wants git? | Today |
|---|---|---|
| Conversation transcript (`.claude/projects/*/<sid>.jsonl`) | No — append-only, one writer per session, no merge | Committed + bundled + pushed **every turn** |
| Attachments (inbound) | No — opaque blob, keyed by conversation | `attachments:commit` → `workspace:apply` (git), shares the chat mirror |
| Artifacts (outbound) | No — opaque blob the user downloads | Written to `/permanent`, swept by `git add -A`, durable only at turn-end commit |
| Skills (bundles + drafts) | No — opaque, content-addressed, last-write-wins | Drafts in committed `/permanent/.ax/draft-skills/`; bundle bytes in an isomorphic-git tree (TASK-40) |
| User project code | **Yes** — diff/branch/merge | Cloned into `/ephemeral`, **outside** the ax git pipeline |

Git provides versioning, branching, merge, and content-addressed integrity. The transcript, the blobs, and the skill bundles need none of those; the project code needs all of them and doesn't use ours.

### The incident record (transcript/blob symptoms of the same root cause)

- **Multi-minute reply latency.** `conversations:get` is "always exactly one assistant-turn behind until the session is reaped" because a reply becomes durable only on the *next* turn's `git add -A` or idle-reap (`2026-05-22`). Worked around with a jsonl-polling `waitForTurnTranscript`.
- **Zero-turns.** The SDK wrote the jsonl outside the workspace root (`CLAUDE_CONFIG_DIR` vs `HOME`), so `git add -A` never saw it (`2026-05-19`). Worked around with a filesystem symlink (`scaffoldSdkProjectsSymlink`).
- **Transcript loss / stuck retry loop.** `attachments:commit` advances the shared mirror out-of-band → the runner's `commit-notify` hits `parent-mismatch` → 500 → infinite retry on a stale parent → turns lost (`2026-05-23`). Fixed with a fetch-and-rebase resync loop on both commit sites and both backends.
- **Resume hard-crash** ("No conversation found with session ID") when the committed transcript ends mid-tool-result; guarded by F2a (`hasResumableTranscript`).
- **Tri-party deterministic-OID coupling.** Three packages must pin byte-identical commit identity + epoch dates (`workspace-git-core` `BASELINE_ENV`, `ipc-core` `HOST_GIT_DETERMINISTIC_ENV`, the `workspace-git-server` client) or CAS breaks and turns get rejected.
- **git-lfs missing-binary** breaks ~25 runner tests locally (`mistakes.md` 2026-05-25).

None of these serve a feature. They exist to make git behave like an append-only log and a blob store.

### The skills tax (a parallel symptom)

The lazy redesign (2026-05-29) fixed the *transaction* problem — it split `install_authored_skill`'s six fused concerns so a failing sub-step no longer `git reset --hard`s the agent's work. But because the blob/`ephemeral` substrate didn't exist yet, it left three structural issues:

1. **Skills are split-brained.** Catalog/default/attached skills are DB rows; agent-authored *drafts* are a git workspace (`/permanent/.ax/draft-skills/<id>/`, projected via `workspace:list`/`workspace:read`); the capability bundle bytes are a *third* place — an isomorphic-git tree (TASK-40). Two-plus stores for one concept (I4). A skill bundle is an opaque, content-addressed unit, last-write-wins per draft — exactly like an artifact. It doesn't want git.
2. **The git path is back on the hot loop.** Projecting a draft rides the workspace-git pipeline (commit → bundle → host mirror → re-project) — the very thing Part B removes from every *other* turn. Skills authoring becomes the **last reason** the deterministic-OID coupling and the per-turn commit exist.
3. **The cap gate fires late.** Phase 4 approves capabilities *reactively* — the skill materializes, runs, hits the egress wall, and *then* the human sees a card. Fine for *undeclared* reach, but for a skill that declares `hosts: [api.linear.app]` + a credential up front, the risky bytes are already projected and running before anyone consented.

---

## Part A — A content-addressed blob store (`blob:*`)

The shared substrate. A storage-agnostic service hook, one registrar per deployment, mirroring the `storage-sqlite` / `storage-postgres` split:

```
blob:put(ctx, { bytes }) → { sha256, size }            // content-addressed; idempotent on identical bytes
blob:get(ctx, { sha256 }) → { bytes } | { found:false } // streamed
blob:stat(ctx, { sha256 }) → { size } | { found:false }
blob:delete(ctx, { sha256 }) → {}                      // GC; safe only when unreferenced
```

Payloads carry only `sha256` / `bytes` / `size` — no backend vocabulary (no `bucket`, `oid`, `lfs`, `pack`). Bytes ride the `callBinary` octet-stream channel, never the 4 MiB JSON frame.

**Backends:**
- **`@ax/blob-store-fs`** — content-addressed files at `<root>/<sha[0:2]>/<sha[2:4]>/<sha>`. This is `workspace-git-server/src/server/lfs.ts` with the git/LFS protocol framing removed: it already does sha256 addressing, streamed I/O, atomic temp-then-rename, and digest verification. Single-replica (RWO PVC), zero new dependencies, cheapest possible. **The simplest first step.**
- **`@ax/blob-store-s3`** — `@aws-sdk/client-s3`. One implementation targets MinIO (self-host + dev parity in kind), GCS (S3-compatible endpoint, the likely GKE prod home, with Workload Identity = no static keys), AWS S3, R2, etc. Multi-replica-safe. Unlocks presigned direct browser↔bucket transfer later.

Recommendation: ship `fs` + `s3`; run MinIO in kind for dev/test; point `s3` at GCS+Workload-Identity in prod. At chat scale the storage bill is pennies — "cheap" here is about ops, and managed object storage has the lowest TCO.

---

## Part B — Transcript out of git → DB (reverts Phase D/E)

Today the SDK's per-session jsonl (`.claude/projects/*/<sid>.jsonl`) is the **single** source of truth: it's committed to git every turn, and `conversations:get` reconstructs the displayed history by parsing it (`parseJsonlToTurns`). That one artifact is being asked to serve two jobs with different requirements, and that conflation is the awkwardness. Split it:

| Concern | Needs | Source of truth |
|---|---|---|
| **Redisplay** an old chat perfectly | tool calls, errors, approval cards, artifact chips, cold-start narration, skill notices — incl. **host-generated UI events the SDK never sees** | **display event log** (host-owned DB rows) |
| **Resume** + reuse warm KV cache | byte-exact SDK transcript incl. bookkeeping (`queue-operation`, `last-prompt`, `skill_listing`) | **the SDK jsonl** (verbatim, DB rows) |

These are different shapes. Neither is derived from the other: the jsonl is lossy for display (no host UI events), the display log is lossy for resume (no SDK bookkeeping). This is *better* on I4, not worse — **display** has one SoT and **resume** has one SoT; they don't overlap. The model/tool *content* appears in both (two serializations of the same turn), with clear authority: the jsonl is authoritative for **what the model saw**, the event log for **what the user saw**. On divergence, neither is "fixed" from the other — divergence is a bug.

### B1. Display event log (the redisplay SoT)

Don't reconstruct the display by re-parsing the jsonl. Persist **the exact ordered stream of UI events the host already emits to the browser over SSE** — turn deltas, tool-call frames, permission/approval cards, surfaced provider/sandbox errors, artifact-published frames, cold-start narration. Three reasons:

1. **The jsonl is missing half the UI.** Approval cards, surfaced errors, artifact chips, narration, "skill installed" notices are *host/orchestrator* events — not in the SDK transcript. Redisplay from the jsonl drops them on reload.
2. **Reload == live, by construction.** The live chat is a fold over the SSE stream; replaying the *same* persisted frames through the *same* renderer makes an old chat identical to a live one — guaranteed, not hand-maintained. One render path, exercised both ways.
3. **It decouples display from the SDK's internal format**, which carries display-noise bookkeeping and can shift across SDK versions.

The runner **already ships this stream**: `event.stream-chunk` live (`main.ts` assistant/user branches) and `event.turn-end` at the `result` boundary (`main.ts:1304,1344`), carrying the turn's `ContentBlock[]`. The only change is host-side: **persist** those frames (append-only rows, `(conversationId, seq)`) instead of only fanning them out. `conversations:get` becomes "read the event log," not "parse the jsonl." Interactive widgets fold to terminal state naturally — a card's later "approved, granted X" frame is just a subsequent event; replay reproduces the resolved card with no special final-state bookkeeping. `reconstructAttachmentBlocks` stays (untrusted-input hardening).

### B2. Resume jsonl (the resume SoT) — opaque rows, not a blob

The jsonl stays the resume artifact, but **out of git** and stored as **opaque rows, one per jsonl line** — raw verbatim line text keyed by `(conversationId, seq)`. Rows (not a whole-file snapshot) so a new turn is a cheap append, not an O(n) rewrite that turns a long session into O(n²) total upload. Two guardrails make that safe:

- **Store raw line bytes, never parsed-then-reserialized JSON.** Re-serialization can shift key order / number formatting / unicode escaping; the resume artifact must round-trip faithfully. Reconstruction is a pure `ORDER BY seq` → join with `\n`. "Opaque" is preserved *inside* a row layout — we never interpret the contents.
- **Append-mostly, with a prefix-hash guard.** The SDK jsonl is append-*mostly*, not guaranteed strictly byte-append-only — it can compact when context grows or update singleton entries (`last-prompt`) in place. Naive tail-only INSERT would silently diverge on a rewrite. So the runner ships the **delta** with an integrity check; mismatch → full resync.

**New host IPC actions:**

```
session.append-transcript(conversationId, fromSeq, prefixHash, lines[])
    → { outcome: 'appended' | 'resync-required', prefixHash }
session.replace-transcript(conversationId, jsonlBytes)   // callBinary; resync path only
```

**Runner lifecycle** (replaces `commitTurnAndBundle` at the `result` boundary, `main.ts:1218`):

1. **Keep** the existing `waitForTranscriptUuid` wait (`main.ts:1204`) — it blocks until the turn's *final* assistant line lands on disk (the SDK flushes it after yielding `result`). Without it we'd append rows missing the closing reply — the exact TASK-11 bug.
2. Read the jsonl tail (reuse `locateJsonl`) past a **threaded byte offset** `sentOffset`, split into complete lines (hold back any trailing partial), and ship them via `session.append-transcript` with `prefixHash` = hash of bytes `[0..sentOffset)`.
3. **Append path** (`prefixHash` matches host state): INSERT the new lines. O(1) per turn, tiny payload. The common case.
4. **Resync path** (`outcome: 'resync-required'` — the SDK rewrote earlier bytes): re-ship the whole file once via `session.replace-transcript`. Rare, self-healing, never silent corruption.
5. Advance the runner-local `sentOffset` / `sentSeq` / `prefixHash` — threaded across turns exactly like `parentVersion` is today (`main.ts:385`).

`sentOffset`/`sentSeq` start at `0` on a fresh session, or at the host's `max(seq)` on resume. A final flush fires at chat-end / idle (where the final commit sits today, `main.ts:1375`).

**No concurrency hazard.** The `parent-mismatch` bug came from the git *mirror* advancing out-of-band, not from appends. The transcript has a **single writer per session** (that session's runner); `(conversationId, seq)` with a monotonic seq is contention-free. This is *not* the git CAS reborn.

**Resume** hands the rows back: host joins `ORDER BY seq` → bytes → the resuming runner writes them into `$CLAUDE_CONFIG_DIR/projects/...` before `query({ resume })`. The F2a "is there a resumable transcript?" guard becomes a DB check (`max(seq) > 0`) — cheaper and more reliable than scanning a file that might be missing. The conversation→session bind stays gated on host-confirmed durability: bind after `append-transcript` succeeds (today: after the commit is `accepted`, `main.ts:1246`), so a turn killed before durability never leaves a stale resume pointer.

Together B1+B2 delete, for the common chat path: the per-turn commit, bundle, push, host-mirror fetch, the `parent-mismatch` CAS, the rebase-resync loop, the deterministic-OID tri-party coupling, and the latency. We had a `conversation_turns` table before Phase E deleted it; B2 is largely that store, fed by a raw-line delta instead of git.

> **KV-cache horizon.** Restoring the exact jsonl gives **resume correctness always** (any age) and **warm prompt-cache reuse only while warm** — Anthropic's server-side prompt cache is TTL-bounded (minutes), so a fresh pod replaying the identical prefix hits it for a *recently active* chat and pays full prefill for an old one. Cache reuse is a free bonus of the same mechanism, not a reason the jsonl must persist forever. The jsonl persists for resume correctness.

> **Don't reconstruct the jsonl from the display log.** They're complementary and each authoritative for its own job — see the table above. Store the jsonl lines verbatim; never synthesize them from parsed turns.

---

## Part C — Attachments & artifacts on the blob store; `/ephemeral` working tier

Large files move in two directions; both land in the **same** blob store, and **neither touches git**.

**Attachments: where they live, before vs. after.** (Same story for artifacts, mirrored.)

| | Today | After |
|---|---|---|
| **Durable home** | a git blob in `/permanent`'s history (committed via `attachments:commit` → `workspace:apply`) — *not* actually an LFS object, see Part E | a sha256 object in the `blob:*` store (`fs` PVC / S3·GCS) |
| **Sandbox-visible copy** | the committed file in `/permanent`, on the shared chat mirror | a read-only working copy in `/ephemeral/uploads/`, materialized at session start from `blob:get` |
| **Metadata** | (implicit in the git tree path) | an `attachments` row `{conversationId, sha256, displayName, mediaType, size}` |
| **Write path** | rides the per-turn commit/bundle → shares the mirror → `parent-mismatch` race | host-side `blob:put` on `POST /api/attachments`, before any sandbox exists |
| **Download** | served out of the git mirror | `GET /api/files` → ACL → row → `blob:get` → stream |
| **De-dup / integrity** | none (raw bytes per commit) | content-addressed: identical bytes stored once, digest-verified on read |

The headline: attachments leave git **entirely**. And the "LFS" they're nominally leaving was never load-bearing — uploads are committed as raw git blobs today, *not* LFS objects (Part E), so this removes dead machinery rather than migrating live LFS data.

The sandbox already has the right mount (`pod-spec.ts:461`, subprocess `open-session.ts:264`): `/permanent` is git-tracked; **`/ephemeral`** is `emptyDir` scratch that `git add -A` (run in `/permanent`) never sees, and the runner already uses it (`env.ephemeralRoot`, the Python venv).

**Outbound (artifacts).** Re-point the `artifact_publish` namespace from `/permanent/.ax/artifacts/**` to **`/ephemeral/artifacts/**`**:
1. Model generates the deliverable into `/ephemeral/artifacts/report.pdf`.
2. Model calls `artifact_publish(path)`. The runner-side executor already does `lstat` → size cap → read → **sha256**; it now streams the bytes to `blob:put` and the host inserts an artifact row `{conversationId, sha256, displayName, mediaType, size}`, returning `ax://artifact/<id>`.
3. The ephemeral copy dies with the pod — the durable copy is the blob.

Durability now begins **exactly at `artifact_publish` return** (a `blob:put` success), not at the fuzzy turn-end commit. The tool description flips from "the workspace commit at turn end captures it" to "the bytes are stored durably on publish; nothing is committed."

**Inbound (uploads).** Store the uploaded bytes directly via `blob:put` (host-side; the browser already proxies through the host on `POST /api/attachments`). The durable home is the blob; the sandbox only needs a *readable working copy*, so materialize uploads into **`/ephemeral/uploads/`** at session start, not `/permanent`. `attachments:commit` → `workspace:apply` (git) goes away; with it goes the shared-mirror `parent-mismatch` race entirely.

**Download** (`GET /api/files`) keeps its ACL (conversation ownership + path/transcript scope) and resolves `artifactId/attachmentId → row → blob:get → stream`.

---

## Part D — Skills onto DB + blob; the hybrid materialization gate

Skills are the last opaque-blob class still in git. They move onto the *same* DB + blob substrate, finishing the unification: **one store for all skills** (catalog, default, user-attached, authored) instead of today's DB-for-most / git-for-drafts / git-tree-for-bundles split.

### D1. Authoring goes to `/ephemeral`; the agent proposes over IPC

1. The agent writes the bundle into **`/ephemeral/skill-draft/<id>/`** (`SKILL.md`, extra files, a manifest declaring capability *proposals*). Throwaway scratch — `git add -A` never sees it (Part C), and a failed author leaves nothing to roll back.
2. The agent calls **`skill_propose(path)`**. The runner-side executor validates structurally (`parseSkillManifest`, `validateBundleFiles`, capability shape) — the same checks the broker does today — then streams the bundle bytes over IPC.

This replaces the "flush workspace → projection reads the committed draft" path (phase-3 Component 1) with a direct upload. The `validator-skill` `pre-apply` veto survives as a structural gate on `skill_propose` — it keyed off a *write chokepoint*, not git specifically, and `skill_propose` is that chokepoint now.

### D2. The host stores skills in DB + blob — the single source of truth

```
skill_propose(ctx, { manifest, files[], capabilityProposal, origin }) → { skillId, status }
```

The host:
- writes the bundle bytes to **`blob:put`** (Part A) — kills the TASK-40 git-tree backing,
- inserts/updates **one** skill row `{ skillId, manifest, capabilityProposal, blobSha, origin, status, scanVerdict, approvedCapabilities }`,
- returns a `skillId` + the resulting `status` (see the gate, D3).

This is the **same table** that already holds catalog / default / user-attached skills. Authored skills stop being a separate git-backed species — they're rows with `origin = 'authored'`. One source of truth (I4), one store to query for "what skills exist," one GC story (reference-counted blobs).

`origin` is known at the IPC boundary and drives the gate: `authored` (the agent composed this bundle), `imported` (a catalog/external pull), or `attached` (an admin/user action).

### D3. The hybrid materialization gate

Classified by the host at propose time, from two facts it already has — the capability proposal and `origin`:

```
clean scan  AND  origin = authored  AND  capabilityProposal = ∅
    → status = active           (materialize freely, no human)

otherwise (any capability, OR origin ∈ {imported, attached})
    → status = pending          (approve-before-materialize; nothing projects)

scan hit (any class)
    → status = quarantined      (omit from projection; reason returned to agent)
```

- **Free path** — self-authored instruction scaffolding (a commit-message style guide, a "how we structure tests" skill). No reach to consent to; the best-effort scan is the only check. Materializes into the `0555` dir on the next spawn. The residual risk (the agent freely activating instruction text it wrote itself) is exactly the posture the lazy redesign already accepted for this case.
- **Gated path** — anything with `hosts`/`credentials`/`mcp`/`packages`, or anything pulled from outside. The whole skill waits in `pending`; **no bytes project, no caps inject** until a human approves via the existing approval-card SSE frame (TASK-35). On approve, the host records the approved capability subset (`proposal ∩ approved`, unchanged from JIT) and flips to `active`.
- **Quarantine** stays host state (phase-2): a flagged bundle is simply omitted from the projection with a reason, never silently dropped.

This **moves the capability gate before first run** for the declared case, which is stricter *and* simpler than phase-4's reactive timing. The phase-4 reactive cap top-up is no longer needed for *declared* skill caps. The **runtime reactive egress wall (TASK-37) stays** — it now guards only *undeclared* reach (a skill that tries to hit a host it never proposed), which is its proper job as a runtime safety net, independent of skill approval.

### D4. Materialize via the existing projection — unchanged

`active` skills project into the read-only **`0555` `$CLAUDE_CONFIG_DIR/skills/`** dir at spawn, exactly as `materializeInstalledSkillsFromEnv` (`agent-claude-sdk-runner/src/installed-skills.ts`) does today — the host just feeds it from `blob:get` instead of a git projection. Capabilities (credentials, egress allowlist) inject at spawn from the approved set in the DB. Nothing about the projection, the immutability, or the credential injection changes; only the *source* of the bytes does.

### D5. The user-facing UX

The substrate is invisible to the user; the **gate** is what they feel, and it's proportional to risk. Two cases.

**Gated: "make me a Linear skill."** A Linear skill needs `api.linear.app` + `LINEAR_API_KEY` → gated → approve-before-materialize.

- **Turn 1 — user:** "Make me a skill for working with Linear issues."
- **Turn 1 — agent (visible, brief):** drafts into `/ephemeral/skill-draft/…`, calls `skill_propose`. The transcript shows light activity (*"Drafting `linear` skill…"*), then an **approval card** appears inline:

  > **🧩 New skill: `linear`** — proposed by the agent
  > Lets me create, read, and update Linear issues.
  > **Wants:** network access to `api.linear.app` · a credential `LINEAR_API_KEY` (not set)
  > **Instructions preview:** [expandable — the SKILL.md body]
  > `[Approve]` `[Approve & add key…]` `[Deny]`

  The agent's turn **ends here**, with a forward-pointing line: *"I've proposed a `linear` skill — approve it above and it'll be ready on your next message."*
- **The card — user approves & pastes the key.** The credential goes to the vault (never the bundle, blob, or git); the host flips the row to `active` and records the approved caps.
- **Turn 2 — user:** "Great, list my open issues." → fresh spawn projects the dir *with* `linear` in it, injects the credential, the agent invokes the skill and lists the issues.

From the user's seat this is a normal *ask → approve → use* exchange. The re-spawn is invisible — it's just "the thing I approved now works."

**Free: "make me a commit-message style skill."** Zero capability, self-authored → free. The user sees *"Added a `commit-style` skill"* and it's live next turn. **No card, no interruption.** The gate only appears when there's actual reach to consent to.

**Why the seam disappears:**
- **The card *is* the pause.** A capability skill already stops for human approval; the re-spawn boundary hides entirely behind a stop the user was making anyway. By the time they've read the card and pasted a key, the re-spawn cost is already spent.
- **Wording points forward** ("ready on your next message"), framing the boundary as anticipation, not latency. The anti-pattern — *"Skill installed. (You may need to start a new session.)"* — leaks the mechanism and reads like a bug.
- **A persistent "Skills" affordance** (a chip / list outside the transcript) shows the just-approved skill as installed, so next-turn activation isn't on faith.

### D6. The spawn-time-discovery constraint (state it loudly)

**Skills are discovered at spawn, not live.** Materializing a skill into the dir while the agent process is already running is invisible to the model, for two independent reasons:

1. **Awareness.** The model only knows a skill exists because its **name + description were injected into context at spawn**. Writing a new skill to disk mid-turn doesn't retroactively edit context the model already received — it can't see the skill to invoke it.
2. **Readability.** The skill dir is a **`0555` ephemeral projection set up at spawn**. Files the host writes after spawn may not even appear inside the running sandbox's view until the next spawn re-projects.

Both point the same way: skill visibility is a **spawn-time property**. We adopt **version (a): re-spawn on the next turn** — the host flips the row to `active`, and the user's next message runs in a fresh sandbox that projects *and* enumerates the new skill. No new machinery; it reuses the spawn path.

> **Build requirement.** The agent must *know* it's on the (a) boundary, so it words turn 1 correctly and doesn't try to invoke a skill it proposed this turn. A line of harness/system-prompt guidance: *"A skill you propose this turn becomes available next turn — propose it, tell the user it's ready on their next message, don't attempt to invoke it now."* Without this the agent may call the just-proposed skill, fail to find it, and get confused. (This is the pending-turn re-spawn orchestration from `2026-05-26-jit-pending-turn-re-spawn-resume-orchestration-impl.md`.)

**The one visible seam: "create *and* use" in one breath.** "Make a Linear skill **and** list my issues" can't complete in one turn — the skill isn't in context until re-spawn. The agent should **recognize the pattern and tee up the continuation** rather than silently dropping the second half: *"Here's the `linear` skill — once you approve it, say go and I'll pull your open issues right away."* Worst case degrades to **one extra message**, never to a broken request.

> **Deferred alternative — version (b), live injection.** Write into a *writable* live dir and push a `system-reminder` context frame into the running turn announcing the skill. Makes same-turn use work, but forks skill discovery into a second (live) path and gives up some of the `0555` immutability. Not worth it now. If we ever want true same-turn continuation, the cleaner form is "host triggers an immediate transparent re-spawn and replays the pending instruction" — which keeps a single discovery path. Start with (a).

---

## Part E — Delete the half-wired LFS layer

Findings (traced 2026-05-30):
- The LFS **server** is fully built and routed: `listener.ts:714-741` dispatches batch/storage/verify; `repos.ts:217` provisions `<workspaceId>.lfs/objects/` per workspace; `lfs.ts` is a complete sha256 store.
- **No client ever uses it.** No `.gitattributes` is created anywhere (the only repo hit is a *comment* at `git-workspace.ts:156`); no `git lfs track` / `filter=lfs`; no `git lfs push`. The default backend `@ax/workspace-git` → isomorphic-git has no LFS support and ignores `.gitattributes` filters. The runner's `git lfs install --local` installs filters that never fire.
- Consequence: today every upload/artifact is committed as a **raw full-byte git blob** held in isomorphic-git's memory, with no LFS/GC benefit — and the LFS server is dead weight (a CLAUDE.md "no half-wired plugins" violation).

Action: remove the LFS server/endpoints/provisioning and the runner's `git lfs install`; **promote `lfs.ts`'s content-addressed store to `@ax/blob-store-fs`** (Part A). Net change in surface: down.

> **Caveat to confirm before deleting:** verify against a running pod that nothing image-baked (a global `.gitattributes` or `git config` filter) tracks `.ax/**` — `git -C /permanent check-attr filter .ax/uploads/x` inside a sandbox. Production code says no; confirm the runtime agrees.

---

## What git keeps

After all five parts, `/permanent` (git) holds only small, versioned **agent state**: identity (`IDENTITY.md`/`SOUL.md`), and — for the rare Pattern A workload — actual ax-hosted project code under `/permanent/workspace/`. That last case is the one thing git is genuinely for; it may still publish a file as an artifact (an intentional double-home: git holds editable history, the blob holds the immutable shared snapshot).

Note this is *narrower* than the storage-draft's "what git keeps": skill drafts (`.ax/draft-skills/`) leave too (Part D), so identity + Pattern A is the whole list.

**Skill validation is unaffected.** The `validator-skill` veto and the `skills:upsert` structural checks key off a *write chokepoint*, not git specifically — that chokepoint is now `skill_propose` (Part D1). The capability-intersection model (`proposal ∩ approved`) and the egress/credential boundaries are entirely separate from storage.

---

## The new sandbox storage model

```
/permanent/                    ← git-tracked agent state (small, versioned)
  IDENTITY.md / SOUL.md         ← identity (validated)
  workspace/  (Pattern A only)  ← ax-hosted project code (the rare real git case)

/ephemeral/                    ← emptyDir scratch; git NEVER sees this
  artifacts/<file>              ← agent deliverables → blob:put on publish
  uploads/<conv>/<file>         ← user uploads, materialized from blob:get
  skill-draft/<id>/...          ← skill authoring scratch → skill_propose
  .venv/, caches/, code/        ← existing scratch (Python venv, cloned repos)

(durable homes, off-pod)
  Postgres   conversation_events     (display event log — append-only rows, the redisplay SoT)
             conversation_transcripts (resume jsonl — opaque rows, one per line, (conv,seq))
             skills                   (one row per skill: manifest, caps, blobSha, origin, status)
             attachments / artifacts metadata rows
  blob store sha256-addressed bytes  (attachments, artifacts, skill bundles; fs PVC dev / S3·GCS prod)
```

**One-line principle:** *git holds only small versioned agent state; every opaque blob (uploads in, artifacts out, skill bundles) lives in the blob store with `/ephemeral` as the disposable working copy, and every append-only log (transcript, display events) lives in Postgres. Git never touches a blob, and never carries the transcript or a skill.*

---

## How this lands the invariants

- **I1 (transport/storage-agnostic hooks).** Improved. `blob:*` carries `sha256`/`bytes`/`size`; `session.append-transcript` carries `conversationId`/`fromSeq`/`prefixHash`/opaque line strings; `skill_propose` carries `manifest`/`files`/`capabilityProposal`/`origin`. No `oid`/`bucket`/`lfs`/`commit`/`ref`/`tree`. Named alternate impls: `blob-store-fs` vs `blob-store-s3`; a Postgres row-per-line transcript store vs a blob-store transcript; a DB-row+blob skill store vs (today) git-workspace drafts.
- **I2 (no cross-plugin imports).** Unchanged. New plugins talk over the bus / IPC.
- **I3 (no half-wired plugins).** Improved — this *removes* two half-wired surfaces (the LFS server; the TASK-40 git-tree backing). Each part ships its producer + consumer + canary reachability in one PR.
- **I4 (one source of truth).** The big win, three places. Transcript splits cleanly into two non-overlapping SoTs (display log, resume rows), each with one writer (the runner). Blobs: content-addressed, one store. Skills: one DB+blob store for catalog/default/attached/authored — kills the draft-in-git / rows-in-DB / git-tree-bundle split-brain. Removes the transcript/attachments shared-mirror contention that caused the loss bug.
- **I5 (capabilities minimized).** Improved. The skill cap gate moves to **before first run** for declared caps — bytes don't project and credentials don't inject until a human consents; the runtime egress wall remains for undeclared reach; credentials never enter a bundle/blob/git. The common chat path no longer needs a `git`/`git-lfs` binary in the sandbox. S3+Workload-Identity removes static keys.
- **I6 (one UI language).** Unchanged — download/upload chips, the approval card, and the Skills affordance compose existing shadcn primitives.

---

## Boundary review (new hooks)

**`blob:put` / `blob:get` / `blob:stat` / `blob:delete`**
- *Alternate impl:* yes — `fs` (PVC) and `s3` (MinIO/GCS/AWS). The seam is real on day one.
- *Field names that might leak:* none. `sha256` is a content hash, not a backend id; `bytes`/`size` are generic. (Contrast LFS's `oid` + storage hrefs, which leaked git/LFS vocab.)
- *Subscriber risk:* none — service hook, no backend-specific field a consumer could key off.
- *Wire surface:* bytes ride `callBinary` octet-stream; the JSON envelope (`{sha256,size}`) is small and schema-validated in `@ax/ipc-protocol`.

**`session.append-transcript(conversationId, fromSeq, prefixHash, lines[])` / `session.replace-transcript(conversationId, jsonlBytes)`**
- *Alternate impl:* row-per-line in Postgres, a blob-store object, or (today) git — all behind the same action.
- *Field names that might leak:* none. `conversationId`/`fromSeq`/`prefixHash` are storage-neutral; the lines are opaque verbatim bytes. (`seq` is a per-conversation monotonic counter, not a git oid or commit.)
- *Subscriber risk:* the lines are an **untrusted, adversarial** SDK/model artifact — see security walk. No subscriber should execute or trust them; they're stored verbatim and only ever re-emitted to the SDK for resume, never interpreted.

**Display event log (persisting `event.turn-end` / `event.stream-chunk`)**
- *Alternate impl:* the host already routes these frames to live SSE clients; persisting them is an additive consumer. Storage backend is swappable behind the same `conversations:get` read.
- *Field names that might leak:* none — frames are UI-semantic (turn deltas, tool calls, cards, errors), already storage-agnostic.
- *Subscriber risk:* frames are untrusted model/host output; renderers sanitize (unchanged J2 hardening). The log is append-only; interactive widgets fold to terminal state via later frames, no mutable shared row.

**`skill_propose(ctx, { manifest, files[], capabilityProposal, origin }) → { skillId, status }`**
- *Alternate impl:* yes — DB-row + `blob:*` store (this proposal) vs the git-workspace draft store (today) vs a future remote skill registry. Real seam.
- *Field names that might leak:* none. `manifest`/`files`/`capabilityProposal` are skill-domain; `origin` is an enum of trust-provenance, not a backend id. Bundle bytes go to `blob:put` (whose `sha256` is a content hash, not a git oid).
- *Subscriber risk:* the bundle is **untrusted, adversarial** model output — see security walk. No subscriber executes it; the host structurally validates and scans before any projection.
- *Wire surface:* bytes ride `callBinary`; the JSON envelope is small and schema-validated in this plugin's directory (not a central file).

---

## Security walk (security-checklist)

This touches IPC actions, storage of untrusted content, plugin/skill loading, and a new dependency (`@aws-sdk/client-s3`) — the skill fires.

- **Sandbox escape / path traversal.** Blob keys are `sha256` (`^[a-f0-9]{64}$`, the existing `OID_REGEX`), never caller paths — no traversal. The `fs` backend keeps `lfs.ts`'s atomic temp-then-rename + digest re-verification (reject on mismatch). `artifact_publish` keeps `lstat` (reject symlinks) + size cap + path allowlist, now scoped to `/ephemeral/artifacts/**`. Skill authoring is confined to `/ephemeral/skill-draft/**`; `skill_propose` validates the manifest + file set structurally (`validateBundleFiles`) and the `pre-apply` veto still runs at that chokepoint; projection stays **read-only `0555`** so the agent can't mutate a live skill. Removing `git`/`git-lfs` from the common sandbox path *shrinks* the escape surface.
- **Prompt injection.** The transcript jsonl, any uploaded/published file, and skill bundles are untrusted model/user output. They are stored as opaque bytes and **never executed or shell-interpolated**. For the transcript, the display path whitelists `user`/`assistant`/`tool` and `reconstructAttachmentBlocks` re-validates against the conversation's own upload prefix + schema (unchanged hardening). For skills, the **best-effort scan** runs before materialization (hit → quarantine), and the **hybrid gate** is the core control: nothing with reach projects without a human approving the *specific* hosts/credentials shown on the card; the free path is restricted to `origin = authored ∧ capabilityProposal = ∅`. A published artifact's `displayName`/`mediaType` and any skill `SKILL.md` are treated as untrusted text by any renderer; `SKILL.md` is never shell-interpolated.
- **Supply chain.** `@aws-sdk/client-s3` is the one new dependency (modular, version-pinned); run `pnpm audit` on the pinned range. The `fs` backend adds nothing. For skills, `origin ∈ {imported, attached}` is **always gated**, even at zero capability — an externally-authored bundle gets a human provenance check before it can run. S3 auth uses Workload Identity / IRSA (no static keys in the tree); MinIO access keys and all skill credentials live in the credential vault, injected at spawn, never in env, code, a bundle, a blob, or git.

---

## Migration / phasing

Each phase leaves the tree green and is independently reviewable. Parts B/C/D all depend on Part A (the blob store) landing first.

1. **Phase 1 — blob store (additive).** Ship `@ax/blob-store-fs` (lift `lfs.ts`) + the `blob:*` hook + `@ax/ipc-protocol` wire + `callBinary` plumbing. No consumer yet beyond tests + canary. *(I3: wire a trivial real caller or land with a consumer phase — don't merge it dangling.)*
2. **Phase 2 — transcript out of git.** Two halves. **2a (display):** persist the `event.turn-end`/`event.stream-chunk` frames the host already receives into a `conversation_events` log; switch `conversations:get` to read it (no jsonl parse). **2b (resume):** add `session.append-transcript`/`replace-transcript` + the row-per-line `conversation_transcripts` store; replace `commitTurnAndBundle` at the `result` boundary with the delta-ship (keeping `waitForTranscriptUuid`); switch resume to rebuild the jsonl from rows; F2a guard becomes `max(seq) > 0`. **Biggest robustness win** — re-walk the latency + concurrent-writer + resume scenarios on `ax-next-dev`.
3. **Phase 3 — artifacts/uploads onto the blob store + `/ephemeral`.** Re-point `artifact_publish` to `/ephemeral/artifacts/**` + `blob:put`; route uploads through `blob:put` and materialize into `/ephemeral/uploads/`; download resolves via `blob:get`. Drop `attachments:commit → workspace:apply`.
4. **Phase 4 — skills onto DB + blob.** Add `skill_propose` + the runner-side executor + the host store (skill row + `blob:put`); classify at propose time (scan + `origin` + caps) and wire `pending` → approval-card → `active` (the hybrid gate, re-timing the phase-4 reactive cap approval to before-materialize); feed `materializeInstalledSkillsFromEnv` from `blob:get`; retire the `.ax/draft-skills/` authoring dir + workspace-draft projection; delete the TASK-40 git-tree bundle backing. Keep the TASK-37 egress wall for undeclared reach.
5. **Phase 5 — delete LFS + thin the git pipeline.** Remove the LFS server/endpoints/provisioning + runner `git lfs install` (after the runtime `check-attr` confirmation). With transcripts, blobs, and skills gone, the per-turn commit/bundle fires only when `/permanent` agent state actually changed (rare) — gate it on a non-empty diff (identity + Pattern A only).
6. **Phase 6 — `@ax/blob-store-s3` + MinIO/GCS wiring.** Add the S3 backend, MinIO in kind, GCS+Workload-Identity in the prod chart. Optional: presigned direct browser↔bucket transfer.

A genuine multi-replica future (ARCH-9) gets simpler: blobs are in object storage and the transcript + skills are in Postgres — all already multi-writer-safe — instead of a sharded git tier.

---

## What gets deleted / simplified (concrete)

- **Deleted (LFS):** LFS server (`workspace-git-server/src/server/lfs.ts`), its routes (`listener.ts:714-741`), per-workspace `.lfs` provisioning (`repos.ts:217,341`), runner `git lfs install --local` (`git-workspace.ts:158`).
- **Deleted (skills):** the TASK-40 isomorphic-git bundle-tree backing (`2026-05-26-jit-bundle-git-tree-backing-byte-store-swap-impl.md`); the `/permanent/.ax/draft-skills/` authoring dir + the workspace-draft projection source (phase-3 Component 1, `workspace:list`/`workspace:read` for drafts).
- **Deleted/retired (common chat path):** `attachments:commit → workspace:apply`; the transcript read via `workspace:list`/`workspace:read` (`conversations/src/plugin.ts:888`); the per-turn jsonl commit/bundle dependency and its `parent-mismatch` resync (`commit-notify-resync.ts`, `resyncBaselineAndReplay`); the `scaffoldSdkProjectsSymlink` workaround once the jsonl no longer needs to live in `/permanent`.
- **Re-timed (skills):** phase-4 reactive capability approval → approve-before-materialize for declared caps. The approval-card SSE frame (TASK-35) and the `proposal ∩ approved` store **survive**; only the trigger/timing changes.
- **Simplified:** the tri-party deterministic-OID coupling (`BASELINE_ENV` / `HOST_GIT_DETERMINISTIC_ENV` / server client) shrinks to whatever still rides git (rare agent-state commits); `conversations:get` becomes a DB read.
- **Promoted:** `lfs.ts`'s sha256 store → `@ax/blob-store-fs`.
- **Kept as-is (skills):** the `0555` ephemeral projection + `materializeInstalledSkillsFromEnv`, quarantine-as-host-state (phase-2), the session-dirty → re-spawn trigger, the capability-proposal concept, the runtime reactive egress wall (TASK-37) as a safety net for *undeclared* reach.

The recurring shape: the right primitives are already in the tree — a content-addressed store in `lfs.ts`, a scratch mount at `/ephemeral`, a deleted `conversation_turns` table, the `0555` projection, the scan/quarantine, the approval card. This proposal connects them and disconnects git from all the data that never wanted it.

---

## Open questions

1. **Resume-jsonl store: row-per-line in Postgres vs the blob store?** Row-per-line is the smaller step (one table, transactional with the conversation row, cheap appends, trivial `max(seq)` resume check) but adds many small rows per long session; a periodic compaction-to-blob is the escape hatch if row counts bite. The display event log (B1) is uncontroversially Postgres rows. Lean Postgres rows for both in Phase 2; revisit the resume store only if row volume bites.
2. **Transcript GC / retention.** Append-only rows per conversation; deleting a conversation deletes its event-log + transcript rows. The `resync-required` path replaces a conversation's transcript rows wholesale. Any version history wanted? (Probably not — both logs are cumulative.)
3. **Blob GC.** Reference-counted by attachment/artifact/skill rows; a sweep deletes unreferenced sha256s. Simpler than LFS GC, but define the sweep's safety (don't delete a blob mid-upload, or one a `pending` skill references).
4. **Pattern A project artifacts** legitimately double-home (git + blob). Confirm that's acceptable rather than surprising.
5. **Does anything still need `git`/`git-lfs` in the sandbox image** once blobs, transcripts, and skills leave? Only identity + Pattern A do — gate the binary on the Pattern A profile.
6. **Should imported *zero-capability* skills really be gated?** Part D gates on `origin` even when caps are empty (provenance). Alternative: gate only on capabilities, trusting any clean-scanned instruction text regardless of origin. Leaning gated-on-provenance (an externally-authored body the human hasn't seen is a supply-chain hop), but it's a one-line policy knob.
7. **Same-turn skill create-and-use.** Ship (a) + the "say go" tee-up, or invest in (b)/transparent-re-spawn-replay now? Recommend (a); revisit only if users hit the seam often.
8. **Editing a quarantined or denied skill draft.** The agent re-materializes the draft into `/ephemeral` from the stored bytes and re-proposes. Confirm the UX: does a denied skill linger as `pending`/`denied` in the Skills affordance, or vanish?
9. **Per-user vs per-agent authored skills.** The union/attachment model (`2026-05-26-jit-per-user-skill-attachment-orchestrator-union-impl.md`) is unchanged, but confirm an authored skill's default scope (this agent only, until shared-to-catalog).
