# agent-workspace follow-ups — session 2 handoff

**Written:** 2026-08-22, end of the Wave-1 run.
**Supersedes:** `docs/plans/2026-08-22-agent-workspace-followups.md` — that document is
still the best description of Waves 2–7, but **three of its claims are now known wrong**.
See §2 before trusting it.

**Repo state at handoff:** `main` @ `1723c5b6`, CI green, **0 open PRs**, To Do lane
**empty**, 0 in-flight, 0 parked. Fully quiesced — safe to resume cold.

---

## 1. What shipped this session

| Card | PR | What landed |
|---|---|---|
| TASK-247 | #440 | A hung `ax-code-reviewer` now fails **loudly** — 25-min deadline, one fresh re-dispatch, required `reviewer:` handoff field, blocking merge gate in auto-ship |
| TASK-259 | #441 | Undo disappears when the call is **consumed**, not when the clock runs out — always-mounted `GET /decisions/:decisionId` + a bounded poll with a race guard |
| TASK-260 | #442 | A hold no longer renders as a **failure** on claude-sdk — `is_error` omitted, host-authored copy, `dec_` stripped at source, `mcp__` stripped at both display sites, misleading `DONE` badge deleted |
| TASK-261 | #443 | `ApprovalCard` renders in-thread on the default **`/`** surface, **unflagged** — plus two render-phase crash fixes and an `aria-live` fix |

**18 merges, 18 clean `main` backstops, 0 parked.**

Both acceptance walks ran against `kind-ax-next-dev`. **All three Wave-1 fixes verified
working in a real browser.** Both walks nonetheless ended `walk-fail` on *new* defects —
see §3.

---

## 2. Corrections to the previous handoff doc — read this first

### 2.1 Invariant #3 does NOT hold for the epic

The old doc §1 states:

> Both half-wired windows are **closed** (`tool-policy:list-capabilities`,
> `agent-activity:get`), so CLAUDE.md invariant #3 holds for the epic.

**It does not.** There is a **third** half-wire, documented in the preset wiring but never
counted: **`decisions:executed` is fired at `packages/decisions/src/replay.ts:255` and
subscribed to by nothing** (verified by grep across `packages`, excluding tests).
`ActivityEvent.decisionId` exists and is **always null**, so an approved-and-replayed
decision produces **no Activity receipt at all**.

Filed as **TASK-279**. Anyone reading the old doc to judge whether the epic is
invariant-clean would be misled.

### 2.2 TASK-247's root cause was wrong — the reviewer never hung

The old doc §3.2 attributes the 6-of-6 reviewer failures to nesting depth / parent-session
state, and calls the lead "corrected". It is still wrong.

**The reviewer never hung. Its findings had nowhere to go.** Confirmed mid-run with the
prediction recorded *before* the test: a reviewer presenting exactly as "hung — idle, no
findings, builder blocked on a deadline" returned a **complete review instantly** when
asked to deliver it through the message channel. The review had existed the whole time.

Mechanism: an agent spawned as a **named teammate** (`Agent(name: X)` with no `isolation`)
does not have its plain final text delivered to its parent — it must call `SendMessage`.
Agents spawned as **background async tasks** (e.g. with `isolation: "worktree"`) return
normally. That explains the one thing the size/context theory never could: why the *same*
agent on the *same* diffs returned in 13–17 min for the orchestrator and "hung" for
builders.

The old doc's "hung on 6 large cards, returned on 2 smaller/backend ones" size correlation
is an **artifact** — the large cards happened to have builders dispatching in the teammate
shape.

Filed as **TASK-268**, with the remedy that worked, verbatim from the builder that found
it independently: *instruct each subagent to reply via `SendMessage` to the from-address,
then send it one message so it has that address.* The second half is load-bearing.

**Do not revert #440's deadline protocol** — it is what made this run handle the failure
gracefully instead of silently self-reviewing. TASK-268 sharpens it; it does not undo it.

### 2.3 TASK-255 is a broader card than filed

The old doc scopes it to `@ax/auth-better` + the `model-route.test.ts:365` 5s budget.
This run added **three more** failing packages, and **two distinct mechanisms**:

- **Testcontainer 10s setup-hook budget** under concurrent container startup —
  `@ax/mcp-oauth`, `@ax/attachments` (both pass in isolation; CI green).
- **Socket contention** — `mock/admin-teams` failing with `TypeError: fetch failed` /
  `ECONNRESET` on a loopback socket, not an assertion.

A fix scoped to one package, or to the hook budget alone, will not hold. Both mechanisms
are appended to the card body.

---

## 3. New cards filed this session (TASK-268 … TASK-280)

All 13 are in **Backlog**, deps `none` unless noted, **none dispatched**.

### From the walks — do these first

| Card | Sev | Why |
|---|---|---|
| **TASK-277** | **HIGH** | **Approving an attended decision after the idle floor expires is a silent no-op.** `decisions/src/plugin.ts:414` reads `attended` from attendance captured **at hold time and never revisited**, so a decision whose session has ended still counts as attended. It writes `status=executed`, schedules **no replay**, and `deliverResolution`'s no-session return is **discarded**. The row reads executed, the call never runs, nothing tells the user. Contradicts design §3.3 and `delivery.ts`'s own comment. **TASK-237 proved the unattended replay path works**, so this is purely a routing bug with a sound target — decide attended-vs-replay from a **live session lookup at approve time**. |
| **TASK-279** | HIGH-ish | `decisions:executed` has **no subscriber** → no Activity receipt ever exists → undo's `outcome:'retracted'` fires onto nothing. The invariant-#3 miss from §2.1. Wire it or delete the fire. |
| TASK-278 | MED | The post-approval **continuation turn never renders live** — the client polls the decision row but opens no `/api/chat/stream/<reqId>`, so it runs with no SSE consumer while the copy promises "we can carry straight on". |
| TASK-280 | design | **Undo is refused once `replayedAt` is set**, so only `approved-pending-agent` rows are ever undoable and a reversible *host* tool's undo window is unreachable. Interacts with TASK-259. Needs a human ruling: is that intended? |

**TASK-236** is re-gated on `TASK-277`; **TASK-237** on `TASK-279`.

### Only TWO of these thirteen block anything

Checked against the walk cards' actual acceptance criteria, not assumed:

| Card | Blocks? | Why |
|---|---|---|
| **TASK-277** | **Yes** — gates TASK-236 | Fails *"approving re-issues the call and it executes exactly once"* — in the idle-expired case it does not execute at all |
| **TASK-279** | **Yes** — gates TASK-237 | Fails *"an undone execution removes its Activity receipt"* — no receipt is ever created |
| TASK-278 | **No** | Not among TASK-236's acceptance criteria. It was briefly gated there in error; corrected. A real bug on the same surface, not a walk gate. |
| The other 10 | No | Ordinary backlog. No wave depends on them. |

**Shortest path to an acceptance-complete epic: TASK-277 → re-walk TASK-236 →
TASK-279 → re-walk TASK-237.** Two code cards and two walks.

Three worth knowing even though they block nothing:

- **TASK-268** has the most leverage of the thirteen — it makes every future review pass
  reliable, and pays for itself over the remaining five waves. Cheap.
- **TASK-273** blocks nothing *today* because the workspace surface is flag-gated, but
  flipping that flag ON (Wave 6) with no ErrorBoundary anywhere means any render-phase
  throw blanks the chat for every user. Treat it as a Wave 6 gate — a judgement call, not
  a discovered dependency.
- **TASK-275** and **TASK-280** are questions for a human, not work.

### From the code cards

| Card | Why |
|---|---|
| **TASK-268** | The TASK-247 root cause above — pin the reviewer dispatch shape; make "apparently hung" try **retrieval before re-dispatch** (re-dispatching duplicates a finished review and doubles the stall). |
| **TASK-273** | **`channel-web` has no ErrorBoundary at all** — verified: zero `ErrorBoundary` / `componentDidCatch` / `getDerivedStateFromError`, and `react-error-boundary` is not a dependency. Any render-phase throw **blanks the whole chat SPA**. Both TASK-261 crashes were instances of this missing floor. Realistic trigger is a deploy-time version skew. |
| TASK-272 | `approvalMessages()` returns `[]` on a caught `decisions:list` failure → `/workspace` claims "nothing is waiting on you" when it failed to look. Copy `readActivity`'s `{status:'ok'\|'failed'\|'unavailable'}` shape **from eleven lines below in the same file**; fix **both** branches (`catch`=failed vs `!hasService`=unavailable); reuse the *shape*, not TASK-261's client-side constants. Lower severity than the `/` instance — `/workspace` still has the Today queue with a real error path. |
| TASK-274 | A failed **first** decisions read after reload leaves a held call invisible until the next read; wants a bounded retry. |
| TASK-276 | `InThreadApprovals` conflates a **401 session expiry** with a read failure. Same family as TASK-238 / TASK-264 / TASK-272. |
| TASK-269 | Dead `ToolGroup` / `headerPhrase` / `toolVerb` / `VERB_MAP` in `ToolUse.tsx` — unreferenced outside their own test. TASK-260's card told its builder to edit them; both edits would have been **no-ops nobody renders**. |
| TASK-270 | A hold has **no persisted state** — renders as an ordinary *completed* step. Needs a persisted flag + reader for a real "Waiting" treatment. |
| TASK-271 | `activityPhrase` is host-authored but the transcript can't see it — the `mcp__` strip is a cosmetic patch over a missing wire field. Fence it server-side; it's agent-authored. |
| TASK-275 | Approval-card **focus on appearance** + **composer de-emphasis**, filed together because the composer question depends on **send-during-hold semantics** nobody has settled. Human-owned. |

---

## 4. The remaining waves (from the original doc, updated)

Wave 1 is **done**. Suggested order now:

**Wave 1.5 (new, do first)** — **TASK-277 → re-walk TASK-236 → TASK-279 → re-walk
TASK-237.** Those are the only two cards blocking the epic's acceptance (see §3).
TASK-277 is a silent failure on the control that authorises real actions, and TASK-237
already proved its fix has a sound target. **TASK-278 is not a blocker** — schedule it
with Wave 3, whose defect family it belongs to.

**Wave 2 — correctness on the approvals path:** TASK-253, TASK-254, TASK-265, TASK-267,
TASK-264.

**Wave 3 — silent failures and honesty:** TASK-239, TASK-240, TASK-238, TASK-252,
TASK-256. *(Consider folding TASK-272 and TASK-276 in here — same defect family.)*

**Wave 4 — infrastructure blocking the pipeline:** TASK-255 (see §2.3 — now two
mechanisms), TASK-246, TASK-266, TASK-248.

**Wave 5 — one-source-of-truth / boundary hygiene:** TASK-245, TASK-251, TASK-241,
TASK-243, TASK-262. *(TASK-269 fits here.)*

**Wave 6 — gates the preview flag ON:** TASK-249, TASK-250, TASK-258, TASK-257
(fix 257 and TASK-234 together — identical property). **Add TASK-273** — shipping the
workspace surface on by default with no ErrorBoundary anywhere is a bad trade.

**Wave 7 — deferred design questions (human, not code):** TASK-242, TASK-263, TASK-244.
**Add TASK-275 and TASK-280.**

---

## 5. The spawn-budget hold — still open, and now further over

The old doc §3.1 describes a cap of **10 auto-spawned cards per run**, breached at 21.
This run filed **13 more** (TASK-268 … TASK-280), so the hold stands and is wider.

Nothing was dispatched from any of them. Two of the thirteen (TASK-277, TASK-278) were
filed **knowingly past the cap** — dropping a HIGH walk finding to satisfy a bookkeeping
limit would have been strictly worse.

**Still needs a human:** either raise the cap, or keep promoting waves by hand.

---

## 6. New traps — learned the hard way this session

Add these to the old doc's §5 list; they are all first-hand.

**Board mechanics**
- **`gh project item-create` does NOT put the item in a lane.** It has `status: null`,
  which is invisible to every lane query (including `board_snapshot`'s jq filters, which
  key on `.status`). **Always set `Status` explicitly after creating a card.** All 13
  cards this run were briefly lane-less because of this.
- **`gh project item-list --limit 300` silently truncates this board** — it has 308 items
  (88 Archived eat the budget), so recently-created cards simply do not appear and look
  like they were never created. **Use `--limit 600`.**

**Agents**
- A subagent going idle without returning is a **delivery** question before it is a
  **liveness** question. Try retrieving from it before re-dispatching. (§2.2)
- Dispatch shape decides the return path: `isolation: "worktree"` → background async,
  returns normally; `name` with no isolation → interactive teammate, must `SendMessage`.

**Verification**
- **Verify the artifact, not the tree.** A builder's `build`/`test`/`lint` can all be green
  against a working tree while the commit that would merge **lacks the work**. `git status`
  is the only tell. Orchestrator: always check `git diff main...origin/<branch>`.
- **A guard test green on both sides of its own change proves the property holds, not that
  it can ever fail.** If there is no base commit that violates it, your only evidence of
  failability is a hand-injected scaffold that vanishes with the scratch edit.
- **You can invent a contract the server does not have and write a passing test asserting
  it.** Happened here: `{decision: null}` was assumed legitimate; `resolvedOrGone` 404s and
  `DecisionRead.decision` is non-nullable, so neither the server nor `tsc` contradicted it.
  A green test pinning the wrong contract is worse than no test — it stops the next person
  looking. Verify a new guard **bites** by reverting it.
- A row marked `executed` is **exactly the false signal TASK-277 produces** — verify
  execution by **side effect or host log**, never by the status field.

**Design**
- **Fix the class, not the instance you tripped over.** One card hit the same defect one
  layer further out on four consecutive passes (list read → poll read → the guard's own
  predicate → the write path). What worked was the one boundary all consumers cross —
  **structure over vigilance**. Caveat: *a chokepoint only covers the callers you actually
  routed through it*, so enumerate them.
- Pair a chokepoint guard with a **consumer-level** regression test. A boundary test proves
  the guard exists, not that every caller is behind it.
- **A live region and a ticking countdown must never share a node.** `aria-live` over an
  `Undo · Ns` counter announces once a second and buries the announcement that mattered.

**Cluster**
- **The kind cluster silently served a 12-hour-old image** predating all three fixes. The
  walk caught it and rebuilt; had it not, it would have reported every fix as broken.
  **Confirm which commit the cluster is actually serving before trusting any observation.**
- `dist-web` in the shared checkout can be stale build output from someone's feature
  branch, and `make dev-fast` syncs it to the cluster. **Rebuild it from merged `main`
  before any walk.**

---

## 7. How to resume

```
/auto-ship
```

…drains **To Do**, which is empty. So promote a wave Backlog → **To Do** first, or say
"drain wave 1.5".

Board: org `project-ax`, project **#1**. Journal: `.claude/auto-ship-log.md` (gitignored,
append-only) has the full minute-by-minute timeline of this run, including every
correction, prediction-before-test, and incident.
