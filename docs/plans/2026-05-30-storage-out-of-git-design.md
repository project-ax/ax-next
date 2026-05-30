# Storage simplification — moving transcripts and blobs out of git

**Status:** Proposed (needs human sign-off before any code moves)
**Date:** 2026-05-30
**Related:**
- `2026-05-24-current-architecture.md` (host/runner split, transcript source-of-truth, workspace contract)
- `2026-05-01-workspace-redesign-design.md` (three-tier git topology this proposal walks back)
- `2026-04-29-runner-owned-sessions-design.md` (runner-native transcripts — Phase D/E this proposal partially reverts)
- `2026-05-15-attachments-and-artifacts-design.md` (LFS-backed attachments this proposal re-homes)
- `2026-05-22-conversations-get-latency-rootcause.md`, `2026-05-19-conversations-get-zero-turns-investigation.md`, `2026-05-23-chat-transcript-loss-fix-impl.md` (the incident record this proposal addresses)
**Supersedes (in part):** the "transcript lives in the committed jsonl" rule (current-arch §5) and the LFS-backed-attachments storage decision (attachments design §Storage).

---

## TL;DR

Git is the source of truth for three things it's a poor fit for: the **conversation transcript** (an append-only, single-writer event log), **attachments** (opaque inbound blobs), and **agent artifacts** (opaque outbound blobs). The data that genuinely wants git — real project code — already bypasses the ax git pipeline (agents clone external repos into `/ephemeral`). That inversion is why chat throws errors on most turns.

This proposal:

1. **Takes the transcript out of git** — the runner ships the SDK's jsonl as an opaque blob over IPC; the host stores it and parses it for history; resume hands it back. (Largely reverts Phase D/E.)
2. **Adds a content-addressed `blob:*` store** with `fs` (dev / single-replica) and `s3` (prod) backends — and re-homes attachments and artifacts onto it.
3. **Deletes the half-wired git-LFS layer** (server is built and routed; no client ever uses it; nothing is LFS-tracked) and promotes its content-addressed object store to the `fs` blob backend.
4. **Keeps large files out of git entirely** by creating them in the existing `/ephemeral` scratch mount, never `/permanent`.

Net: git stops being load-bearing on every chat turn. It survives only as an **opt-in** backend for the rare versioned-project workload. The trust boundary (sandbox edge, credential proxy, IPC validation, skill `pre-apply` veto) is untouched — this is mostly removing premature/over-applied machinery, not conceding security.

---

## The problem

### The inversion

| Data | Wants git? | Today |
|---|---|---|
| Conversation transcript (`.claude/projects/*/<sid>.jsonl`) | No — append-only, one writer per session, no merge | Committed + bundled + pushed **every turn** |
| Attachments (inbound) | No — opaque blob, keyed by conversation | `attachments:commit` → `workspace:apply` (git), shares the chat mirror |
| Artifacts (outbound) | No — opaque blob the user downloads | Written to `/permanent`, swept by `git add -A`, durable only at turn-end commit |
| User project code | **Yes** — diff/branch/merge | Cloned into `/ephemeral`, **outside** the ax git pipeline |

Git provides versioning, branching, merge, and content-addressed integrity. The transcript and the blobs need none of those; the project code needs all of them and doesn't use ours.

### The incident record (all symptoms of the same root cause)

- **Multi-minute reply latency.** `conversations:get` is "always exactly one assistant-turn behind until the session is reaped" because a reply becomes durable only on the *next* turn's `git add -A` or idle-reap (`2026-05-22-conversations-get-latency-rootcause.md`). Worked around with a jsonl-polling `waitForTurnTranscript`.
- **Zero-turns.** The SDK wrote the jsonl outside the workspace root (`CLAUDE_CONFIG_DIR` vs `HOME`), so `git add -A` never saw it (`2026-05-19`). Worked around with a filesystem symlink (`scaffoldSdkProjectsSymlink`).
- **Transcript loss / stuck retry loop.** `attachments:commit` advances the shared mirror out-of-band → the runner's `commit-notify` hits `parent-mismatch` → 500 → infinite retry on a stale parent → turns lost (`2026-05-23`). Fixed with a fetch-and-rebase resync loop on both commit sites and both backends.
- **Resume hard-crash** ("No conversation found with session ID") when the committed transcript ends mid-tool-result; guarded by F2a (`hasResumableTranscript`).
- **Tri-party deterministic-OID coupling.** Three packages must pin byte-identical commit identity + epoch dates (`workspace-git-core` `BASELINE_ENV`, `ipc-core` `HOST_GIT_DETERMINISTIC_ENV`, the `workspace-git-server` client) or CAS breaks and turns get rejected.
- **git-lfs missing-binary** breaks ~25 runner tests locally (`mistakes.md` 2026-05-25).

None of these serve a feature. They exist to make git behave like an append-only log and a blob store.

---

## What changes

Four moves, independently shippable, in rough priority order.

### A. Transcript out of git → DB (reverts Phase D/E)

Today the SDK's per-session jsonl (`.claude/projects/*/<sid>.jsonl`) is the **single** source of truth: it's committed to git every turn, and `conversations:get` reconstructs the displayed history by parsing it (`parseJsonlToTurns`). That one artifact is being asked to serve two jobs with different requirements, and that conflation is the awkwardness. Split it:

| Concern | Needs | Source of truth |
|---|---|---|
| **Redisplay** an old chat perfectly | tool calls, errors, approval cards, artifact chips, cold-start narration, skill notices — incl. **host-generated UI events the SDK never sees** | **display event log** (host-owned DB rows) |
| **Resume** + reuse warm KV cache | byte-exact SDK transcript incl. bookkeeping (`queue-operation`, `last-prompt`, `skill_listing`) | **the SDK jsonl** (verbatim, DB rows) |

These are different shapes. Neither is derived from the other: the jsonl is lossy for display (no host UI events), the display log is lossy for resume (no SDK bookkeeping). This is *better* on I4, not worse — **display** has one SoT and **resume** has one SoT; they don't overlap. The model/tool *content* appears in both (two serializations of the same turn), with clear authority: the jsonl is authoritative for **what the model saw**, the event log for **what the user saw**. On divergence, neither is "fixed" from the other — divergence is a bug.

#### A1. Display event log (the redisplay SoT)

Don't reconstruct the display by re-parsing the jsonl. Persist **the exact ordered stream of UI events the host already emits to the browser over SSE** — turn deltas, tool-call frames, permission/approval cards, surfaced provider/sandbox errors, artifact-published frames, cold-start narration. Three reasons:

1. **The jsonl is missing half the UI.** Approval cards, surfaced errors, artifact chips, narration, "skill installed" notices are *host/orchestrator* events — not in the SDK transcript. Redisplay from the jsonl drops them on reload.
2. **Reload == live, by construction.** The live chat is a fold over the SSE stream; replaying the *same* persisted frames through the *same* renderer makes an old chat identical to a live one — guaranteed, not hand-maintained. One render path, exercised both ways.
3. **It decouples display from the SDK's internal format**, which carries display-noise bookkeeping and can shift across SDK versions.

The runner **already ships this stream**: `event.stream-chunk` live (`main.ts` assistant/user branches) and `event.turn-end` at the `result` boundary (`main.ts:1304,1344`), carrying the turn's `ContentBlock[]`. The only change is host-side: **persist** those frames (append-only rows, `(conversationId, seq)`) instead of only fanning them out. `conversations:get` becomes "read the event log," not "parse the jsonl." Interactive widgets fold to terminal state naturally — a card's later "approved, granted X" frame is just a subsequent event; replay reproduces the resolved card with no special final-state bookkeeping. `reconstructAttachmentBlocks` stays (untrusted-input hardening).

#### A2. Resume jsonl (the resume SoT) — opaque rows, not a blob

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

Together A1+A2 delete, for the common chat path: the per-turn commit, bundle, push, host-mirror fetch, the `parent-mismatch` CAS, the rebase-resync loop, the deterministic-OID tri-party coupling, and the latency. We had a `conversation_turns` table before Phase E deleted it; A2 is largely that store, fed by a raw-line delta instead of git.

> **KV-cache horizon.** Restoring the exact jsonl gives **resume correctness always** (any age) and **warm prompt-cache reuse only while warm** — Anthropic's server-side prompt cache is TTL-bounded (minutes), so a fresh pod replaying the identical prefix hits it for a *recently active* chat and pays full prefill for an old one. Cache reuse is a free bonus of the same mechanism, not a reason the jsonl must persist forever. The jsonl persists for resume correctness.

> **Don't reconstruct the jsonl from the display log.** They're complementary and each authoritative for its own job — see the table above. Store the jsonl lines verbatim; never synthesize them from parsed turns.

### B. A content-addressed blob store (`blob:*`)

A storage-agnostic service hook, one registrar per deployment, mirroring the `storage-sqlite` / `storage-postgres` split:

```
blob:put(ctx, { bytes }) → { sha256, size }          // content-addressed; idempotent on identical bytes
blob:get(ctx, { sha256 }) → { bytes } | { found:false } // streamed
blob:stat(ctx, { sha256 }) → { size } | { found:false }
blob:delete(ctx, { sha256 }) → {}                    // GC; safe only when unreferenced
```

Payloads carry only `sha256` / `bytes` / `size` — no backend vocabulary (no `bucket`, `oid`, `lfs`, `pack`). Bytes ride the `callBinary` octet-stream channel, never the 4 MiB JSON frame.

**Backends:**
- **`@ax/blob-store-fs`** — content-addressed files at `<root>/<sha[0:2]>/<sha[2:4]>/<sha>`. This is `workspace-git-server/src/server/lfs.ts` with the git/LFS protocol framing removed: it already does sha256 addressing, streamed I/O, atomic temp-then-rename, and digest verification. Single-replica (RWO PVC), zero new dependencies, cheapest possible. **The simplest first step.**
- **`@ax/blob-store-s3`** — `@aws-sdk/client-s3`. One implementation targets MinIO (self-host + dev parity in kind), GCS (S3-compatible endpoint, the likely GKE prod home, with Workload Identity = no static keys), AWS S3, R2, etc. Multi-replica-safe. Unlocks presigned direct browser↔bucket transfer later (the attachments design's deferred "pre-signed direct-to-storage" non-goal).

Recommendation: ship `fs` + `s3`; run MinIO in kind for dev/test; point `s3` at GCS+Workload-Identity in prod. At chat scale the storage bill is pennies — "cheap" here is about ops, and managed object storage has the lowest TCO.

### C. Attachments & artifacts on the blob store; `/ephemeral` working tier

Large files move in two directions; both land in the **same** blob store, and **neither touches git**.

**Attachments: where they live, before vs. after.** (Same story for artifacts, mirrored.)

| | Today | After |
|---|---|---|
| **Durable home** | a git blob in `/permanent`'s history (committed via `attachments:commit` → `workspace:apply`) — *not* actually an LFS object, see §D | a sha256 object in the `blob:*` store (`fs` PVC / S3·GCS) |
| **Sandbox-visible copy** | the committed file in `/permanent`, on the shared chat mirror | a read-only working copy in `/ephemeral/uploads/`, materialized at session start from `blob:get` |
| **Metadata** | (implicit in the git tree path) | an `attachments` row `{conversationId, sha256, displayName, mediaType, size}` |
| **Write path** | rides the per-turn commit/bundle → shares the mirror → `parent-mismatch` race | host-side `blob:put` on `POST /api/attachments`, before any sandbox exists |
| **Download** | served out of the git mirror | `GET /api/files` → ACL → row → `blob:get` → stream |
| **De-dup / integrity** | none (raw bytes per commit) | content-addressed: identical bytes stored once, digest-verified on read |

The headline: attachments leave git **entirely**. And the "LFS" they're nominally leaving was never load-bearing — uploads are committed as raw git blobs today, *not* LFS objects (§D), so this removes dead machinery rather than migrating live LFS data.

The sandbox already has the right mount (`pod-spec.ts:461`, subprocess `open-session.ts:264`): `/permanent` is git-tracked; **`/ephemeral`** is `emptyDir` scratch that `git add -A` (run in `/permanent`) never sees, and the runner already uses it (`env.ephemeralRoot`, the Python venv).

**Outbound (artifacts).** Re-point the `artifact_publish` namespace from `/permanent/.ax/artifacts/**` to **`/ephemeral/artifacts/**`**:
1. Model generates the deliverable into `/ephemeral/artifacts/report.pdf`.
2. Model calls `artifact_publish(path)`. The runner-side executor already does `lstat` → size cap → read → **sha256**; it now streams the bytes to `blob:put` and the host inserts an artifact row `{conversationId, sha256, displayName, mediaType, size}`, returning `ax://artifact/<id>`.
3. The ephemeral copy dies with the pod — the durable copy is the blob.

Durability now begins **exactly at `artifact_publish` return** (a `blob:put` success), not at the fuzzy turn-end commit. The tool description flips from "the workspace commit at turn end captures it" to "the bytes are stored durably on publish; nothing is committed."

**Inbound (uploads).** Store the uploaded bytes directly via `blob:put` (host-side; the browser already proxies through the host on `POST /api/attachments`). The durable home is the blob; the sandbox only needs a *readable working copy*, so materialize uploads into **`/ephemeral/uploads/`** at session start, not `/permanent`. `attachments:commit` → `workspace:apply` (git) goes away; with it goes the shared-mirror `parent-mismatch` race entirely.

**Download** (`GET /api/files`) keeps its ACL (conversation ownership + path/transcript scope) and resolves `artifactId/attachmentId → row → blob:get → stream`.

### D. Delete the half-wired LFS layer

Findings (traced 2026-05-30):
- The LFS **server** is fully built and routed: `listener.ts:714-741` dispatches batch/storage/verify; `repos.ts:217` provisions `<workspaceId>.lfs/objects/` per workspace; `lfs.ts` is a complete sha256 store.
- **No client ever uses it.** No `.gitattributes` is created anywhere (the only repo hit is a *comment* at `git-workspace.ts:156`); no `git lfs track` / `filter=lfs`; no `git lfs push`. The default backend `@ax/workspace-git` → isomorphic-git has no LFS support and ignores `.gitattributes` filters. The runner's `git lfs install --local` installs filters that never fire.
- Consequence: today every upload/artifact is committed as a **raw full-byte git blob** held in isomorphic-git's memory, with no LFS/GC benefit — and the LFS server is dead weight (a CLAUDE.md "no half-wired plugins" violation).

Action: remove the LFS server/endpoints/provisioning and the runner's `git lfs install`; **promote `lfs.ts`'s content-addressed store to `@ax/blob-store-fs`** (move B). Net change in surface: down.

> **Caveat to confirm before deleting:** verify against a running pod that nothing image-baked (a global `.gitattributes` or `git config` filter) tracks `.ax/**` — `git -C /permanent check-attr filter .ax/uploads/x` inside a sandbox. Production code says no; confirm the runtime agrees.

### E. What git keeps

`/permanent` (git) holds only small, versioned **agent state**: skill drafts (`.ax/draft-skills/`), identity (`IDENTITY.md`/`SOUL.md`), and — for the rare Pattern A workload — actual ax-hosted project code under `/permanent/workspace/`. That last case is the one thing git is genuinely for; it may still publish a file as an artifact (an intentional double-home: git holds editable history, the blob holds the immutable shared snapshot).

**Skill validation is unaffected.** The `validator-skill` `workspace:pre-apply` hard veto (SDK-config paths) and the `skills:upsert` structural checks key off a *write chokepoint*, not git specifically; draft-skill writes are low-frequency and keep their veto-able apply. The capability-intersection model (`proposal ∩ approved`) and the egress/credential boundaries are entirely separate from storage.

---

## The new sandbox storage model

```
/permanent/                    ← git-tracked agent state (small, versioned)
  .ax/draft-skills/<id>/...     ← skill drafts (pre-apply validated)
  IDENTITY.md / SOUL.md         ← identity (validated)
  workspace/  (Pattern A only)  ← ax-hosted project code (the rare real git case)

/ephemeral/                    ← emptyDir scratch; git NEVER sees this
  artifacts/<file>              ← agent deliverables → blob:put on publish
  uploads/<conv>/<file>         ← user uploads, materialized from blob:get
  .venv/, caches/, code/        ← existing scratch (Python venv, cloned repos)

(durable homes, off-pod)
  Postgres   conversation_events     (display event log — append-only rows, the redisplay SoT)
             conversation_transcripts (resume jsonl — opaque rows, one per line, (conv,seq))
             attachments / artifacts metadata rows
  blob store sha256-addressed bytes (fs PVC dev / S3·GCS prod)
```

**One-line principle:** *git holds only small versioned agent state; every large/opaque blob (uploads in, artifacts out) uses `/ephemeral` as the disposable working copy and the blob store as the single durable home. Git never touches a blob, and never carries the transcript.*

---

## How this lands the invariants

- **I1 (transport/storage-agnostic hooks).** Improved. `blob:*` carries `sha256`/`bytes`/`size`; `session.append-transcript` carries `conversationId`/`fromSeq`/`prefixHash`/opaque line strings. No `oid`/`bucket`/`lfs`/`commit`/`ref`. Named alternate impls: `blob-store-fs` vs `blob-store-s3`; a Postgres row-per-line transcript store vs a blob-store transcript.
- **I2 (no cross-plugin imports).** Unchanged. New plugins talk over the bus / IPC.
- **I3 (no half-wired plugins).** Improved — this *removes* a half-wired surface (LFS). Each move ships its producer + consumer + canary reachability in one PR.
- **I4 (one source of truth).** Improved. Transcript splits cleanly into two non-overlapping SoTs — a display event log and the resume jsonl rows — each with one writer (the runner, via `event.turn-end`/`stream-chunk` and `session.append-transcript`). Blobs: content-addressed, one store. Removes the transcript/attachments shared-mirror contention that caused the loss bug.
- **I5 (capabilities minimized).** Neutral-to-better. Trust boundary untouched. The common chat path no longer needs a `git`/`git-lfs` binary in the sandbox. S3+Workload-Identity removes static keys.
- **I6 (one UI language).** Unchanged — download/upload chips already compose shadcn primitives.

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

## Security walk (security-checklist)

This touches IPC actions, storage of untrusted content, and a new dependency (`@aws-sdk/client-s3`) — the skill fires.

- **Sandbox escape / path traversal.** Blob keys are `sha256` (`^[a-f0-9]{64}$`, the existing `OID_REGEX`), never caller paths — no traversal. The `fs` backend keeps `lfs.ts`'s atomic temp-then-rename + digest re-verification (reject on mismatch). `artifact_publish` keeps `lstat` (reject symlinks) + size cap + path allowlist, now scoped to `/ephemeral/artifacts/**`. Removing `git`/`git-lfs` from the common sandbox path *shrinks* the escape surface.
- **Prompt injection.** The transcript jsonl and any uploaded/published file are untrusted model/user output. They are stored as opaque bytes and **never executed or shell-interpolated**; the host parser whitelists `user`/`assistant`/`tool` and `reconstructAttachmentBlocks` re-validates against the conversation's own upload prefix + schema (unchanged hardening). A published artifact's `displayName`/`mediaType` is treated as untrusted text by any renderer.
- **Supply chain.** `@aws-sdk/client-s3` is the one new dependency (modular, version-pinned); run `pnpm audit` on the pinned range. The `fs` backend adds nothing. S3 auth uses Workload Identity / IRSA (no static keys in the tree); MinIO access keys, if used, live in the credential vault, never in env or code.

---

## Migration / phasing

Each phase leaves the tree green and is independently reviewable.

1. **Phase 1 — blob store (additive).** Ship `@ax/blob-store-fs` (lift `lfs.ts`) + the `blob:*` hook + `@ax/ipc-protocol` wire + `callBinary` plumbing. No consumer yet beyond tests + canary. *(I3: wire a trivial real caller or land with Phase 3 — don't merge it dangling.)*
2. **Phase 2 — transcript out of git.** Two halves. **2a (display):** persist the `event.turn-end`/`event.stream-chunk` frames the host already receives into a `conversation_events` log; switch `conversations:get` to read it (no jsonl parse). **2b (resume):** add `session.append-transcript`/`replace-transcript` + the row-per-line `conversation_transcripts` store; replace `commitTurnAndBundle` at the `result` boundary with the delta-ship (keeping `waitForTranscriptUuid`); switch resume to rebuild the jsonl from rows; F2a guard becomes `max(seq) > 0`. Remove the per-turn jsonl-driven commit dependency. **Biggest robustness win** — re-walk the latency + concurrent-writer + resume scenarios on `ax-next-dev`.
3. **Phase 3 — artifacts/uploads onto the blob store + `/ephemeral`.** Re-point `artifact_publish` to `/ephemeral/artifacts/**` + `blob:put`; route uploads through `blob:put` and materialize into `/ephemeral/uploads/`; download resolves via `blob:get`. Drop `attachments:commit → workspace:apply`.
4. **Phase 4 — delete LFS + thin the git pipeline.** Remove the LFS server/endpoints/provisioning + runner `git lfs install` (after the runtime `check-attr` confirmation). With transcripts and blobs gone, the per-turn commit/bundle fires only when `/permanent` agent state actually changed (rare) — consider gating it on a non-empty `.ax/**` diff.
5. **Phase 5 — `@ax/blob-store-s3` + MinIO/GCS wiring.** Add the S3 backend, MinIO in kind, GCS+Workload-Identity in the prod chart. Optional: presigned direct browser↔bucket transfer.

A genuine multi-replica future (ARCH-9) gets simpler: blobs are in object storage and the transcript is in Postgres — both already multi-writer-safe — instead of a sharded git tier.

---

## Open questions

1. **Resume-jsonl store: row-per-line in Postgres vs the blob store?** Row-per-line is the smaller step (one table, transactional with the conversation row, cheap appends, trivial `max(seq)` resume check) but adds many small rows per long session; a periodic compaction-to-blob is the escape hatch if row counts bite. The display event log (A1) is uncontroversially Postgres rows. Lean Postgres rows for both in Phase 2; revisit the resume store only if row volume bites.
2. **Transcript GC / retention.** Append-only rows per conversation; deleting a conversation deletes its event-log + transcript rows. The `resync-required` path replaces a conversation's transcript rows wholesale. Any version history wanted? (Probably not — both logs are cumulative.)
3. **Blob GC.** Reference-counted by attachment/artifact rows; a sweep deletes unreferenced sha256s. Simpler than LFS GC, but define the sweep's safety (don't delete a blob mid-upload).
4. **Pattern A project artifacts** legitimately double-home (git + blob). Confirm that's acceptable rather than surprising.
5. **Does anything still need `git`/`git-lfs` in the sandbox image** once blobs and transcripts leave? If only Pattern A needs git, gate the binary on that profile.

---

## What gets deleted / simplified (concrete)

- **Deleted:** LFS server (`workspace-git-server/src/server/lfs.ts`), its routes (`listener.ts:714-741`), per-workspace `.lfs` provisioning (`repos.ts:217,341`), runner `git lfs install --local` (`git-workspace.ts:158`).
- **Deleted/retired (common path):** `attachments:commit → workspace:apply`; the transcript read via `workspace:list`/`workspace:read` (`conversations/src/plugin.ts:888`); the per-turn jsonl commit/bundle dependency and its `parent-mismatch` resync (`commit-notify-resync.ts`, `resyncBaselineAndReplay`); the `scaffoldSdkProjectsSymlink` workaround once the jsonl no longer needs to live in `/permanent`.
- **Simplified:** the tri-party deterministic-OID coupling (`BASELINE_ENV` / `HOST_GIT_DETERMINISTIC_ENV` / server client) shrinks to whatever still rides git (rare agent-state commits); `conversations:get` becomes a DB read.
- **Promoted:** `lfs.ts`'s sha256 store → `@ax/blob-store-fs`.

The recurring shape: the right primitives are already in the tree (a content-addressed store in `lfs.ts`, a scratch mount at `/ephemeral`, a deleted `conversation_turns` table). This proposal connects them and disconnects git from the data that never wanted it.
