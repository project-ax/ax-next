# HANDOFF — DEM-first memory, rung 2 (engine build), first slice

**Written:** 2026-09-19, after PR #603 merged to `main`.
**Read first:** `docs/plans/2026-09-18-dem-first-handoff.md` (the previous handoff — rungs 0/1,
the bench itself, environment setup) and `dem-memory/HANDOFF.md` (install recipe, noise
floors, the asOf/temporalAnchor gotcha). This file is the layer above both: what happened
since, what's open now, and what will bite you continuing it.

The design spec everything here implements: `docs/plans/2026-09-18-dem-first-memory-design.md`.

---

## 1. What's merged since the last handoff

| Task | What | Where |
|---|---|---|
| — | `memory_recall`'s `history` flag design decision (closes the knowledge-update gap from rung 1) | commit `ff58c6e8`, design doc §3.3/§4.2 |
| TASK-420 | Dropped the stale "four channel" / graph-channel doc references (graph was ablated+dropped at rung 0, #587) | commit `2dc8f578` |
| TASK-421 | `@ax/memory-facts-contract` + `@ax/memory-facts-sqlite` — the closure/tenancy engine | PR #603, commit `b106af67` |

`main` at time of writing is `b106af67`. TASK-420 and TASK-421 are both **Done** on the board.

**TASK-421 in one paragraph.** Two new packages implementing rung 2's engine, scoped down
from the design spec after finding the spec's version was too big (see §2 below): a shared
`runFactsContract` vitest suite (mirrors `packages/memory-strata-index-contract`'s pattern)
plus a sqlite backend registering `memory:facts:record|recall|supersede|clear` on the
`@ax/core` HookBus. Ports `dem-memory`'s §3.4 closure rules (same-slot closure, two-sided/
backdated closure, provenance immunity, equal-`when` tiebreak) verbatim in shape, scoped by
`ctx.agentId`. Wired into `packages/cli/src/main.ts` unconditionally, with a real-boot test
(`memory-facts-wiring.test.ts`) proving the hooks are reachable, not just contract-tested.
Went through 4 rounds of local `ax-code-reviewer` review before merge — round 1 found a
half-wired plugin + an unvalidated timestamp field, round 2 found the fix only closed half the
window (CLI, not k8s), round 3 found the round-2 fixes shipped without regression tests, round
4 approved. Full rationale for every scope cut and review finding is in `.claude/memory/
decisions.md`'s TASK-421 sections (five of them, all dated 2026-09-18/19 — search for
"TASK-421").

---

## 2. What rung 2 turned out to actually be

The previous handoff's own prediction held: "rung 0 and rung 1 both found the specified rung
was the wrong experiment — expect the same." Rung 2 as spec'd (§2.1: "the engine — DEM's store
+ four-channel recall + RRF + rerank — behind `memory:facts:*`") was one big rung. It got
split into **four board cards**, in dependency order:

- **TASK-420** (Done) — fix the stale spec.
- **TASK-421** (Done) — closure/tenancy contract + sqlite backend, activeOnly-only recall (no
  search). Highest-confidence slice: mostly porting already-battle-tested `dem-memory` test
  cases, not inventing behavior.
- **TASK-422** (To Do, ready — see §3) — degraded-mode flags + pending/reindex drain. New
  code, not a port: neither exists anywhere in `dem-memory` today.
- **TASK-434** (To Do, depends on 421+422) — the full three-channel RRF recall (sparse FTS5 +
  dense `sqlite-vec` + rerank) that TASK-421 deliberately cut. Renamed from TASK-424 mid-build
  after a board-ID collision with an unrelated concurrent card — see §4.
- **TASK-423** (Backlog, gated) — the postgres backend. Genuinely unscoped: `dem-memory` has
  **never** had a postgres implementation (sqlite/better-sqlite3 only), unlike the sibling
  `memory-strata-index-{sqlite,postgres}` pair which already has both. Also now carries the
  k8s-wiring + `preset.test.ts` canary requirement (round 2 of TASK-421's review found that
  `presets/k8s` loads no facts backend at all, so `memory:facts:*` is unreachable in
  production until this card ships — see its card body for the exact requirement).

---

## 3. Open work, in the order you'd actually do it

### 3.1 TASK-422 — degraded-mode flags + pending/reindex drain — **BUILT**

> **As built, 2026-09-19.** See `docs/plans/2026-09-19-task-422-degraded-pending-plan.md`
> and the five `2026-09-19 — TASK-422` rows in `.claude/memory/decisions.md`. The scope
> below is the card body as filed; **two things came out differently**, and the paragraph
> after this block is the part that matters if you are picking up TASK-434.
>
> **The `['semantic']` / `['ranking']` flags are NOT produced at this rung.** Neither
> channel exists — TASK-421 cut dense/RRF/rerank and TASK-434 owns the embedder seam plus
> `sqlite-vec`. Stubbing an embedder config that nothing consumes is what the Half-Wired
> Code Policy exists to stop. What shipped is the *mechanism* — a `DegradedFlag` vocabulary
> in the contract (`'semantic' | 'ranking' | 'pending'`) shared by both backends, a real
> accumulator, and contract cases — producing only `'pending'`, the one degradation this
> engine can honestly observe (a tenant holding un-drained pending-slot rows is answering
> from an incompletely-closed store). **TASK-434 pushes two more strings into the same
> array; it does not build the mechanism.** Design doc §4.4 now says which flag exists at
> which rung, so nobody re-files this card off the old line.
>
> **`memory:facts:reindex` takes `{slots?: [{id, slot}]}`, not the bare `{}` of design
> §2.2.** Slot derivation lives in `@ax/memory` (§3.3) and the engine cannot compute one,
> so with a `{}` payload nothing could ever move a row out of `pending` — the sentinel
> would be a one-way trap. The caller supplies the resolved slots; the engine applies them
> and re-derives §3.4's closure over each touched `(about, slot)` chain. Called with no
> `slots` it is a status read (`pending` count + `degraded`).
>
> **Two things were built that the card body doesn't list.** `activeOnly: false` (history,
> design §4.2) — because two *shipped* comments named TASK-422 for it, and leaving them
> standing would have re-filed the card off its own stale line. And `record`'s all-or-
> nothing batch transaction (§3.5 bullet 2) — because `batchKey` idempotency is unsafe
> without it: a batch that died halfway would be seen as "already recorded" and stay
> permanently half-written.
>
> **The trap in the re-derivation, if you touch `resettleSlotGroups`.** Replay is ordered
> by ARRIVAL (`transaction_time, COALESCE(batch_seq,0), id`), deliberately not by
> `valid_start`. §3.4's rules are arrival-indexed (rule 4 says so outright), so a
> `valid_start`-first replay gives a *different store*: a `human` row recorded first and an
> `extracted` row backdated under it is left alone by `record` (provenance immunity blocks
> the human from being reached), but a `valid_start` replay has the human close it via rule
> 1. The shipped test `does not let a human row BOUND an extracted one either` pins the
> `record` side of that. Also: a retracted row (`closed_by IS NULL`, finite `valid_end`) is
> excluded from the peer set, so re-settling a chain whose closure depended on a since-
> retracted row **reopens** the row it had closed. Documented on `resettleSlotGroups`; it
> surfaces in `reclosed` rather than silently.

Its only dependency (TASK-421) was Done. Scope, per its card body and `docs/plans/2026-09-18-
task-421-memory-facts-plan.md`'s YAGNI pass:
- §4.4 of the design doc: embedder unavailable → `degraded: ['semantic']`; reranker
  unavailable → `degraded: ['ranking']`; store unavailable → the hook throws (never a silent
  empty result). None of this exists in `@ax/memory-facts-sqlite` yet — `recall`'s `degraded`
  is hardcoded `[]`.
- §3.5: `chat:end` firing twice on the same `batchKey` should be a no-op. The `record` hook
  currently accepts `batchKey` on the payload and does nothing with it — no dedup happens.
  Embedder-unavailable-at-write-time rows should land `embedding: pending`/`slot: pending`;
  `memory:facts:reindex` (not yet a registered hook) should drain them.
- This has to land **before** TASK-434 (which needs the reranker-unavailable degraded flag to
  avoid reinventing it) and before TASK-423 (whose contract inherits whatever TASK-422 adds).

### 3.2 TASK-434 — full RRF recall (**unblocked** — 422 is built)

**What 422 hands you.** `DegradedFlag` and the `degraded` accumulator already exist in
`@ax/memory-facts-contract` and are already returned by `recall` and `reindex` — add
`'semantic'` when the embedder is unavailable and `'ranking'` when the reranker is, into the
same array, and extend the contract cases next to the existing `'pending'` ones. Don't
reinvent the signal path. `pendingStatus()` in `packages/memory-facts-sqlite/src/pending.ts`
is the single place the count-and-flag derivation lives (Invariant 4) — put the new probes
beside it rather than inline in `recall`. `store-unavailable` already covers "store down"
(that is an error, never a flag). `schema.ts` now has a `PRAGMA table_info`-guarded additive
migration helper — use it for the embedding column rather than writing a second one.

Port `dem-memory/src/engine/recall.ts`'s `RecallEngine`/`reciprocalRankFusion` (sparse FTS5 +
dense `sqlite-vec` cosine + temporal channels — **not** graph, that's gone) into
`@ax/memory-facts-sqlite`. Needs two things TASK-421 deliberately didn't design: an embedder
injected via plugin config (no shape decided yet), and a new native dependency (`sqlite-vec`)
that wants a `security-checklist` pass before it ships (Invariant 5, new dependency).

### 3.3 TASK-423 — postgres backend (blocked, Backlog)

Don't start this without a short design/spike first — the FTS-equivalent (`tsvector`/
`pg_trgm`?) and vector-search-equivalent (`pgvector`?) choices aren't made. Once TASK-422
lands, this card's acceptance criteria also require wiring the postgres backend into
`presets/k8s/src/index.ts` with a `preset.test.ts` canary — **this is the only way
`memory:facts:*` becomes reachable in production**, so don't let it slip further down the
backlog than it has to.

### 3.4 Not yet a card: the product layer

`@ax/memory` (observer, speaker rewrite, the two tools `memory_recall`/`memory_note`, export
materializer — design doc §2.1, §3, §4) doesn't exist and isn't decomposed into cards yet.
Rung 2's engine work (420–423/434) has to be substantially done first; decomposing rung 3 is
its own session's work, not a quick add-on here.

---

## 4. Things this session hit. Do not re-derive them.

**A board-ID collision is possible with concurrent sessions, and `git fetch` before opening a
PR is when you'll find it.** TASK-421's follow-up card was filed as `[TASK-424]`; a `git fetch
origin main` right before opening the PR turned up an unrelated, already-merged
`[TASK-424]` from a different concurrent session — two sessions independently computed "max
existing TASK-n + 1" from board snapshots taken around the same time. Renamed to `[TASK-434]`
everywhere (board card title via the `DI_`-prefixed draft-issue id, not the `PVTI_` item id —
`gh project item-edit --id <item>` fails with "ID must be … prefixed with `DI_`"; fetch it via
`content{... on DraftIssue{id}}`) before the PR opened. **Re-check the board for a duplicate
right before you open a PR that files a follow-up card mid-session**, not just at card-creation
time.

**`pnpm -r --no-bail run test` genuinely failed this session, and a scripting mistake hid it
for several rounds.** The pattern `pnpm -r --no-bail run test > file 2>&1; echo DONE=$?; ...`
— semicolon-separated, not `&&` — means the outer Bash tool call's own reported exit code is
whichever command runs **last** (an `echo`, which always succeeds), **not** `pnpm`'s exit code.
Several "full gate green" claims this session were made off that outer exit code alone,
without checking the actual `DONE=` value printed to output. When finally checked, `DONE=1`:
a cascade of `PostgreSqlContainer('postgres:16-alpine').start()` timeouts (`Hook timed out in
60000ms`) across every postgres-testcontainer package (`auth-better`, `agents`, `skills`,
`connectors`, `session-postgres`, …) — none of which TASK-421 touches. Diagnosed as Docker
resource exhaustion from a long session of heavy parallel builds/tests, not a regression:
`test:eslint-rules` and `test:scripts` (no Docker dependency) passed cleanly in the same run,
and GitHub's CI (a clean environment) passed the real `test` job repeatedly on this exact
code. **Always capture and read the actual exit-code variable a shell script prints — never
infer it from the wrapping tool call's own reported status when commands are `;`-joined.**

**`ci.yml` failed to trigger on `pull_request: synchronize` twice in a row this session, for
reasons that were never diagnosed (not the `gh pr edit --base` retarget case the previous
handoff's gotcha #4 covers — these were plain `git push --force-with-lease` after a rebase,
and a plain `git commit --allow-empty && git push`).** CodeQL's own workflow(s) triggered fine
both times; only the `CI` workflow (`test`/`helm-render`/`docker-build`/`semgrep`/`gitleaks`)
didn't. Confirmed via `gh api repos/<o>/<r>/actions/runs?per_page=N` filtered to
`.name=="CI"` — `gh run list --workflow ci.yml --commit <sha>` was slower to reflect reality
and once returned `[]` for a head that (per the runs API) never had a CI run at all, which is
the correct answer, just confirm it the same way both times. The fix that worked: **`gh pr
close <n> && gh pr reopen <n>`** — same remedy the previous handoff documented for the
`--base` retarget case, but here needed for an apparently-plain force-push too. Budget for
this: it cost roughly 20 minutes of wall-clock waiting across three push→no-CI cycles before
the close/reopen was tried.

**`main` moved under this branch four separate times during the PR lifecycle** (this is a
very active auto-ship-drained repo). Every conflict was the same shape: an append-only
conflict in `.claude/memory/decisions.md` (two sections both appended after the same parent
line) — never a real content conflict in this session's own files. Resolution is mechanical:
keep both sections, in order, delete the three git conflict markers. `git rebase origin/main`
correctly **skips** commits whose patch is already upstream (useful if you've directly
committed something to local `main` and then rebase a feature branch built on top of it onto
the freshly-pushed `origin/main` — it prints `warning: skipped previously applied commit
<sha>` rather than duplicating it).

**A local commit to `main` is not shipped until you `git push origin main`.** Earlier in this
session, `git commit` landed two commits directly on local `main` (the design-doc decision and
TASK-420) with no PR — legitimate for a trivial docs-only change per the user's direction — but
they were never pushed. They sat local-only for roughly two hours while 6 unrelated PRs merged
upstream, discovered only when `git fetch origin main` showed `origin/main` had diverged with
no path back. Fixed by rebasing local `main`'s two commits onto the fresh `origin/main` and
pushing before touching the feature branch. **If you commit directly to `main` without a PR,
push immediately — don't treat "committed" as "shipped."**

---

## 5. How to run anything here

Same as the previous handoff's §5 for the `dem-memory` bench itself (npm not pnpm inside it,
`--fingerprint f4752a79`, the cache symlink, credentials via `.env.walk`) — nothing about that
changed. New, for the `@ax/memory-facts-*` packages (ordinary pnpm workspace packages, not
part of `dem-memory`):

```bash
pnpm --filter @ax/memory-facts-sqlite test       # 95 tests as of TASK-422 (48 at PR #603)
pnpm --filter @ax/memory-facts-contract build
pnpm build                                       # root tsc --build; both packages are in
                                                  # root tsconfig.json's references
```

**The gate before any PR** (from CLAUDE.md, and note the two opposite traps it documents —
unchanged from the previous handoff):

```bash
pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
```

Capture and print each command's **own** exit code separately if you chain with `;` — see §4's
gotcha. Prefer `&&` or explicit `echo "DONE=$?"` immediately after each command, read into the
same turn, not assumed from the wrapper.

`dem-memory/**` is outside the pnpm workspace and eslint-ignored, so the repo-wide `pnpm -r run
test` is unaffected by anything in it — unchanged from before.

---

## 6. Board state at time of writing

| Task | Status | Depends on |
|---|---|---|
| TASK-420 | Done | none |
| TASK-421 | Done | TASK-420 |
| TASK-422 | Done (2026-09-19) | TASK-421 |
| TASK-434 | To Do (**ready** — both deps Done) | TASK-421, TASK-422 |
| TASK-423 | Backlog (gated — needs FTS/vector design spike; deps now Done) | TASK-421, TASK-422 |

`@ax/memory` (rung 3, the product layer) has no cards yet.

**Engine hook surface as of TASK-422** — `memory:facts:record | recall | supersede | clear |
reindex`, all registered by `@ax/memory-facts-sqlite` and pinned on a real CLI boot by
`packages/cli/src/__tests__/memory-facts-wiring.test.ts`. Still unreachable in k8s: the
`presets/k8s` preset loads no facts backend at all, which is TASK-423's job and the reason
that card shouldn't slip (§3.3).
