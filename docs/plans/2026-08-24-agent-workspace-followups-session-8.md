# agent-workspace follow-ups — session 8 handoff

**Written:** 2026-08-24, after executing the session-7 handoff's §10 resume instruction.
**Supersedes:** `docs/plans/2026-08-24-agent-workspace-followups-session-7.md` for resuming.
Session 6 remains the best statement of the *dispatch discipline* (its §5 and §7). Session 7's §2 —
*measure the card's prescription, not just its diagnosis* — was the method this session executed, and it
held. **§1 below records the layer underneath it, which did not.**

---

## 0. What shipped

`main` @ `e0112f94`. **6 PRs merged, 7 cards closed, 1 card filed, 0 open PRs, `pnpm lint` emits
NOTHING**, `pnpm test:scripts` **140 tests across 11 files** (was 138/11).

| Card | PR | What actually landed |
|---|---|---|
| TASK-322 | #487 | card's premise measured FALSE; fixed the one real leak its grep could not see |
| TASK-320 | #486 | both mutation claims now actually executed; a 2nd uncited copy corrected |
| TASK-319 | #485 | reach digest sees where a credential *points*; **a vacuous test caught pre-merge** |
| TASK-321 | #488 | closed analysed-not-built; the card's Invariant-2 *reason* corrected |
| TASK-313 | #489 | row id gone; the human ruling superseded mid-session |
| TASK-302 + TASK-318 | #490 | closed analysed-not-built, one PR, two cards |
| TASK-323 | — | **filed**: the timeout remedy 302 and 318 both converged on |

Every merge: `merge-tree` as the authority, head verified against the head the handoff named,
`reviewer: clean` from an *actually returned* review, and the push-to-main full suite green before the
next merge.

---

## 1. ⚠ THE MEASUREMENT PASS IS ITSELF AN UNMEASURED CLAIM — and the orchestrator was the worst offender

Session 7 §2 was right that a card's *prescription* needs measuring. This session found the layer
beneath it: **the measurement's own output is an unmeasured claim, and briefing a builder from it
launders it with the orchestrator's authority.**

**I authored two false claims this session. Builders caught both.**

1. **TASK-321.** The measurement asserted a shared constant would force the CI pull-list guard to
   become a *"cross-package constant resolver (monorepo path mapping, re-export chains)"*. I put that
   in the brief as the load-bearing reason to close. **False**: the guard text-scans
   `SOURCE_ROOTS = ['packages','presets']` and `packages/test-harness/src/index.ts` is *inside* that
   corpus, so no resolution is needed. The builder's first draft repeated my error; **both its
   reviewers caught it independently.**
2. **TASK-302/318.** My reconciliation's leg 3 claimed the 57P01 swallow in
   `packages/test-harness/src/stop-postgres-container.ts` "hides the only symptom this class
   produces". **False**, and I had already written it onto the TASK-323 card. Verified after the
   refutation: the file has `try`/`finally` with **no `catch` anywhere**; the handlers swallow *only*
   the benign 57P01 shape and re-emit everything else; and a *hang* is a hook timeout no exception
   listener can observe. Not a defect. **The taxonomy is two shapes, not three.** The card body was
   corrected in place, struck through rather than deleted.

**Both were INFERRED cost/impact judgements, never probe results.** That is the pattern.

Three more instances, none mine:
- **A measurement corrected a prior measurement.** TASK-302's card claimed 7 unbudgeted routines
  setups; all 7 carry an explicit `}, 120_000)` — verified at `main` *and* at the exact commit the
  card measured. The earlier pass read the `beforeAll(` line and never reached the trailing argument.
  **Grep a hook's CLOSING line, not its opening one.**
- **The 302/318 passes contradicted each other** on mask-vs-fix. Neither was simply wrong.
- **Both serialisation cost estimates were wrong.** Original "+15 min"; I "corrected" it to "+4–8";
  the measured answer is **~+9 min** (realised parallelism 2.31×). I replaced a wrong number with a
  differently-wrong number and stated it more confidently.

**Rules for the next plan:**
1. **Mark every brief claim `MEASURED-BY-PROBE` or `INFERRED`.** I marked none, and both false ones
   were inferred.
2. **Tell every builder it may refute the brief.** Five agents refuted a handed-down claim this
   session and **every one was right**.
3. **Cost and impact estimates are the weakest measurement output.** A probe settles behaviour;
   nothing settles "how much work is that" except attempting it. Treat every such figure as a
   hypothesis until a second pass re-derives it.
4. **When prose states a ratio AND its inputs, the ratio is the claim most likely to be wrong** —
   nothing recomputes it. #490 quoted its own numerator and denominator two sentences from a headline
   that disagreed with them (`2.32×` vs the correct `2.31×`).

---

## 2. ⚠ THE CI GATE IS BROKEN IN A WAY CONCLUSIONS CANNOT DETECT

**Controlled A/B on one branch**, TASK-313:

| head | checks reported | includes `test`? |
|---|---|---|
| original push | 6 — all CodeQL/Analyze | **no** |
| rebase push | 11 | yes |

`ci.yml` triggers on `pull_request` to `main` and ran normally for other `auto-ship/*` branches the
same day, so this is **nondeterministic run creation**, not misconfiguration. The earlier head
"would have merged on security scans alone" — its build and tests **never executed**.

**Any gate that reads conclusions returns TRUE on that head.** "Are all reported checks SUCCESS?" is
`true` when nothing ran.

**The gate must assert the run EXISTS before reading any conclusion:**
```bash
gh run list --workflow ci.yml --commit "$HEAD" --limit 3 --json status,conclusion
# empty result ⇒ NOT green, regardless of what the rollup says
```
Known remedy: a rebase push. Ruled out: "small or prose-only diffs skip CI" — a **memory-only** commit
did trigger a run, and the trap did not recur on any of the three pushes after the original.

Two siblings, both hit today:
- **An empty conclusion is PENDING, not success.** (Nearly bit #485.)
- **CI status reads flapped in both directions for 15+ minutes**, and a **stale watcher reported green
  for a superseded head**. Settle with several consecutive reads of *specific run ids*.

---

## 3. The independent-review gate paid for itself, decisively, once

TASK-319's builder died to a session limit *after* its reviewer returned. All that survived was a
relayed "APPROVE" fragment. The gate says: no verified `reviewer: clean` ⇒ the orchestrator orders its
own pass. It returned **CHANGES REQUESTED** on a **vacuous test**.

The PR hardened `[...healthcheck.command]` into an `Array.isArray` guard and "proved" it with
`command: 'not-an-array'` — **a string, and strings are iterable**. `[...'not-an-array']` yields a char
array and never throws, so both assertions passed **with and without the fix**, and the comment
described a demonstration the test never performed. Reproduced in `node` before acting.

Same class as TASK-311's "dedupe test that provably could not fail": **a check that cannot fail,
wearing the costume of a guard** — on a security rail. The first reviewer was not lazy; it verified
eight focus areas correctly. It simply never asked whether its own nit's test could fail.

**The transferable fix is one sentence in the dispatch.** After #485 every review dispatch carried
*"ask whether any new test could pass against the unfixed code."* TASK-313's reviewer then tabulated
**every** new assertion against old code, found six genuinely red, and correctly classified a seventh
as a behaviour-*preservation* guard — then checked whether the builder had misrepresented it (it had
not). Same reviewer type, same tier. The difference was **asking**.

**Corollary: a round-trip test cannot detect an ADDED field.** `z.object` strips silently, so "it
round-trips" proves nothing about absence — only a negative-space assertion does. That is why #489's
strip guard was *extended* rather than retired.

---

## 4. Delivery is the DEFAULT failure mode, not an exception

**6 of 7 agents completed real work and delivered no conforming handoff on the first try.** With
session 7's 4 of 4, that is **10 of 11 across two sessions**. Shapes seen:

- a status line only ("Waiting on CI.", "PR #487 is open and CI is running")
- died mid-delivery (session limit) with the work complete and the PR already open
- **reviewer text routed UP to the orchestrator** instead of across to its builder — twice; one
  reviewer said so explicitly (*"I have no SendMessage tool… this is my channel back"*)

**Every one delivered in full on ONE `SendMessage` naming the fields. Never re-dispatch** — the work
is done; only delivery failed.

**Budget one retrieval round per card as normal cost**, and expect to relay a reviewer's report at
least once per wave. Ask with the *field list*, not "please report".

---

## 5. Cards are now more often wrong about MEANING than about FACT

| Card | Diagnosis | What was actually wrong |
|---|---|---|
| TASK-322 | **wrong** | premise collapsed; the real leak was in a shape its grep could not match |
| TASK-313 | partly-wrong | ruling's *rationale* false — would have told users a **failed** fire was **silenced** |
| TASK-302 | partly-wrong | **acceptance criterion self-contradictory** (see below) |
| TASK-318 | partly-wrong | "no bound anywhere" false — the bound is `pnpm` 4 × vitest 3 = **12**, undocumented not absent |
| TASK-321 | **exactly right** | counts verified to the unit; the *reason* to close was wrong |
| TASK-320 | correct | contingency branch dead; a 2nd uncited copy it never named |
| TASK-319 | correct | headline field (`tokenUrl`) is **read nowhere at runtime** |

**TASK-302 is a new class.** Not a false diagnosis, not a false prescription: a **self-contradictory
acceptance criterion**. Adding an explicit 30s budget *loosens* the 73 hooks currently inheriting the
10s default — making the suite more tolerant of the very hang the card exists to prevent — while
*tightening* the 30 on 60–120s configs. A 103-file diff that moves things the wrong way in both
directions.

This is a **cheaper** error class than "this hook has no callers", which argues the epic is
converging. But it is only cheap **if measured** — shipped unmeasured, a wrong rationale is exactly
what gets re-filed.

---

## 6. A human ruling can be unimplementable, and only downstream work finds out

TASK-313's ruling: "drop `fireId`, **surface `conversationId`**". Measurement found `conversationId`
has **no consumer above the bus**, and its only possible surface — a conversation link — is forbidden
by an in-repo Phase-D decision (routine conversations are `hidden:true`, per-fire transcripts are not
persisted, so a link lands on an empty conversation). The ruling's second half was **unimplementable**.

Escalated. The human ruled: **drop the field too.** `FireNowOutput` narrows to `{ status }`, and the
deliverable is restated as *"stop showing a database row id"*, not *"show a different id"*.

**Rule: when a ruling's conclusion survives but its rationale does not, re-escalate rather than
implement the conclusion literally.** The rationale is usually load-bearing on scope.

---

## 7. The ratio, honestly

**6 merged / 7 cards closed, 1 filed.** Nominally ~0.14 : 1, far below session 7's 0.8 : 1.

**Do not read that as convergence on its own.** Four of the seven cards **did not build what they
asked for** — TASK-321 and TASK-302/318 closed as analysed-not-built, TASK-322 built something else,
TASK-313 shipped a superseded ruling. A merge count scores those identically to a feature. They *are*
wins — a false premise removed from the board is worth more than a feature — but a metric that cannot
distinguish "shipped the asked-for thing" from "proved the ask was wrong" will read *converging* on a
session where most cards were wrong about themselves.

**TASK-323 is the honest counterweight:** two cards closed and pointed at a *third* piece of real work
neither of them described.

**Recommendation: this is the point to stop running dedicated sessions.** Two sessions now agree the
drain generates far less than it consumes, and the remaining lane is one card. Take §11(c) of session
7 and **time-box it**: let TASK-323 and the Backlog waves compete with everything else on the board.
The measurement discipline (§1) and the CI gate (§2) are the durable outputs — they belong in
`auto-ship`/`yolo-ship` and CLAUDE.md, not in a ninth follow-up session.

---

## 8. What survived from sessions 6 and 7, unchanged

- **`reviewer: clean` is the merge gate**, and *no verified field ⇒ order your own pass*. Vindicated (§3).
- **`git merge-tree --write-tree origin/main HEAD`, not `gh`'s `mergeable`.** Authority **3×** this
  session, including one `mergeable=UNKNOWN` that was actually a real conflict.
- **Re-read CI at the head the handoff names.** Every merge verified head-match. **Now insufficient
  alone** — see §2.
- **Drop `--delete-branch`; push-delete separately.** Worked on all 6.
- **Dispatch reviewers STRICTLY READ-ONLY**, verbatim sentence. No reviewer touched a builder's tree.
- **Hand every agent its card body as a local file path.** No builder queried the board.
- **`.claude/memory` union rule: union only on DISJOINT TASK ids.** Applied 4×, correctly. One case
  needed real care: TASK-313 *modified a row in place* (annotating TASK-251 as done) rather than only
  appending, so "append-vs-append" had to be verified, not assumed.
- **`pnpm install` + `pnpm build` before any package test in a fresh worktree.**
- **Commit early and often** — again the reason a session-limit death lost nothing.
- **The `--limit` trap:** board reads need ≥ 700.

### New mechanical notes
- **Launch the poller as `exec <script>` under `run_in_background`, never `nohup … &`.** The detached
  form leaked processes **and silently broke the wake**: the poller's *exit* is the board-change
  signal, so a detached poller polls forever and can never re-invoke the loop. Reap at run end
  (`pgrep -fl auto-ship-board-poll.sh` ⇒ **0**).
- **`pnpm -r run test` BAILS at the first failing package**, so later packages never run — use
  `--no-bail` or the repo-wide gate is silently partial. (Compounds the known `--filter`-order trap,
  in the opposite direction.)
- **Bare filenames cited in `.claude/memory` get ZERO guard coverage** — `memory-cited-paths-exist.test.js`
  resolves only **rooted** paths. Proved by breaking one.
- **Every count in memory prose must carry its scope.** An unscoped repo-wide count that includes
  `.claude/memory/` is self-inflating: writing the row moves the number.
- **A transient experiment count is strictly worse than a stale line index** — a line index can at
  least be checked against the tree; "reddened alongside 7 other assertions" can never be re-derived.
- `gh run list` takes `--commit`, not `--arg`.
- Harness-locked worktrees need `git worktree remove -f -f` (one `-f` exits 128).

---

## 9. Loose ends

- **Branch residue is still a human's call** — ~290 deletions across remote `auto-ship/*`, local
  `auto-ship/*`, and local `worktree-agent-*`. All 6 of this session's branches were push-deleted.
- **TASK-323 is filed, deps `none`, unstarted** — deliberately held rather than opening a fourth front
  late in a long session. Its body carries the corrected 57P01 note and two predecessor-learning
  bullets (the real remedy, and six counts to re-derive rather than trust).
- **Two figures in #490 remain unverified by any reviewer**, both honestly labelled in-tree: the
  PR-run range `1:12–5:16` (the second pass hit API rate-limiting) and the `+8.9 / +10.5 min`
  serialisation **model** (labelled a model, not a measurement, and bracketed by two verified figures).
- **The 57P01 swallow is NOT a defect** — deliberately not carded. See §1.
- **Still deferred from TASK-316, still not carded:** `deploy/charts/ax-next/tsconfig.json` is outside
  the root `tsc --build` graph, and a 4-line `findHelm` helper is duplicated across three chart tests.
- **`packages/test-harness` has no `testTimeout` override** and produced the only 2 timeout failures in
  100 main runs, both `Test timed out in 5000ms`. Not carded; note for TASK-323's builder.

---

## 10. How to resume

> Resume the agent-workspace follow-ups. Read
> `docs/plans/2026-08-24-agent-workspace-followups-session-8.md` first — it is the current handoff.
> **§1 is the method change: the measurement pass is itself an unmeasured claim.** Mark every brief
> claim `MEASURED-BY-PROBE` or `INFERRED`, and tell every builder it may refute the brief — five did
> this session and all five were right, including two false claims the orchestrator itself authored.
> **§2 is the most dangerous finding: assert the `ci.yml` run EXISTS for a head before reading any
> check conclusion** — CI created no run at all for one branch and its CodeQL-only checks read as
> green. **§3** is why the independent-review gate stays. **§4: expect to ask every agent once for its
> handoff; that is normal cost.** **Before draining further, read §7 — the recommendation is to stop
> running dedicated sessions and time-box the remainder.**

Journal: `.claude/auto-ship-log.md` (gitignored).

---

## 11. Board state at handoff

**To Do (1, deps `none`, ready):** TASK-323 — give the 73 bare teardowns the budget their own file's
`beforeAll` already declares, and replace the fixed-iteration `200 × 10ms` poll in
`packages/auth-better/src/__tests__/init-awaits-adapter.test.ts` with a time-based wait. **Do not
apply the card's original 30s figure** (§5).

**In Progress / In Review / Needs Input:** none. **Open PRs:** none.

**Waves 6/7 remain in Backlog:** 246, 248, 249, 250, 257, 258, 273, 242, 244, 263, 286.
