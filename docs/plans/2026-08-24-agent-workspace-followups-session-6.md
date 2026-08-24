# agent-workspace follow-ups — session 6 handoff

**Written:** 2026-08-24, after an 8-hour continuous drain.
**Supersedes:** `docs/plans/2026-08-23-agent-workspace-followups-session-5.md` for resuming.
Session 5 remains the best statement of *why* the measurement pass exists. **But §5, §12 and §13 of
it are now wrong in ways that cost real time — see §5 below before you follow any of its rules.**

---

## 0. What shipped

`main` @ `f701765b`. **11 merged, 0 open PRs, 0 worktrees, `pnpm lint` exits 0**, every merge onto a
green main.

| Card | PR | What actually landed |
|---|---|---|
| TASK-309 | #468 | eslint ignores agent worktrees — **needs TWO globs, not one** |
| TASK-251 | #469 | BIGSERIAL off `routines:recent-fires-for-agent` |
| TASK-241 | #470 | dead `optionalCalls` declaration + **5 stale "no production caller" claims** |
| TASK-245 | #471 | a drift guard that reads *both* runners' sources |
| TASK-243 | #472 | **8 false comments** in one handler (the card named 1, which did not exist) |
| TASK-311 | #473 | a dedupe test that **provably could not fail** |
| TASK-310 | #474 | zsh word-split in the skill docs' own runnable code |
| TASK-269 | #475 | dead `ToolGroup` + **4** false comments naming it |
| TASK-316 | #476 | the helm-index race that **halted the merge queue** |
| TASK-312 | #478 | BIGSERIAL off `routines:recent-fires` + the React key reading it |
| TASK-262 | #477 | freshness follows a connector id into its **resolved reach** |

Wave 5 (245/251/241/243/262/269) is **fully drained**. TASK-309 was pulled forward on throughput
grounds; 310/311/312/316 were filed *during* this session from defects the drain surfaced.

---

## 1. The measurement pass, and its actual limit

**8 cards measured. 7 were wrong about their own bug.** The base rate did not improve (6/8, then 4/8,
then 3/6 in prior sessions). **Budget it every time.** But this session found the *ceiling* of the
technique, and that is the new information:

- **A measurement can itself be wrong.** TASK-243's measurement concluded the handler had *zero* test
  coverage because it globbed `src/__tests__` instead of `src/**/__tests__`. It has **14 cases**. I
  put that false root-cause into the builder's brief; the builder refused the premise and corrected
  it. **Glob `src/**/__tests__`, never `src/__tests__`.**
- **A *measured* card can still be wrong about the thing it is correcting.** TASK-269's measurement
  said `ArtifactPublishTool` renders "inside `ChainOfThought`." It does not —
  `STANDALONE_TOOL_NAMES`/`UNGROUPED` in `Thread.tsx` put it at top level *deliberately*, so a
  download is not buried. I propagated that verbatim.
- **My own live-observed card was wrong too.** I filed TASK-311 from a real CI failure with a
  confident mechanism. Measurement **disproved it with a probe**: the dedupe key never changes across
  retries and the effect deps are `[error]`, so the assertion I blamed is *provably unreachable*.

**The rule that survives:** distinguish **observed-and-verified** from **inferred-from-observation**.
TASK-310 I observed failing *and* verified the fix — safe to build without a measurement pass, and it
shipped clean. TASK-311 I observed a symptom and *inferred* an untested mechanism — wrong. That line,
not "did I see it happen", is what predicts correctness.

---

## 2. Human rulings made this session

- **TASK-245 — test-only drift guard, NO production coupling.** The policy rail is deliberately
  runner-agnostic (`rules.ts:222-229`: "the ones BOTH runners have"), so deriving its deny rows from
  one runner's `DISABLED_BUILTINS` was rejected. Also rejected: a new shared pure-data package;
  closing as invalid. The card's literal request was refused and its *accidental* finding — a drift
  guard that read its own literal — became the work.
- **TASK-313 — replace the row id with the conversation.** `FireNowOutput.fireId` renders to users as
  `Fired (#7, ok)`. Ruled: drop `fireId`, surface `conversationId` (already on the wire at
  `types.ts:51`, backend-agnostic, and more useful). **Null branch required.** Rejected: status-only;
  a host-generated opaque receipt; leave-and-document.

---

## 3. Traps found that would have shipped

Ordered by what they would have cost.

1. **TASK-241 would have DELETED A LIVE HOOK.** The card said `skills:approved-caps-list` had no
   production caller. It had two — both landed the day *after* the card was written. Deleting it
   would have reddened `preset.test.ts:575` **and made a permissions rail understate agent reach**,
   the H4 direction `decisions.md:1681` forbids.
2. **TASK-262's "obvious" fix would have DELETED A WORKING GUARD.** The sibling producer
   `tool-connector-propose/src/freshness.ts:202` gates the *whole predicate* on
   `bus.hasService('connectors:resolve')` — correctly, because it reads one world.
   `capability-freshness` reads **two**. Copying that line would have removed the catalog guard in
   every connector-less preset: fixing a gap by deleting the protection that already existed.
   **Gate the fold, never the predicate.**
3. **TASK-243's "unify the two rejecters" (the card's own acceptance option) is FORBIDDEN.** The two
   `recoverable:false` branches differ in `discardPaths` deliberately; unifying either strips #464's
   per-path veto scoping **or lets a forged bundle receive scoped discards**.
4. **TASK-309's fix as written closes only 2 of 3 cases.** `'**/worktrees/**'` does not match
   `.worktrees/` — a different directory name. Measured with ESLint's own `isPathIgnored`, not by
   reading the glob. **Two globs required.**
5. **TASK-312's proposed React key cannot work.** The precedent it cites
   (`routes-workspace.ts:1420-1422`) is real, but that list spans many paths; *this* one is scoped to
   one `(agentId, path)`, so the composite degenerates to `firedAt` alone — and `fired_at` is
   **microsecond in postgres, millisecond on the wire**. Sub-ms rows collide. **A real precedent can
   be wrong in a new context; check its uniqueness assumptions before copying it.**
6. **Order of operations, TASK-312.** Narrowing a `returns` schema *before* fixing its consumer ships
   `key={undefined}` with **zero `tsc` errors and zero test failures** (untyped `get<>` + a cast).
   Consumer first, then schema.
7. **A text-scan guard can pass VACUOUSLY** (TASK-245, self-caught): an empty parse of one side
   collapses an intersection onto the other side, matching what you were checking. **Assert
   non-emptiness of each input before comparing.**

---

## 4. The theme: documentation rot, and that it feeds itself

This epic's dominant defect is not code. It is **prose that misleads the next reader**, including the
prose that generates the next card.

- **False comments found and fixed this session: 8 (TASK-243) + 4 (TASK-269) + 5 stale claims
  (TASK-241) + 1 (TASK-245) + 1 (TASK-262) = 19**, on top of the 15 the previous session counted.
- **Three cards were generated FROM a stale line**, not from code. TASK-241 from
  `decisions.md:1681` + `context.md:70`; TASK-245 from `context.md:69`. `decisions.md:1681` had
  *predicted* the hook's first reader — the prediction came true, and nobody closed the loop.
- **TASK-243's root-cause theory was wrong in an instructive way.** "The comments rotted because
  there are no tests" is false: that handler has 14 test cases. **Tests pin behaviour; nothing reads
  prose.** More coverage would not have caught any of the nine.
- **Comment-correcting PRs introduce their own false comments.** TASK-269's builder's first draft
  misdescribed the `ToolFallback` wiring; it self-caught by grepping before committing, and its
  reviewer then caught a *second*. **Budget two passes.**
- **Grep the deleted symbol AND its prose/kebab spellings** — TASK-269's fourth false comment hid as
  "the old tool-group".
- **Fix the line that generated the card, in the same PR.** Otherwise a later session re-files it.

**Cheapest structural fix, from TASK-310's builder:** *cite the file, not the line, unless the line
IS the point.* Its memory bullet carries no `file:line`, so there was nothing to get wrong. Two PRs
this session shipped precise-looking-but-wrong line refs into memory (#470's `:66-72` and `:35-44`
were both wrong; I preserved them once before checking).

---

## 5. ⚠ CORRECT THESE RULES FROM THE SESSION-5 HANDOFF

Three of its rules are wrong, and following them costs time or ships bad merges.

### 5.1 "Reviewers are slow and slow is not dead" — the premise is obsolete

**10 of 10 reviewers delivered this session** in the plain no-`name` shape: **6 min, ~7.7 min, ~8 min,
~40 min**. Not one hung. Session 5's elaborate retrieve-at-25/40/55-minute protocol was calibrated on
a **dispatch-shape bug** (TASK-268's named-teammate problem), not on reviewer latency.

**Replace with:** dispatch no-`name`; expect 6–40 min; `SendMessage` once if quiet past ~40 min.
Do not build a timeout ladder around it.

### 5.2 A silent reviewer is usually replying to the WRONG AGENT — three times this session

`ax-code-reviewer` **has no `SendMessage` tool.** When its builder waits for a reply, the reviewer's
final text goes **up to the orchestrator**, not across to the builder. Both sides then look hung and
neither is.

**Do:** tell every builder that if its reviewer goes quiet, it should say so in the handoff rather
than wait — *the orchestrator may already be holding the report*. And the orchestrator must **relay**
it. This happened on TASK-243, TASK-310 and TASK-316.

### 5.3 ⚠ Dispatch reviewers as STRICTLY READ-ONLY — this one caused real damage

TASK-316's reviewer ran `git checkout` in the **builder's shared worktree**, wrote the index, and the
builder's next commit swept it in. That produced **a red CI run with a phantom cause**, and the
builder came within one commit of committing a **fabricated root cause** ("vitest workers don't
inherit env") to `mistakes.md`.

On an epic about false claims in memory, **the tooling nearly authored a fresh one.**

**Do:** every review dispatch must say *"You are strictly read-only: `git show` / `git diff` /
`git log` only. Never `checkout`, `switch`, `stash`, `restore`, or `add`."* No dispatch template in
session 5 or 6 said this until the last one.

### 5.4 `gh`'s `mergeable` field can be STALE — use `git merge-tree`

PR #477 reported `mergeable=MERGEABLE state=CLEAN` and **the merge still failed** with "Pull Request
has merge conflicts." main had moved minutes earlier. Session 5's rule ("re-verify mergeability
immediately before every merge") is what I ran, and it was **not sufficient**.

**Do:** `git merge-tree --write-tree origin/main HEAD` — exit 0 emitting only a tree OID means zero
conflicts. It caught this correctly when the API field did not. (Credit: TASK-310's builder, who used
it to *avoid* rebasing a green branch for nothing.)

### 5.5 Also confirmed correct from session 5
- The **verbatim handoff line** works — every builder returned at PR-open.
- **`reviewer: clean` is the merge gate.** Held on all 11.
- **Re-read CI at the head the handoff names.** Still right, and still load-bearing.
- **Drop `--delete-branch`; push-delete separately.** Worked on all 11.

---

## 6. `.claude/memory/` conflicts: union is NOT always right

Two conflicts in the same file on the same night, with **opposite correct answers**:

- **#471 — NOT a pure append clash.** Both sides had edited the **same two bullets** in opposite
  directions: main still carried the stale "derive the deny rows" advice while the branch corrected
  it, and main carried #470's *correction* of the caller claim while the branch still carried the
  stale version. **"Keep both sides" would have reintroduced the exact falsehood #470 had just
  fixed.**
- **#477 (twice) — genuine append clashes.** Distinct cards appending rows to one list. Union correct.

**Mechanical test, now used:** union only if the two sides mention **disjoint TASK ids**. Overlap ⇒
same-row edit ⇒ stop and read. A resolver that halts on overlap is in the session log; port it.

Also: **`#470` introduced two precise-looking-but-wrong line refs** while fixing false claims. Verify
every `file:line` in resolved prose against source.

---

## 7. Infrastructure failures — three, and what each cost

| Failure | Blast radius | Cost |
|---|---|---|
| **Spend limit** (~00:00) | **all 4 live agents** | TASK-243 had already merged; TASK-311's builder died *after* opening its PR but *before* its reviewer returned |
| **Machine sleep** (~00:20) | 2 of 3 agents | TASK-310's branch was at the main tip with **zero commits** — nothing lost |
| **Session limit** (~01:40, resets 5:10am) | 2 builders | **TASK-262 died MID-REBASE** — see below |

**The expensive one.** TASK-262 died in a detached HEAD, stopped on a conflict, with **two round-two
commits still queued for replay**. Its reviewer had *just* returned CHANGES REQUESTED for exactly
that: *"the work you asked me to re-review is not on the current tip."* Merging then would have
shipped a **conflicted, round-one tree while everyone believed round two shipped** — and CI would
have gone green on it. The orchestrator finished the rebase as merge-queue duty.

**Both TASK-262 and TASK-312 died after being reviewed but before opening their PRs.** The
orchestrator opened #477 and #478.

**Carry forward into every dispatch:**
- **"Commit early and often."** An uncommitted worktree is lost work; a committed branch survives.
- **`pnpm install` then `pnpm build` BEFORE any package test in a fresh worktree** — `channel-web`
  produced **~40 spurious failures** purely from missing sibling `dist`.
- **The Bash tool's guard blocks heredocs** — use `Edit`/`Write`.
- **Do not `git stash`** — this repo has 4 pre-existing stashes and a builder popped one by accident.

---

## 8. Cards filed this session (TASK-310…318, all To Do, deps set)

**Nine cards, every one from a defect the drain uncovered — none from the plan.**

| Card | Why | Status |
|---|---|---|
| TASK-310 | The **documented** forward-learning loop silently no-ops under zsh | ✅ merged #474 |
| TASK-311 | The dedupe guard has zero coverage — the test that names it cannot fail | ✅ merged #473 |
| TASK-312 | `routines:recent-fires` still shipped the BIGSERIAL, with a live `key={f.id}` reader | ✅ merged #478 |
| TASK-316 | Three copies of `helmRepoSync` race on one helm index — **and the retry amplifies it** | ✅ merged #476 |
| **TASK-302** | 76 unbudgeted container teardowns + 7 routines setups (rescoped) | To Do |
| **TASK-313** | `FireNowOutput.fireId` renders as `Fired (#N)` — **ruling recorded, now spec** | To Do |
| **TASK-314** | 5 accuracy findings from #473 — **one hides a load-bearing stale-read guard** | To Do |
| **TASK-315** | A malformed id and a rate limit produce the same helper message | To Do |
| **TASK-317** | No CI image pre-pull, so a Docker Hub blip fails a suite | To Do |
| **TASK-318** | ~12 concurrent postgres on a 4-vCPU runner, no bound in 52 configs | To Do |

**TASK-302 was split**, because one card held three unrelated problems: a helm-index race (316), a
registry pull (317), a concurrency bound (318), and hook budgets (302). Its counts were also wrong —
"17 sites" is **76** teardowns across 13 packages — and **a budget change fixes none of the three
observed failures.** The rescoped card says so explicitly so nobody ships it claiming it cured flake.

**I retracted my own false evidence inside TASK-302's body.** I had logged the main-CI red as
"hook-budget-under-parallel-load of containers"; those hooks start **no container at all**.

---

## 9. Loose ends

- **TASK-313 is spec, not a question.** The ruling is folded into the card as `## Clarifications` and
  the needs-input block removed. Dispatch it like any card. It needs `ux-design` for final copy and
  `shadcn` if it adds a link affordance.
- **TASK-314's finding 1 is the one that matters** — a wrong mechanism in committed memory that hides
  the `readId` stale-read guard at `workspace-decisions.ts:162`. Someone believing the "React batches
  both into one commit" story could simplify that guard away and reintroduce a race.
- **Deferred, from TASK-316:** `deploy/charts/ax-next/tsconfig.json` is **not in the root
  `tsc --build` graph**, so `pnpm typecheck` never type-checks the chart test sources. Also the
  4-line `findHelm` helper is still duplicated across three chart test files. **Neither is carded.**
- **Deferred, from TASK-262's review (Minor, non-blocking):** the reach digest omits OAuth
  `authServerUrl` / `tokenUrl` / `clientId` / `clientSecretRef` and `ServiceDescriptor.healthcheck`,
  all of which `connectors:resolve` returns verbatim. Re-pointing a *pinned* `tokenUrl` under a stable
  `{slot,kind,server,scopes}` would not trip the guard. **The reviewer flagged that its severity is a
  product judgement it could not make: are pinned OAuth endpoints a supported, reach-relevant
  configuration, or effectively always DCR-derived? If the former, this is Important, not Minor.**
  **Not carded — needs that answer first.**
- **`pnpm lint` exits 0** (1 warning, down from 2). The stray `.claire/worktrees/` placeholder is
  still on disk but correctly ignored. **The three-session sweep-and-lose loop is closed.**
- Wave 6/7 remain in Backlog: 246, 248, 249, 250, 257, 258, 273, 242, 244, 263, 286.

- **⚠ The poller leaks processes across relaunches.** The loop re-launches
  `.claude/auto-ship-board-poll.sh` after every pass, and **nothing kills the predecessor**. Two were
  still polling GitHub on a 60s cadence hours after the drain finished — found only because the user
  asked about a stale agent entry. Each poll is ~1 GraphQL pt, so a long session silently multiplies
  its own idle cost. **Fix: `pkill -f auto-ship-board-poll.sh` before each relaunch, and once at run
  end.** Neither the skill nor this session's loop did either.
- **Repo clutter, not from this session: 168 stale remote `auto-ship/*` branches and 15 local.** All
  11 of this session's branches were push-deleted on merge (verified: 0 remain). These are the
  accumulated residue of earlier auto-ship runs whose merges did not delete the branch. Worth a
  deliberate sweep by a human — it is ~168 remote deletions and not something an orchestrator should
  do unilaterally.

---

## 10. How to resume

> Resume the agent-workspace follow-ups. Read
> `docs/plans/2026-08-24-agent-workspace-followups-session-6.md` first — it is the current handoff,
> and **§5 corrects three rules from the session-5 handoff that will cost you time if you follow
> them.** Run the read-only measurement pass before dispatching any builder (7 of 8 cards were wrong
> last session), but read §1 for its limit: a measurement can itself be wrong, and a measured card can
> still be wrong about the thing it is correcting. Hand every agent its card body as a **local file
> path**, never a board query. Dispatch reviewers **strictly read-only**. Use `git merge-tree`, not
> `gh`'s `mergeable` field, as the merge authority. **Before draining further, read §11 — the queue is
> not converging and the reason is structural.**

Journal: `.claude/auto-ship-log.md` (gitignored).

---

## 11. Why this epic is not converging — and what to do

**The numbers.** Session 6 merged **11** cards and filed **9**. Sessions 4 and 5 show the same shape.
The queue is not a fixed backlog being drained; it is a **generator**, and the drain is what runs it.

**This is not scope creep, and it is not agents inventing work.** Every one of the nine came from a
defect a builder or measurement *hit* while doing carded work: a documented loop that silently
no-ops, a guard with zero coverage, a race that a retry amplifies, a live `key={f.id}` reader on a
leak we were fixing next door. Refusing to file them would just mean losing them.

**The structural cause.** Three feedback loops each turn one card into more than one:

1. **Measurement finds the card is wrong** → the real defect is usually *larger* or *elsewhere*
   (TASK-243: 1 named comment that did not exist → 8 real ones; TASK-302: 1 card → 3 problems).
2. **Building touches neighbours** → the sibling leak, the vacuous sibling test, the false comment
   one line over.
3. **Documentation rot is self-propagating** → a stale line generates a card; fixing the code without
   fixing the line regenerates it later. Three cards this session came from stale lines.

Loop 3 is the only one that is *pure loss*. Loops 1 and 2 are the system working — finding true
defects — but they mean **"finish the epic" is the wrong frame** and any plan phrased as a fixed wave
list will keep being wrong.

### What would actually change the trajectory

**a) Attack loop 3 directly — it is the cheapest and it compounds.** Documentation rot generates
cards *and* corrupts the measurement pass that catches them. Concrete, in priority order:
- **Make the "fix the generating line" step non-optional.** It is currently a thing I asked for
  per-card. It should be in `yolo-ship`'s definition of done: *if a stale doc/memory line produced
  this card, fixing it is part of the card.*
- **Adopt "cite the file, not the line"** as a convention in `.claude/memory/` (TASK-310's builder).
  Every wrong `file:line` this session was in prose that did not need a line number.
- **Consider a guard for the highest-traffic claims.** The repo already has the pattern —
  `scripts/__tests__/` source-scan guards now cover eslint ignores, skill-doc shell hazards, and the
  runner/rail drift. A guard that asserts named symbols in memory files still exist would have caught
  TASK-241 and TASK-245 before they were ever filed.

**b) Stop treating the wave list as a plan.** Waves 6/7 were drawn up before ~20 cards existed. Pull
by *value class* instead — machinery-that-throttles-the-drain first (309, 310, 316 all paid for
themselves within hours), then correctness, then hygiene.

**c) Decide the actual exit condition.** "The board is empty" will not happen while the drain
generates. Better candidates, pick one: *no card whose severity is above hygiene*; or *the epic's
original acceptance walks pass and stay passing*; or a **time box** — drain N sessions, then close
the epic and let the remainder compete with everything else on the board.

**d) One thing NOT to do: stop filing.** The filing rate is the epic's instrumentation. Nine cards
were nine real defects, four of which merged the same session. Suppressing them would make the board
look convergent while the codebase was not.

**My recommendation:** take (a) — it is small, it is mostly convention plus one guard, and it is the
only loop that is pure waste. Then re-measure the file/merge ratio after one session. If it drops
below 1:1, the epic is genuinely converging. If it does not, the honest move is (c): time-box it.
