# agent-workspace follow-ups — session 5 handoff

**Written:** 2026-08-23, throughput-first drain.
**Supersedes:** `docs/plans/2026-08-23-agent-workspace-followups-session-4.md` for resuming.
Session 4 remains the best statement of *why* the measurement pass exists. **But correct two of its
facts before using it** — see §7.

---

## 0. What shipped

| Card | PR | What landed |
|---|---|---|
| TASK-255 | #461 | Time the request, not the test — unconfound the I8 timeout guard |
| TASK-288 | #462 | A 401 after boot signs you out instead of printing itself |
| TASK-298 | #463 | The auto-ship machinery regenerated its own bugs every run start |
| TASK-295 | #466 | Nine false comments measured, eight fixed — and one of them defined the convention |
| TASK-287 | #464 | A veto that refuses one file stops taking the whole tree with it |
| TASK-290 | #465 | One genuine register disagreement, not three — the rule, in `lib/read-register.ts` |

Also: **TASK-289 and TASK-291 rescoped** (not closed) after re-measuring against the merged 401 latch,
**TASK-296 unblocked** and re-scoped with TASK-290's two unmet obligations, and **nine new cards filed**
(TASK-299…307).

---

## 1. What this session did differently

Session 4 ended asking whether to drain Wave 4 as filed. **Ruled: throughput first.** TASK-246 and
TASK-248 were deferred to sit with Wave 6, because both justify themselves with *"once /workspace is
the default surface"* — which is Wave 6's job. The batch became TASK-298 + TASK-255 (the two that
throttle every future wave) plus five fold-ins.

**The measurement pass ran on 8 cards. SIX were wrong about their own bug.** That is 6/8 after 4/8 and
3/6. **The base rate is not improving, and it is not going to.** Budget the pass every time.

---

## 2. Human rulings made this session

- **TASK-289 — split by kind.** `expired` (a 401, where we KNOW the action is impossible) → card stays,
  controls disabled, explanation **at the controls**, not just the page banner. `failed` (we only know
  we could not CHECK) → card stays with controls **enabled**; a failed read is not evidence the write
  would fail, and disabling would assert knowledge we lack. Rejected: suppression (reintroduces the
  exact lie TASK-272/276 removed) and uniform disable (over-claims on `failed`).
- **TASK-288 — shape (a), scoped.** A new shared `lib/http.ts` for `transport.ts` + `workspace-api.ts`
  + the top chat surfaces. The ~40 admin/settings surfaces explicitly deferred (→ TASK-299). Rejected:
  monkey-patching `window.fetch` (global patch, and it fires on the setup wizard's legitimate 401s);
  rejected point fixes (subsume nothing).
- **TASK-288 — post-boot ONLY.** Boot already routes any thrown failure to `unauthenticated`,
  deliberately. The asymmetry is kept and **commented on purpose** so nobody "fixes" it.
  `auth-gate.test.tsx` untouched.
- **Sequencing — 288 before 291/289**, then re-measure rather than cancelling blind.

---

## 3. Cards corrected before building (the point of the pass)

| Card | What the card claimed | What was actually true |
|---|---|---|
| **TASK-255** | 5s budget is an oversight; four packages share a 10s hook budget | The 5s is a **deliberate guard** — `e4808547` lowered it 30s→5s *in the same diff* that added `validationTimeoutMs: 100`. Widening it deletes the guard. No shared budget exists; 50 independent vitest configs. **One file.** |
| **TASK-287** | MED; routine-file veto; "practically unrecoverable"; 6 line numbers | **HIGH.** Trigger is an agent writing **`CLAUDE.md`**. Unbounded across turns. Work IS reflog-reachable (`main@{1}`). **All 6 cited line numbers wrong.** |
| **TASK-288** | 2 surfaces; TodayView renders `{error}` | **9 surfaces + ~40 more.** The TodayView bullet quoted **TASK-276's own commit message as if it were the bug** — #453 had already fixed it. |
| **TASK-291** | The row "appears to hang" | **Nothing hangs** — the countdown is clock-driven. The poll runs while Undo is *offered*, not after it is pressed. The **bigger** defect was missed: the write path says "we could not reach the server" on a 401, when the server answered. |
| **TASK-295** | 2 false comments | **9.** Also: the code is right and is itself the cited convention (`tool-policy.ts:99-101` calls stderr *"the `materialize-uploads.ts` convention"*). |
| **TASK-296** | A third consumer of three | **One of eight sites across seven registers, three in the same file.** `toDecisionReadError` **is not exported.** Two kinds is not enough — the endpoint 404s. |
| **TASK-298** | 4 defects | **6+**, three misdiagnosed, one already fixed in TASK-268. The zsh bug is at lines **150/152**, not 147. |
| **TASK-290** | Three-way divergence; TASK-274 changes the register | Two registers over three files, already agreed on `expired`. **#456's retry never reached the two surfaces named** — the rationale is backwards. |

**TASK-290 was measured TWICE and the second pass corrected the first — including a rationale I had
written into the card myself.** Measurement is not one-and-done when the first pass is thin.

---

## 4. Traps found that would have shipped

1. **`TodayView.tsx:114` `readable = error === null` blanks the row list.** The obvious TASK-291 fix
   (`setError` from the poll) deletes the receipt and its live Undo button mid-countdown — violating
   the comment directly above it.
2. **`commit-notify-resync.ts:246` forwards `rejectionReason` only when `mode === 'hard'`.** Any
   TASK-287 fix moving the veto off `hard` **silently reverts TASK-240**.
3. **`TodayView.test.tsx:257-260` pins `failed` → destructive**, with a comment anticipating TASK-290
   and answering it the opposite way.
4. **TASK-296's existing test mocks a plain `Error`, not a `WorkspaceApiError`** — a card-faithful
   implementer writes a passing test that proves nothing about 401.
5. **Two `recoverable:false` branches** in `workspace-commit-notify.ts` (`:252` author-verify vs `:309`
   veto). Collapsing them breaks a genuine security case.

---

## 5. auto-ship's machinery — what was broken, what is fixed

TASK-298 shipped (PR #463) with the durable fix. **Its best idea was not on the card: it put TESTS on
the skill docs.** `scripts/__tests__/autoship-skill-shell-hazards.test.js` extracts the heredocs and
runs them; it fails 7 assertions against pre-fix main. **Skill docs that emit runnable code ARE code** —
four of the six defects were being regenerated from markdown at every run start, which is why patching
the generated copy never stuck.

Fixed live during the run, before the PR:
- **`set_needs_input` was MISSING from `.claude/auto-ship-progress.sh`.** The triage gate's Needs Input
  write would have silently no-op'd — a regression §8.3 records as having already happened once. The
  reference's own completeness guard catches this; **it just never runs automatically.** Make it a
  run-start fatal check.
- **`.claude/auto-ship-hb.sh`** — the heartbeat wrapper. **CALL it, do not `source` it.** Bash shebang,
  absolute helper path, exits nonzero and prints `HEARTBEAT-FAILED`. Proven from inside a worktree.
  ⚠️ The live copy predates the version documented in #463 — **regenerate it from §6 at next run start.**

**Defect 7, found the hard way:** the dispatch template routes every builder through
`gh project item-list` (~102 GraphQL points). Under *mandatory* 3-way parallelism that is ~306 points a
round on a 5000/hr budget shared with the poller, heartbeats and merge queue. **This run hit the limit
within a minute of dispatching three builders** and had to redirect all three mid-flight to local
files. **Hand builders their card body as a local file path. Never a board query.**

---

## 6. Process that earned its keep (carry forward)

- **The verbatim handoff line works.** 4 of 4 builders returned at PR-open this session. Keep it:
  *"Return your handoff as soon as the PR is open and reviewed — report `ci: pending`. I own the merge
  gate. Do NOT sit waiting on CI."*
- **`reviewer: clean` is the merge gate.** Held on all four.
- **Late ≠ hung, now measured 3×.** TASK-255's reviewer returned at **~46 min**; its builder had
  already called it hung and corrected itself. Retrieve via `SendMessage` before ever declaring hung.
- **Re-verify mergeability immediately before every merge.** Did so on all three; none had gone stale
  this run (the serialized queue plus small diffs), but the cost is one call.
- **Drop `--delete-branch`; push-delete separately.** Worked cleanly on both merges.
- **Measurement agents go idle without delivering.** 6 of 8 did. **Always `SendMessage` to retrieve
  before assuming failure** — every one of them had a full report written. One never delivered at all
  and I measured that card myself rather than build unmeasured.

---

## 7. CORRECT THESE TWO FACTS from the session-4 handoff

1. **"Count the checks: 11 on this repo."** ❌ **It is 9.** Verified across #460, #461, #462, #463.
   Applying the 11-rule literally blocks every merge waiting for two checks that do not exist.
2. **"`gh project item-list` needs `--limit 700` (board is at 319 items)."** Still true and now at
   ~326 — **but the tracked reference `github-project.md:134,:172` still says `--limit 200`**, and its
   guard only checks `length > 0`, so a truncated board reads as healthy. Fixed in #463.

Also: **TASK-255 IS tagged `epic: agent-workspace`** (body line 1). Session 4 lists that as an open
loose end; it is not.

---

## 8. Cards filed this session (TASK-299…306, all Backlog, deps set + verified by re-read)

| Card | Why |
|---|---|
| **TASK-299** | The ~40 admin/settings surfaces — TASK-288's deliberately deferred half. **Per-surface judgement, not a sed**: several show `err.message` as their only diagnostic. |
| **TASK-300** | `title-events.ts:38-58` — a 401 throws, a bare `catch` swallows it, and it **reconnects forever**. A signed-out tab is an endless authenticated-SSE storm. A known, accepted consequence of choosing shape (a) over the global fetch patch. |
| **TASK-301** | **`SessionRow.tsx:157-161` — a 401 DELETE reads as SUCCESS.** Integrity, not cosmetics. Plus the rest of the silent-on-401 group. |
| **TASK-302** | The unbudgeted hooks are the **teardowns** (17 `afterAll` sites on vitest's 10s default), not the setups. **Cost bounding container concurrency first** — there is none anywhere in 50 configs. |
| **TASK-303** | `FirstRunAutoCreate.test.tsx:33` — a test whose name asserts coverage it does not have; `rerender` with identical props never re-runs the effect. **Do not delete the `ran` ref** — it is live under Fast Refresh. |
| **TASK-304** | `FilesError` has no `expired` kind → the Files tab offers a Try again that can never work on expiry. Also `AgentFiles.tsx:137-139` **already prints `detail`** despite its own type's header saying `detail` is for logs. |
| **TASK-305** | `AgentMemory.tsx:191` and `AgentRail.tsx:342` splice raw paths **into authored sentences** — worse than TASK-296's target, carded by nobody. |
| **TASK-306** | A deferred irreversible action's **`done` receipt is claimed by the local clock** (`decision-copy.ts:256-260`), with no confirmation the host executed. A "done" claim made by a timer. |

---

## 9. Loose ends

- **Stale worktrees: SWEPT.** All 15 removed at session end (3 from session 3, 7 from this run, 5 older
  feature worktrees). `git worktree list` is now just `main`. Deferred to session end deliberately —
  removing them mid-run touches shared `.git/worktrees` metadata while builders are live. Note two
  things: "commits not on main" is a **squash-merge artifact**, not unmerged work; and **single
  `--force` is not enough** — one worktree was harness-locked and needs `remove -f -f` (TASK-298
  defect 5), which fails *silently* while the surrounding block reports success.
- **`pnpm lint` is STILL not green, and sweeping cannot fix it — filed as TASK-309.** After every
  registered worktree was gone, lint still exited 1 on a single stray placeholder file under
  **`.claire/worktrees/`** (note `.claire`, not `.claude`) — dated May, gitignored, *not a git repo and
  not a registered worktree*, so `git worktree list` never showed it and no sweep could find it. The
  real defect is structural: **`eslint.config.mjs:112-124` does not ignore worktree copies**, so every
  agent worktree gets linted and dispatch is *mandatorily* worktree-isolated. Three sessions have each
  swept worktrees to get lint green and each sweep was undone by the next dispatch. One glob
  (`'**/worktrees/**'`) ends the loop.
- **`.claude/auto-ship-hb.sh` in the main checkout is older than #463's documented version** —
  regenerate from §6 next run start.
- **TASK-289 / TASK-291** were held behind TASK-288 and re-measured after it merged. Watch the
  asymmetry: only their **`expired`** halves depend on the 401 latch. A `failed` read does not sign
  anyone out, so those halves may survive independently — **rescope rather than close.**
- **TASK-246 / TASK-248** deferred to Wave 6 by ruling, not forgotten.
- **Wave 5/6/7 membership** is unchanged from session 4 §4 — but every one of those cards should be
  assumed wrong about its own bug until measured. The rate is 6/8.

---

## 10. How to resume

> Resume the agent-workspace follow-ups. Read
> `docs/plans/2026-08-23-agent-workspace-followups-session-5.md` first — it is the current handoff.
> **Run the read-only measurement pass before dispatching any builder**: 6 of 8 cards were wrong about
> their own bug last session, after 4/8 and 3/6. Hand each measurement agent and each builder its card
> body as a **local file path**, never `gh project item-list` (~102pt × 3 builders exhausts the GraphQL
> budget in one round). §7 corrects two stale facts from the session-4 handoff — the repo runs **9** CI
> checks, not 11.

Journal: `.claude/auto-ship-log.md` (gitignored).

---

## 11. The two bugs TASK-287's builder found IN ITS OWN FIX

Both self-caught, one independently reproduced by the reviewer with the same remedy. Neither was on
the card, and the first is a **security-relevant near-miss**.

1. **"Discard" is not "delete".** A refused *edit* to a baseline-tracked file must be **RESTORED from
   baseline**, not removed — otherwise the next `git add -A` stages a **deletion**. And
   `@ax/validator-identity` **ALLOWS deleting `.ax/BOOTSTRAP.md`** (that delete is how bootstrap
   completes). So a per-path discard implemented as `rm` would have let a **refused write silently
   graduate the agent** — the veto would have accomplished the thing it was refusing.
   **Generalisable lesson: a path-scoped rollback has two cases, not one — "was tracked at baseline"
   (restore it) and "is new this turn" (remove it) — and getting them backwards can be a privilege
   change, not just data loss.**
2. **`git checkout` exit codes are not a boolean.** Exit **1** means "unmatched pathspec"; **128**
   means an unknown error. Reading `!== 0` as "not in baseline" **silently deletes baseline files on
   error paths.** Both ends now fail closed to whole-tree `--hard`.

Also confirmed: the wedge rationale **never needed the transcript at all**, and the false-comment count
on this epic is **15, not 11** — the figure the card's own acceptance bullet carried.

---

## 12. A merge-gate trap worth adding to the checklist

**Re-read CI at the head the handoff names, not at the head you last looked at.**
**This happened TWICE in one session.** PR #464 showed 9/9 green while its builder was still working;
when the handoff arrived its `headSha` was a *different* commit (review fixes pushed after that pass)
and CI was 6-pending again. Then PR #465 read 9/9 green, and while I was waiting for its handoff the
head moved `1dd4af53` → `eed5aaa1` and CI reset to 4 pending. Merging on either earlier reading would
have shipped an unverified head with a green-looking record.

**A green reading is only valid for the head it was taken at, and a builder that has not handed off yet
is still pushing.** Make the CI watcher head-aware: capture `headRefOid` alongside the checks and treat
a head change as voiding every earlier pass.

The existing rule ("re-verify mergeability immediately before merge") does not cover this on its own —
`mergeable` was `MERGEABLE` throughout. **Compare the handoff's `headSha` against
`gh pr view --json headRefOid` and re-read the checks.**

---

## 13. The reviewer deadline is badly miscalibrated — five measurements now

TASK-298 fixed the *wording* (retrieve before declaring hung). The **numbers are still wrong**, and the
stale "successful passes land in 13–17 min" baseline is what makes 25 minutes look generous.

Measured this session:
| Card | Reviewer behaviour |
|---|---|
| TASK-255 | returned at **~46 min**; its builder had already called it hung and corrected itself |
| TASK-295 | returned at **~7.7 min** (the fast end is real) |
| TASK-290 | returned **CHANGES REQUESTED, 6 findings, 2 Important** — after the builder had prematurely reported `reviewer: clean` |
| TASK-296 | **two** reviewers, both **60–90 min**; the builder re-dispatched one at 60 min that was simply still working |
| TASK-287 | returned clean, and independently reproduced a bug the builder had self-caught |

**Replace the baseline with: work 4–15 min, delivery observed 8–90 min. Latency is not a hang.** A
reviewer's transcript going flat for 20–40 minutes mid-work is **not** a liveness signal — TASK-296's
builder learned that the expensive way. `SendMessage` genuinely does wake them.

**And a new rule the gate needs:** `reviewer: clean` from a builder can summarise **two reviewers who
disagreed**. TASK-296's did — reviewer #1 returned CHANGES REQUESTED over a real defect, the fix landed,
and **no reviewer ever saw the merge head**. The builder disclosed this unprompted, which is the only
reason it was caught. **Ask: did a reviewer see THIS head?** If the answer is no, dispatch an
independent pass — that is what the orchestrator's own review gate is for.

---

## 14. TASK-296 — a fix that deleted a documented channel

Worth keeping because it is the inverse of the usual failure. The builder's first pass **removed
`SseFrame.detail` from a turn-error alert**, asserting in a comment that it was "arbitrary plumbing."
`packages/channel-web/src/server/types.ts` says the opposite: TASK-160's `detail` is a **bounded,
sanitized line that is meant to be rendered.** It also mis-enumerated the `onError` producers, so a 503
lost its actionable sentence.

The real leak was one line away — `frame.error`, a raw reason code (`dev-service-failed`) printed
verbatim — and `transport.ts` had owned an `ERROR_LABELS` table for it since Fault A.

**Lesson: "this looks like plumbing, delete it" is the same error as "this comment looks right, trust
it."** Both skip reading the contract. Before removing a rendered field, find the type that defines it
and read what it promises.

Also note the card's own headline had gone stale within hours: **TASK-288 had already removed the raw
strings from 2 of its 3 sites.** The real work was TASK-290's two unmet obligations. Same-session cards
invalidate each other — re-measure a card whose siblings merged after it was written.

---

## 15. Final state

`main` @ `8689edd2`. **7 of 7 cards drained, all reviewer-clean, every merge onto a green main.**
All lanes empty except Backlog. 0 open PRs. 0 worktrees. 0 in flight, 0 parked.

**Cards filed this session:** TASK-299…309 (11). All Backlog, deps set, verified by re-read.
**Cards rescoped rather than closed:** TASK-289, TASK-291 — both had a half that survived TASK-288.

**Remaining waves** are unchanged from session 4 §4 (Wave 5: 245/251/241/243/262/269; Wave 6: 249/250/
258/257/273 + the deferred 246/248; Wave 7: 242/263/244/286). **Assume every one of them is wrong about
its own bug until measured — the rate is 6/8.**
