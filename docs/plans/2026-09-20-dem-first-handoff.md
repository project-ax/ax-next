# HANDOFF — DEM-first memory, rung 2 complete-gate / incomplete-scope

**Written:** 2026-09-19 late (UTC 2026-09-20), after PR #633 merged. `main` = `f70931fc`.
**Read first:** `docs/plans/2026-09-19-dem-first-handoff.md` (the previous layer — rung 2's
first slices, the bench, environment setup) and `dem-memory/HANDOFF.md`. This file is what
happened since, what is open, and what will bite you.

**The design spec everything implements:** `docs/plans/2026-09-18-dem-first-memory-design.md`.
Its status line still reads *"design, not scheduled. A thought experiment that produced a
buildable spec."* Nobody has decided to replace Strata. Rung 4 is the decision.

---

## 1. Read this before you quote "rung 2 is done"

**Rung 2's GATE is met. Rung 2's SCOPE is not.** This distinction cost a wrong status
report in the session that wrote this file, and it is easy to repeat.

- §8's rung-2 **gate** is a contract checklist — agent isolation, owner scoping, closure
  atomicity, two-sided close, provenance immunity, degraded flags, pending drain,
  foreign-id refusal. All eight are covered, on **both** backends, by 91 identical
  `runFactsContract` cases. That gate passes with an `about`-only filtered listing, which
  is exactly what shipped.
- §2.1 defines the **rung** as *"the engine (DEM's store + three-channel recall + RRF +
  rerank)"*. Retrieval is engine, not product. So **TASK-434 (sqlite channels) and
  TASK-457 (postgres channels) are the remainder of rung 2**, not rung 3.

The gate under-describes its rung. Say "rung 2's gate is met, retrieval outstanding."

**Rung 3 is `@ax/memory` only** — observer → rewrite → normalize → record, the injected
block, `memory_recall`, `memory_note`, export, UI, `memory:recall/remember/forget`. It does
not exist and is **not decomposed into cards**. That is the largest remaining build.

**Rung 4 is the gate that decides everything** (accuracy ≥ 76.0% replicated across two
answer arms) — and be precise about what blocks it, because the obvious answer is only
half of it.

§8 measures rung 4 through *"an **agent** holding `memory_recall`"*. `memory_recall` is a
**rung-3 deliverable**. So **rung 4 is gated on the whole product layer, not just on
retrieval** — finishing TASK-434 does not unblock the measurement, and rung 3 is the far
larger blocker of the two. The ladder runs **3 before 4**, in order; there is no shortcut
where a finished engine gets you a number.

What TASK-434 *is*: the last card of **rung 2**, and a hard prerequisite for a rung-4 run
that means anything (you cannot hit LongMemEval accuracy through an `about`-only filtered
listing). Both are true — it is on the critical path and it is nowhere near sufficient.

**One coupling to notice before building it.** §3.3 puts the normalizer's **write-path**
embedder in `@ax/memory` (rung 3), while TASK-434 needs a **read-path** embedder injected
into the engine. Two embedder seams, two layers, one deployment that has to configure both.
Nobody has designed how they relate. If TASK-434 picks a config shape in isolation, rung 3
may have to rework it — so it is worth a paragraph of thought at 434's Phase 1, or a quick
rung-3 decomposition first if you want that answered before you commit to a seam.

---

## 2. What merged this session

| PR | Card | What |
|---|---|---|
| #607 | TASK-422 | degraded signal + `slot: pending` sentinel + `memory:facts:reindex` drain + `activeOnly:false` history. 48 → 98 tests |
| #614 | TASK-448 | `supersede` re-settles the chain its retraction strands. 98 → 109 |
| #615 | TASK-423 spike | found the FTS/vector gate was stale; un-gated the card |
| #616 | — | fixed a dangling card reference after a board-ID collision |
| #633 | TASK-423 | `@ax/memory-facts-postgres` + `presets/k8s` wiring. **`memory:facts:*` is reachable in production** |

Engines now: `@ax/memory-facts-sqlite` **111 tests**, `@ax/memory-facts-postgres` **107**,
**91 shared contract cases on both**. Five hooks: `record | recall | supersede | clear |
reindex`, pinned on a real CLI boot **and** in `presets/k8s`'s canaries.

Other sessions merged heavily the same day (#623–#635). Two of those change how you work —
see §4.

---

## 3. Open work, in the order you would do it

### 3.1 TASK-434 — full RRF recall, sqlite (ready, critical path)

> **As built, 2026-09-19/20 (PR pending).** Shipped as described below, with four
> corrections worth carrying forward.
>
> 1. **The embedder/reranker seam is a hook NAME + optional model** (`{ hook, model? }`)
>    declared under `optionalCalls` with a `degradation` string — not a function injected
>    through plugin config. That is the in-repo precedent twice over (`memory-strata`'s
>    `orchestrator: { hook, model }`; `llm-anthropic`'s `credentials:get`), and it answers
>    §1's "two embedder seams" worry directly: a hook name makes rung 3's write-path
>    embedder and this read-path one the SAME seam. Verified that `bootstrap.ts`'s
>    `verifyCalls` skips `optionalCalls`, so an absent producer is non-fatal at boot and
>    does **not** drag the plugin into the preset canaries' `PLUGINS_TO_DROP`.
> 2. **The contract divergence §3.1 warned about is resolved by a capability descriptor,
>    not a simultaneous flip.** `runFactsContract`'s factory now takes
>    `capabilities: { fusionRecall?: boolean }`. sqlite declares `true`; postgres declares
>    nothing and stays on the rejection branch (its 7 fusion cases report as *skipped*, not
>    as silent passes). TASK-457 flips one boolean and inherits them.
> 3. **No provider plugin ships.** Nothing registers the hooks, so a default boot reports
>    `degraded: ['semantic','ranking']` — §4.4's designed state, not half-wired code. The
>    card still delivers live value: `query` goes from `invalid-payload` to a real
>    **sparse + temporal** RRF answer with no provider at all.
> 4. **The temporal channel ADMITS candidates** (query-independent), as `dem-memory` has
>    it — so a query matching nothing returns recent rows, not an empty answer. An earlier
>    plan of mine specified the opposite; faithful won because rung 4 must replicate what
>    rung 1 measured, and design §4.2 already routes the thin-table hallucination risk to
>    that same rung. It orders by `transaction_time DESC, valid_start DESC, id DESC` (the
>    reference's key, not the filtered listing's), which matters precisely *because* the
>    channel admits: the ORDER BY sets RRF ranks.
>
> **Two traps for whoever takes TASK-457.** (a) The plan's "share the RRF constants via
> `@ax/memory-facts-contract`" is **not implementable**: that package declares `vitest` as a
> runtime dependency and `eslint.config.mjs` blocks `@ax/*` *value* imports from plugin code
> outside a named allow-list (`allowTypeImports` is why `import type` works today). Each
> engine keeps a local copy pinned by a parity test, the `PENDING_SLOT` precedent. **TASK-457
> hits the same wall** — duplicate + pin, or split the suite behind a subpath export first.
> (b) `sqlite-vec` is pinned **exact at 0.1.9** per design §6.5; `packages/memory-strata`'s
> pre-existing `^0.1.6` was left alone and is now inconsistent (follow-up filed).
>
> Tests: sqlite **111 → 162**, contract **9** (new unit suite; that package had no test
> runner before), postgres **107** unchanged. Full gate green.

Port `dem-memory/src/engine/recall.ts` — sparse FTS5 + dense `sqlite-vec` + temporal, RRF
fusion, optional rerank. **Not graph** (ablated and dropped at rung 0).

What TASK-422 already built for you, so do not reinvent it:
- `DegradedFlag` (`'semantic' | 'ranking' | 'pending'`) and the accumulator are in the
  contract and already returned by `recall` and `reindex`. Push `'semantic'` when the
  embedder is unavailable and `'ranking'` when the reranker is, into the **same array**.
- `pendingStatus()` in `memory-facts-sqlite/src/pending.ts` is the single place the
  count-and-flag derivation lives (Invariant 4). Put the new probes beside it.
- `store-unavailable` already covers "store down" — that is an error, never a flag.
- `schema.ts` has a `PRAGMA table_info`-guarded additive migration helper. Use it for the
  embedding column rather than writing a second one.

Needs deciding: the embedder config seam (shape never designed), and `sqlite-vec` is a new
native dependency → **run `security-checklist`**. `recall` currently *rejects* `query` with
`invalid-payload`; both backends must stop rejecting it at the same moment or they diverge
on the shared contract.

### 3.2 TASK-457 — the same channels on postgres (gated on 434)

The `tsvector`-vs-`pg_trgm` and pgvector decisions live here, not in TASK-423. In-repo
precedent is good: `@ax/memory-strata-index-postgres` uses a `GENERATED ALWAYS … STORED`
tsvector + GIN + `websearch_to_tsquery`/`ts_rank`, mirroring its sqlite twin's FTS5 +
`bm25()`, with **score orientation normalized in the mappers** (sqlite negates `bm25()`) and
operator neutralization pinned by a shared contract case. Copy both habits. `pg_trgm` is
used nowhere in this repo.

**Read TASK-458 first** — whether pgvector exists anywhere is unproven.
*(Resolved 2026-09-26: the embedded image ships pgvector 0.8.0 and the chart now proves it — see §3.3.)*

### 3.3 TASK-458 — the pgvector bootstrap swallows its own failure

`deploy/charts/ax-next/templates/postgresql-init-job.yaml` runs `CREATE EXTENSION IF NOT
EXISTS vector` and ends with `|| echo "pgvector not available…"`, making failure and success
indistinguishable. Nothing proves `bitnamilegacy/postgresql:17.6.0-debian-12-r4` ships it;
no chart test references `EXTENSION`; and **no test lane could check** — every
`PostgreSqlContainer` in the repo is `postgres:16-alpine`. Answer the question with one
`docker run` before designing on it.

*Resolved 2026-09-26 (TASK-458):* it ships pgvector **0.8.0**. The Job now fails loudly and
`deploy/charts/ax-next/__tests__/pgvector-bootstrap.test.ts` proves both directions in the
`helm-render` lane. The `PostgreSqlContainer` lanes are still `postgres:16-alpine` with no
`vector` — that part is TASK-457's to solve.

### 3.4 TASK-459 — NUL/control chars at the record door (upgraded; read the card)

No longer hygiene. **The two backends disagree**: a NUL-bearing `about`/`relation`/`value`/
`slot` succeeds on sqlite and throws `store-unavailable` on postgres, because postgres
`TEXT` cannot hold U+0000 (SQLSTATE 22021). Reachable in production — `record` defaults to
`provenance: extracted`, i.e. model output, and `about` is free text. Rejecting at the
shared write door is now the leading option because it is the only fix that lands in **one**
place for **both** engines.

### 3.5 Not yet carded: rung 3

`@ax/memory`. Decomposing it is its own session's work. Note §5.4 declines to build
**import** (markdown → store), and the design itself calls that *"the one thing the
greenfield framing hides, because real adoption would need it"* — every existing agent has
docs. Replacement also means one memory plugin per preset (Invariant 4 forbids both for an
agent) with `memory:rules:*` shared so the Rules UI works either way. None of that is
carded or costed.

---

## 4. Things this session hit. Do not re-derive them.

**`.claude/memory` root files are FROZEN archives as of #623 (TASK-415), and CI enforces
it.** Write rows to a shard — `.claude/memory/<kind>/<YYYY-MM-DD>-<TASK-ID>.md`. **R1: no
line under `.claude/memory/` may be deleted. R2: root archives untouched.** Consequences
that are not obvious: you **cannot edit a shard row to correct it** — R1 makes that a
deletion — so a correction is an *appended row beside the wrong one*. That is the right
shape for a decision log anyway. Verify with `bash scripts/memory-append-check.sh
origin/main` (pass `origin/main` explicitly — against a worktree's stale local `main` it
reports false violations). Also: `scripts/memory-write-target.sh --shard <kind> <TASK-ID>`
prints the path but **clobbered PATH** when run via `$(...)` in this session's shell —
if `dirname`/`mkdir`/`git` suddenly report "command not found", that is why; use the printed
path directly.

**`append_progress` can destroy a card body (#634, TASK-470).** On macOS, an entry
containing a **literal newline** makes the `awk -v` splice abort, write nothing, and the
helper then submits the **empty string as the entire card body** while printing its normal
success line. One card went to 1 byte. Keep heartbeat lines **single-line**, and if you
suspect damage, check the byte count via the item id rather than trusting the helper's
output. (Fixed in #634 — confirm the version in your tree.)

**Docker/OrbStack wedged TWICE in one session**, both times mid-gate. Symptoms: `docker ps`
hangs or fails, `docker run` cannot start a container, and testcontainer suites produce
**0-assertion `beforeAll` timeouts** — filed as TASK-398/TASK-449. The restart that works:
```bash
osascript -e 'quit app "OrbStack"'; sleep 8; pkill -f OrbStack; sleep 5; open -a OrbStack
# then poll `docker ps` until it answers (~10s), and prove it with a real container
```
It affects **other concurrent sessions**, so it is worth a word before doing it. Be frugal
with containers: `pnpm -r run test` starts dozens and is what wedged it both times.

**A gate grep that hides failures.** `pnpm … test 2>&1 | grep -E "^ +Tests "` shows
`11 passed | 96 skipped` for a run whose **file-level `beforeAll` failed** — the `Test Files`
line carries the failure and the grep drops it. Capture the **exit code** and grep **both**
lines:
```bash
pnpm --filter @ax/<pkg> test >/tmp/x.log 2>&1; echo "RC=$?"; grep -E "Test Files|Tests " /tmp/x.log | tail -2
```
The same class bit the GraphQL board listing: rate-limited `gh project item-list` returns an
**error payload**, `jq` renders it blank, and a card reads as missing. The GraphQL budget is
**5000 pts/hr shared across every agent and session** — heavy board polling burns it.

**In a worktree, local `main` is a snapshot and nothing moves it.** `main...HEAD` sweeps in
every PR merged since your branch point. Always `origin/main...HEAD`. TASK-452 shipped a
guard test for the skill's review range; the trap still applies to every ad-hoc `git diff`
and `git log` you write. Bind the file list (`git diff --name-only origin/main...HEAD`)
rather than printing an unconditional "(empty = …)" label — that label was printed twice
this session over a non-empty diff.

**Board-ID collisions are real and happened again.** Two sessions independently took
`TASK-454`; mine was renumbered to 459. Compute `max+1` and `item-create` in **one** shell
call. TASK-426 (#625) shipped a claim-verify-yield fix — use it. Renumber the card with
**fewer references**, and prefer your own over another session's (theirs may be mid-build
with a branch named for it). Title edits need the **`DI_`** draft-issue content id, not the
`PVTI_` item id.

**The contract was leaking, and a second backend is what found it.** `runFactsContract`'s
two "colliding group key" cases hid a literal **U+0000**, which postgres `TEXT` cannot
store — they died at the INSERT before testing anything, so the contract demanded a
sqlite-only capability. Fixture moved to **U+0001**. What that costs: a revert to the
NUL-joined group key no longer collides, so it is re-pinned **backend-locally** in
`memory-facts-sqlite/src/__tests__/nul-key-collision.test.ts`. It is **unpinnable
portably** — a delimiter collision needs the delimiter inside a field. Do not "consolidate"
that test back into the contract.

**An unconditional plugin whose `calls` include `database:get-instance` breaks two preset
canaries.** `acceptance.test.ts` and `multi-tenant-acceptance.test.ts` drop the postgres
quartet and then run `verifyCalls`, which throws `missing-service` for the whole file. The
new plugin had to join their `PLUGINS_TO_DROP`. `memory-strata-index-postgres` never hits
this because its `hostLlmTools` gate hides it — so the nearest precedent gives no warning.
This is legitimate, not masking: `verifyCalls` still fails a genuinely unsatisfied `calls`
at boot, and `prod-bootstrap.test.ts` proves the real assembly against a testcontainer.

**`valid_start`/`valid_end` are `TEXT` on both backends — and the reason matters.** The
closure rules are collation-immune because `settleArrival` runs them **in JavaScript**. But
`recall` **does** order by `valid_start` in SQL on both backends, so "the SQL only compares
by equality" is false (it was written in four places this session and corrected in all of
them). What actually makes it safe is the **shape**: every instant is canonical fixed-width
`YYYY-MM-DDTHH:MM:SS.sssZ` with the sentinel identical, so lexicographic order matches
chronological order under any collation. **Revisit if** a non-canonical value reaches those
columns, or a RANGE comparison moves into SQL — TASK-457's temporal channel is the likely
trigger. The accurate version is in `memory-facts-postgres/src/schema.ts`.

**Three postgres translation traps, all handled — keep them handled.** `.changes === 0` was
the sole authority on what `supersede` closed (and since TASK-448 drives the re-settle);
Kysely's `numUpdatedRows` is a **bigint**, so the port uses `RETURNING`. `COUNT(*)` returns
a bigint-as-**string**; `pending` is typed `number`, so it is `count(*)::int` with a
`typeof` assertion. `rebuildBatch`'s per-row query became one grouped read, pinned by
counting statements through Kysely's `log`.

---

## 5. How to run things

```bash
pnpm --filter @ax/memory-facts-sqlite test      # 111
pnpm --filter @ax/memory-facts-postgres test    # 107 (needs Docker)
pnpm --filter @ax/preset-k8s test               # 185 (needs Docker)
pnpm build && pnpm lint
```
The gate from CLAUDE.md is `pnpm -r --no-bail run test && pnpm test:eslint-rules &&
pnpm test:scripts` — but see §4 on Docker. CI's `test` job runs **"Test (affected packages
+ dependents)"** and **skips** the full suite, so a green ~2-minute `test` job is real, not
a short-circuit; confirm by reading the job's step list, not its duration.

`dem-memory/**` is outside the pnpm workspace and eslint-ignored.

## 6. Board state

| Card | Status | Note |
|---|---|---|
| TASK-420/421/422/448/423 | **Done** | rung 2's gate |
| **TASK-434** | **Built, PR pending** | RRF recall, sqlite — **last card of rung 2**, now closed. Still does NOT unblock rung 4 (see §1): that measurement runs through an agent holding `memory_recall`, which is rung 3. See the as-built note in §3.1 |
| TASK-457 | To Do (deps 434) | same channels on postgres; owns the tsvector/pgvector call |
| TASK-458 | To Do | pgvector bootstrap swallows its failure |
| TASK-459 | To Do | NUL/control chars — the backends disagree until this lands |
| rung 3 (`@ax/memory`) | **no cards** | the largest remaining build — **and what actually gates rung 4**, since the measurement runs through an agent holding `memory_recall` |
