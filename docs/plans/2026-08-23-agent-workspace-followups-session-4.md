# agent-workspace follow-ups — session 4 handoff

**Written:** 2026-08-23, end of the Wave-3 run.
**Supersedes:** `docs/plans/2026-08-23-agent-workspace-followups-session-3.md` for resuming.
That document remains accurate about Wave 2 and is still the best statement of *why* §2 exists.
**Still the base map for Waves 4–7:** `docs/plans/2026-08-22-agent-workspace-followups.md` —
trust it on **wave membership**, not on **card detail**. See §2.

**Repo state at handoff:** `main` @ `5686ba6b`, CI green, **0 open PRs**, every lane **empty**,
0 in flight, 0 parked. Fully quiesced — safe to resume cold.

---

## 1. What shipped this session

**Wave 3 drained 8/8.** Eight PRs, all reviewer-clean, all merged with main green after each.

| Card | PR | What landed |
|---|---|---|
| TASK-276 | #453 | A 401 is not a read failure — the decisions surfaces say which |
| TASK-239 | #455 | A gate that could not be reached is not a policy decision |
| TASK-272 | #454 | The thread says when it could not read the approvals |
| TASK-274 | #456 | A failed decisions read is no longer terminal — bounded retry, and the sentence that backs it |
| TASK-252 | #458 | Today's done count waits until the feed can back it |
| TASK-256 | #457 | The unknown-delivery branch is defence in depth, not forward compat |
| TASK-240 | #459 | A veto that explains itself — the reason reaches the log and the agent |
| TASK-238 | #460 | `DISABLED_BUILTINS` refusals name which of four causes fired |

### The chain that only worked because of sequencing
TASK-276 shipped the 401/read-failure split but **deliberately withheld** the sentence
*"We couldn't check what's waiting. Trying again."* — no auto-retry existed, so the sentence would
have asserted a mechanism the code lacked. TASK-274 built the retry and landed the sentence, with
both directions pinned (`retrying` → shown, budget spent → reverts to `failed`).

**Neither card asked for this.** TASK-274 was filed dep-free; measurement showed it depended on a
type TASK-276 had not written yet, and the dep edge was set before dispatch. The filed dep graph
would have produced two independent patches and a copy string asserting a mechanism that did not exist.

---

## 2. Read this before you trust any card

**4 of 8 Wave-3 cards were wrong about their own bug** — after 3 of 6 in Wave 2. **This is the base
rate, not an anomaly.** Measure the premise before you build. The measurement pass cost ~20 minutes
(four read-only agents in parallel, before any builder) and produced 4 corrected cards, 2 scope
rulings, 1 un-carded live defect, and 3 new cards.

### 2.1 TASK-239 — the card described the symptom, not the load-bearing defect
Filed as *"leaks raw `Error.message` to the model"*. True, and it reaches a **human** too (one click
into chain-of-thought). But **two of its three acceptance bullets were false**:
- *"Test covers a throwing subscriber"* — a throwing `tool:pre-call` subscriber **never reaches that
  path**. `HookBus.fire` catches, logs, continues → a clean **allow**, not a fail-closed deny. A test
  written to the letter would have pinned the opposite of the card's own claim.
- *"The underlying error is logged host-side"* — it throws **runner-side** and was logged **nowhere**.

The real defect was a **false causal claim**: the aisdk runner wrapped every deny, fail-closed ones
included, in *"not a transient failure — retrying will be denied again"* — categorically false for
`ECONNREFUSED`.

### 2.2 TASK-238's branch is dead; building it as filed would have repeated TASK-256
Four causes exist, but both message sites sit behind `disallowedTools`, which removes those tools
from the model's context entirely. Neither the model nor a user ever reads the string, and the
human-facing rail **already** distinguishes all four. Ruled: relabel as defence-in-depth + per-cause
string as a **debugging** affordance, with no test asserting model-visible behaviour.

### 2.3 TASK-274's two factual claims both failed on contact
*"Existing coverage is failure during a session, not at mount"* — false; the mount test exists at
`in-thread-approvals.test.tsx:134-148` and deliberately asserts `container.firstChild` is **null**.
*"A held call stays invisible until something else triggers a read"* — false; the `conversationId`
null→non-null transition fires a second read, and while null there is nothing a card could show.
Retargeted at the real hole: a failed read **after `conversationId` is known**.

### 2.4 TASK-240's title asserted something untrue
`git reset --hard` is **not** unconditional — `--mixed` is the default and preserves the tree.
`--hard` is hardcoded **on the veto branch specifically**, and causally. Retitled. A hypothesis was
also tested and **cleared**: no pre-apply subscriber throws, so no veto is silently swallowed.

### 2.5 TASK-252's own prescription was the trap
The defect was real, but the card's suggested `!feed.hasMore` gate would have **hidden the count
permanently** on any busy account — and been **green in every fixture**, because the fixtures
exhaust. A gate that is too strict does not fail loudly; it silently deletes the surface. Also
`decisions:count` is the **wrong stream** (`doneToday` counts routine fires, not decisions).

### 2.6 My own card was wrong within four hours
TASK-239's builder overrode two prescriptions written that morning, with better reasons, both
accepted: `cause` **required** not optional (a future third cause becomes a build error rather than
silently inheriting the confident text), and the redundant `.parse` **stays inside the `try`**
(moving it out would be fail-**open**, because the claude-sdk hook has no catch). **The
measure-the-premise rule applies to instructions written this session, not only to inherited cards.**

### 2.7 How the corrections were recorded
False acceptance bullets were **struck in place** (`~~...~~` plus why), never deleted, so a later
session cannot rebuild them. Two cards were **retitled** because their titles asserted false
premises. Do the same.

---

## 3. Cards filed this session

All **Backlog**, all with deps set.

| Card | Why |
|---|---|
| **TASK-287** | A pre-apply veto discards **the whole turn's** diff, not the change it objected to. `recoverable:false` is hardcoded; `git add -A` runs first, so `--hard` deletes every unrelated file the agent wrote. Must answer the wedge hazard its pinned test's comment names. |
| **TASK-288** | **No post-boot 401 handling anywhere in the SPA.** Chat shows *"chat-flow POST failed: 401 Unauthorized"*. Only genuinely new piece is a way back to `mode='unauthenticated'`. |
| **TASK-289** | A stale open ApprovalCard renders **beside** the signed-out banner, offering a dead Approve button. **Genuine product call** two builders correctly declined to make — see §5. |
| **TASK-290** | The same failed read is drawn **red** by TodayView/AgentConversation and **neutral** by InThreadApprovals. Three-way, confirmed post-#453. Best done **after** TASK-274, which changes what the honest register for `failed` is. |
| **TASK-291** | The **per-row undo poll** can 401 and never raises the banner — during the 10s grace window, the one moment the UI promised to respond. |
| **TASK-292** | The pre-call reject arm's `reason` is an **uncapped** `z.string()` on the wire (`hold`'s `note` has `.max(2000)`). Wire change → **boundary review**. Deliberately kept out of #455. |
| **TASK-293** | **No turn-level breaker** on repeated gate-unreachable denies. #455 removed a false claim that was also the only stopping force; now bounded only by model cooperation and the step ceiling. Strictly better than before, still incomplete. |
| **TASK-294** | claude-sdk gets the sanitized reason but not the retry guidance. Real question is whether a **human-visible** field should carry model-directed advice at all. |
| **TASK-295** | False comments: `materialize-uploads.ts:55` (says `console.error`, writes to stderr) **and** `FirstRunAutoCreate.tsx:17` (claims StrictMode protection; `main.tsx` renders bare). |
| **TASK-296** | `AgentView`'s `pastError` path was missed by both #453 and #454 and still renders **"workspace /agents/... → 401"** in mono at the user. |
| **TASK-297** | Two shipped cards depend on a `@anthropic-ai/claude-agent-sdk` behaviour chain **pinned by no test** (deliberately). An SDK bump could silently invalidate both. |
| **TASK-298** | **auto-ship's own references carry four defects** — see §7. Three fail silently. |

Also updated: **TASK-245**'s scope shrank — only **two** of the three name-copies can drift; the new
`DISABLED_BUILTIN_REASONS` keys are compiler-bound to `DISABLED_BUILTINS`.

---

## 4. The remaining waves

**Wave 4 — infrastructure:** `TASK-255` (**still untagged** `epic: agent-workspace` — will not appear
in an epic-filtered query), `TASK-246`, `TASK-248`. Note TASK-266 did **not** fix TASK-246:
`decisions:list`'s inline sweep is untouched.

**Wave 5 — one-source-of-truth / boundary hygiene:** `TASK-245` (scope now narrowed, see §3),
`TASK-251`, `TASK-241`, `TASK-243`, `TASK-262`, `TASK-269`.

**Wave 6 — gates the preview flag ON:** `TASK-249, TASK-250, TASK-258, TASK-257`, plus **TASK-273**
(no ErrorBoundary anywhere in `channel-web`). TASK-234 is Done; ignore the old pairing instruction.

**Wave 7 — deferred design questions:** `TASK-242, TASK-263, TASK-244`, plus **TASK-286** (ruling
now recorded — see §5 — so it is buildable).

**The new Backlog cards** (287–298) are not assigned to a wave. **TASK-298 is worth doing before the
next drain** — it fixes the machinery every wave runs on.

---

## 5. Human rulings made this session

Recorded on the cards themselves; they replace those cards' original acceptance.

- **TASK-286 — collapse at approve time.** Under the existing advisory lock, `approve` refuses-and-
  reports when a sibling open row for the same `(agent, owner, fingerprint)` was already consumed,
  reusing PR #448's `CLAIM_REFUSED_DETAIL`. **`restore` is NOT taught a new refusal** — undo keeps the
  TASK-280 meaning: a grace period, always available, never refusable. Accepted consequence: a person
  can undo into a state where the restored card is then unapprovable, and learns that when they press
  Approve. Not built this session; stays Wave 7.
- **TASK-240 — scope A only.** Make the reason observable (host log + the tool result the flush path
  already returns). The turn-scoped-reset collateral is **out of scope** and became TASK-287. The full
  user-visible notice frame was **rejected**: `chat:turn-error` is terminal and a veto is not.
- **TASK-238 — relabel + per-cause debugging string.** Rejected: building it as filed (tests asserting
  behaviour no production path executes); rejected: closing WONTFIX into TASK-245.
- **TASK-276 — inline on the decisions surfaces.** The app-wide signed-out state became TASK-288.
- **TASK-274 — retarget at the measured defect**, then build.

**Still needs a ruling: TASK-289.** A stale open ApprovalCard beside the signed-out banner. Leave it
(last thing we knew, but dead buttons) / suppress it (honest about actionability, but briefly claims
nothing is waiting) / leave it with controls disabled-and-explained (likely right; echoes the TASK-275
ruling that dimming alone is unacceptable). The answer may differ by `kind` — a 401 is *known* to make
the action impossible; a `failed` read only means we could not check.

---

## 6. What this run taught — the durable part

**Fifteen false comments** have now been found across this epic. Two were found **by reviewers, in the
very file a PR cited as its authority** — TASK-256's PR, whose entire deliverable was correcting false
comments, would have shipped pointing readers at one (`actions.ts:575`, "three variants", 347 lines
above a four-arm schema). Lesson recorded by that builder: **grep the identifying phrase across the
repo, especially in the file you tell readers to go consult.**

Test-discipline findings that outlast the cards:

1. **A gate that is too strict fails silently.** TASK-252's card recommended exhaustion-gating, which
   is green in every fixture and deletes the surface in production. "It's the conservative choice" is
   not on its own a defence — over-strict and under-strict both need a test.
2. **A negative render assertion needs a settled fetch.** `expect(queryByText(...)).toBeNull()` passes
   trivially before the response lands. Hold the mocked promise open, render, then
   `await act(async () => release())`. Waiting on unrelated text proves nothing about the fetch you care about.
3. **Vacuity-checking has a third failure mode: it can be impossible.** TASK-256's diff was comments
   and two test names — no revert reddens anything. It **said so plainly in the PR** rather than
   inventing a behaviour change to have something to check. Do that.
4. **A fix for a false comment can install a new false comment.** TASK-239's R2 review caught a reword
   that made the claim false in the *opposite* direction. After editing either a comment or the code it
   describes, re-derive the claim from **both** sources.
5. **Hardening owes a test too.** A defensive `try/catch` on a fail-open path is a behaviour change and
   is not exempt from the Bug Fix Policy.

---

## 7. New traps — all first-hand this run

**auto-ship's own machinery is broken in four places — filed as TASK-298. Three fail SILENTLY.**
- `board_batch` is **bash-only**; under zsh `$i:` is a modifier and the mutation is malformed.
  The reference still ships the broken form even though project memory records the bug. Use `bash -c`.
- **The progress helper cannot be `source`d under worktree isolation**, and dispatch is *mandatorily*
  worktree-isolated. **The live per-card heartbeat was dead for every builder this entire run** and
  nobody noticed, because a failed progress write is deliberately non-fatal. A wrapper outside the
  worktree works.
- **`gh pr merge --squash --delete-branch` always exits 1** against a worktree-isolated builder —
  *after* the merge succeeded, which reads like failure. Drop `--delete-branch`; `git push origin
  --delete` separately; sweep worktrees at session end. **The lock pid is the SESSION pid, shared by
  every agent worktree** — a `kill -0` liveness check never authorizes cleanup mid-run.
- **The 25-minute reviewer deadline discards real findings.** Measured: two reviewers did 4 and 7.5
  minutes of work but **delivered ~40 minutes apart**, one holding a real blocker. TASK-268 fixed the
  true hang (the `name` dispatch shape); what remains is slow-but-healthy delivery. Treat 25 min as
  "retrieve it via `SendMessage`", not "give up".

**Agents**
- **Builders do not infer; they comply when told.** 3 of 3 skipped their handoff — and its `reviewer:`
  field, the merge gate — until the prompt said verbatim: *"Return your handoff as soon as the PR is
  open and reviewed — report `ci: pending`. I own the merge gate. Do NOT sit waiting on CI."* Then 5 of
  5 complied. **Put that line in every dispatch.**
- After a builder returns, **`TaskStop` it** — several kept re-waking on their own CI monitors.

**Merge queue**
- **A green PR goes stale fast.** Both #457 and #460 flipped to `CONFLICTING` the moment the preceding
  PR merged. Re-verify mergeability **immediately before** `gh pr merge`, never from an earlier check.
- **`mergeable` transiently returns `UNKNOWN`** while GitHub computes. Poll until it resolves; do not
  treat `UNKNOWN` as mergeable — one such window hid a real conflict.
- **Both rebases hit `.claude/memory/` only, never code.** Different cards appending to
  `patterns.md`/`decisions.md`. Resolution is **keep both sides**.
- **Count the checks** (carried forward): 11 on this repo. "No failures" with fewer means skipped, not green.

**Board** (carried forward, still true)
- `gh project item-list` needs `--limit 600`+ — the board is at 318 items.
- `gh project item-create` leaves `Status` null and invisible to every lane query. Set it explicitly,
  then **re-read to verify**.
- `gh project item-edit --body` needs the **`DI_` content id**, not the `PVTI_` item id. The item id is
  what `--field-id` writes take. They are different ids for the same card.

**Shell** (carried forward)
- Absolute `cd` at the front of **every** Bash call. `pnpm --filter` goes **before** the script name —
  and **run it from your own worktree root**; from the shared checkout it silently tests the wrong tree.

---

## 8. Loose ends

- **Stale worktrees:** the 7 from this run were swept. **Three remain from session 3**
  (`auto-ship/TASK-259`, `-260`, `-261`, all merged) plus five older feature worktrees under
  `.worktrees/`. These redden `pnpm lint` — worth a sweep, but they predate this session so they were
  left alone.
- **TASK-255 is still not tagged** `epic: agent-workspace` (called out in session 3; not fixed).
- `docs/plans/2026-08-21-policy-condition-inventory.md:76/:328/:461` still say all four builtins share
  one denial string. **Deliberately left as dated provenance** — do not back-edit a historical
  inventory; date-stamp it if anything.
- **Scope guard from TASK-256's review:** `session-postgres/src/inbox.ts:557`'s "newer host" comment
  was **cleared as correct** — that store is durable, so cross-version reads are real. TASK-256's
  one-image argument covers the **ephemeral wire only**. Do not let a later card generalize it.

---

## 9. How to resume

Paste this:

> Resume the agent-workspace follow-ups: drain Wave 4. Read
> `docs/plans/2026-08-23-agent-workspace-followups-session-4.md` first — it is the current handoff.
> Wave 4 is §4's list. **Read §2 before trusting any card**: 4 of 8 Wave-3 cards were wrong about
> their own bug, so measure the premise before building — dispatch the read-only measurement pass
> first. §5 has the rulings and names the one still open (TASK-289). §7 lists four defects in
> auto-ship's own machinery (TASK-298) — consider fixing those before draining.

Journal: `.claude/auto-ship-log.md` (gitignored) has the minute-by-minute timeline.
Project memory: `.claude/memory/meta.md` gained the orchestration retrospective; `patterns.md`,
`decisions.md`, `mistakes.md` gained per-card rows via the merged branches.
User-level notes added: `feedback_late_reviewer_is_not_a_hung_reviewer`,
`feedback_merge_delete_branch_blocked_by_worktree`.
