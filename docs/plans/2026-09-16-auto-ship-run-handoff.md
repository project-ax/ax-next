# auto-ship run handoff — 2026-09-16 (halted on spend limit)

**Why this doc exists.** An auto-ship drain run halted mid-flight when the
account's individual weekly spend limit was reached (HTTP 429; reset **2026-09-18
18:00 America/New_York**). Every dispatched agent died within the same minute.
The board carries all the durable state, but three things are *not* derivable
from it and would be lost without this file. They are in **"What the board cannot
tell you"** below — read that section even if you skip the rest.

**State at halt:** `main` @ `3b3868d2`, full-suite backstop **green**. 0 open PRs,
0 In Progress, 0 In Review. Lanes: Done 219 · Backlog 85 · To Do 20 ·
Needs Input 3 · Archived 88.

---

## Shipped (3 PRs, each through the full gate)

| PR | Card | What landed |
|---|---|---|
| #553 | TASK-249 | A create-agent door in `/workspace`, and a kickoff that survives it |
| #554 | TASK-329 | The rail says what a capability *costs*, not just what it does |
| #555 | TASK-331 | Reproduced the phantom `test:scripts` flake — a 5s default nobody declared |

Each merge was followed by the `main` full-suite backstop going green before the
next merge; PR CI only runs affected-package tests, so that check is what covers
cross-package breakage.

### Two findings from these worth carrying forward

- **TASK-249 refuted its own brief.** The card and the epic doc both sized it
  "small" because "the callback thread now exists". True of the wiring, false of
  the flow: `bootstrapKickoff` reaches **only** the chat runtime, because
  assistant-ui calls `runtimeHook` solely under `AssistantRuntimeProvider`, which
  the workspace deliberately does not mount. Any workspace card needing
  chat-runtime plumbing inherits that hazard. `TASK-379` is open to re-measure the
  epic's remaining Tier 3 estimates for the same reason.
- **TASK-331 added a third branch to the flaky-test triage rule.** A vitest
  **timeout is counted in the collected total**, so `Tests 1 failed | N passed (N)`
  reads like an assertion failure and is not one. The terminal summary also drops
  the failing test's *name*; `--reporter=json` + `assertionResults[].duration`
  recovers it. Dose-response: 1106ms idle → 7207ms at 11× CPU oversubscription,
  6/10 failing, **0/12 after the fix**.

---

## What the board cannot tell you

### 1. TASK-351 must RESUME, not restart — and its review is already paid for

Work is **complete** on `auto-ship/TASK-351-presence-routes-grant` @ `f7661eb3`
(3 commits, worktree `.claude/worktrees/agent-af25da62f9996f63c`). No PR was
opened only because the builder died *waiting for its reviewer*.

An `ax-code-reviewer` pass **completed on exactly that sha and returned
APPROVE** — 78/78 targeted tests, `tsc --build` exit 0 — but its findings never
reached the builder. All five items are recorded on the card as
`Predecessor learnings`. **Do not re-run that review from scratch.** Address the
three Minor findings, then open the PR. The sharpest one:

> The badge count for a **thread-routed** grant is unpinned. `WorkspaceShell`
> computes `pending = …decisions… + grants.grants.length` (deliberately *every*
> grant, which is what stops two disagreeing "waiting on you" numbers), but every
> count test runs on the Today route where no grant is ever routed away. A
> refactor to `grants.length - grantsInThread.length` would drop the badge the
> instant the question appears in the thread **and pass the entire suite green.**
> The reviewer called it the fifth wrong implementation this suite admits.

auto-ship's code-lane dispatch template has no "resume from branch" mode, so the
orchestrator must say so explicitly in the prompt — as it did for TASK-250 and
TASK-329 this run. A default dispatch will start a fresh worktree and rebuild.

### 2. One card was deliberately NOT filed — the breaker was at its cap

`scripts/__tests__/out-of-process-test-timeouts.test.js` carries the same
**unanchored `readTimeout`** regex that TASK-331 just fixed in a sibling guard: a
number written in a config **comment** outranks the real setting, across **21
container packages**. Found by TASK-331 (MEASURED). It is a live fail-open in a
guard, and those 21 packages were never checked.

> **Closed, and the path above is the current one.** This was filed as TASK-386.
> The file was called `container-test-timeouts.test.js` when this handoff was
> written; TASK-400 (PR #581) renamed it and replaced the text scan with
> `readResolvedTestBudgets`, which `import()`s each config and reads the resolved
> object — so there is no regex left to anchor. TASK-386 measured the defect as
> real on the live corpus before confirming it was already gone.

It went unfiled because the run had already auto-spawned **10 cards
(TASK-376–385)**, which is auto-ship's global breaker cap. The cap is per-run, so
a new run starts at zero — file this early.

### 3. The breaker/attempt history lives only in the journal

`.claude/auto-ship-log.md` (~181KB) holds the dispatch timeline, attempt counts
and failure signatures. A resume rebuilds attempt history from it, so a card that
already burned an attempt does not get a free reset. Three cards were journalled
`recovered` (crash ≠ task failure) and correctly **do not** count as attempts:
TASK-351, TASK-352, TASK-353.

---

## Card-by-card

| Card | Lane | Notes |
|---|---|---|
| TASK-249 / 329 / 331 | Done | merged, `main` green |
| TASK-351 | To Do | **resume** from `f7661eb3`; APPROVE review on the card |
| TASK-352 | To Do | died at startup, no branch, clean re-dispatch |
| TASK-353 | To Do | died at startup, no branch, clean re-dispatch. Security-relevant (upload = capability boundary over untrusted content) — `security-checklist` is mandatory; reuse the `safePath` lineage and the prior attachments shape rather than inventing a second one |
| TASK-250 | **Needs Input** | T3's gate is unbuildable as specified — see below |
| TASK-257 | **Needs Input** | team-agent Files/Memory shard semantics — **on the cutover critical path** |
| TASK-330 | **Needs Input** | `web_extract`: hold vs egress allowlist vs accept |
| TASK-376–385 | To Do | filed this run; all triaged clean, premises verified against code |

### The three open decisions

- **TASK-250.** The planned Today day-one panel gates on the activity feed, which
  has exactly two sources (routine fires and decision receipts). **Chat turns are
  in neither**, so the panel appears right after a user's first chat and persists
  forever for chat-only users; no Today-route signal can distinguish "has ever
  chatted". Compounding it, #553 changed the premise: first run now auto-sends a
  greeting and navigates *off* Today, and `NewAgentDialog` already explains what an
  agent is. Options on the card: (i) drop T3+T2+T6 and ship T1/T4/T5 (already
  verified green, branch preserved at `49f84d53`), (ii) add a "never conversed"
  wire signal, (iii) move day-one teaching into the post-kickoff chat.
  `TASK-381` is open to correct the stale Tier 4 bullet either way.
- **TASK-257.** Do the Files and Memory tabs read the **owner's** shard (teammates
  see the agent's files) or stay **per-caller**? If owner's, is everyone who can
  reach a team agent authorized to read it? Must Files and Memory get the same
  answer? This is an authorization boundary, and it is a `TASK-359` dependency —
  **the flag cannot flip until it is answered.**
- **TASK-330.** Which of three options to encode for `web_extract`, who configures
  an allowlist if that's the choice, and whether `PolicyRule.effect` becomes an
  array. TASK-329 was fenced out of this and held the boundary.

---

## How to resume

```bash
cd /Users/vpulim/dev/ai/ax-next
/auto-ship
```

Run-start resolves the board, rewrites the four helpers, runs the three fatal
self-tests (shell parity, helper completeness, GraphQL budget), takes the owner
lock, reconciles, prints a plan, then dispatches. The owner lock on disk is stale
by hours and will be taken freely.

Nothing needs untangling first — lanes are accurate and no PR is half-merged.
Two pre-existing worktrees (`TASK-366`, `TASK-373`) plus the dead builders'
worktrees are still on disk; they are harmless to the queue but do redden
`pnpm lint`, so sweep them at some point with
`git worktree remove -f -f <path>` (one `-f` exits 128 on a harness-locked
worktree).

---

## Process findings filed as cards this run

Two are defects in auto-ship itself, found by builders rather than by me:

- **TASK-377** — concurrent builders shared **one** scratchpad directory and a
  sibling's `pr-body.md` overwrote another's. Later waves used task-scoped dirs;
  the template still needs the fix plus a guard.
- **TASK-378** — the dispatch template never told builders that a fresh worktree
  needs `pnpm install --frozen-lockfile && pnpm build` before any test. Without
  it a large share of the repo's test files fail to load on unbuilt workspace
  deps, and the failures look like real breakage. Already in project memory; it
  recurred anyway, which means the knowledge was not where agents read.
  **Correction, 2026-09-17:** this bullet originally said "~41 test files", a
  figure carried over from a report rather than measured. TASK-378 probed it
  directly — a freshly added worktree of `main` at `6bd2b280`, installed but not
  built, `pnpm -r --no-bail run test` — and the real count is **363 test files
  across 68 packages**, about 9x higher. No single package accounts for 41
  either, so "~41" was not a subset figure. Left here rather than silently
  rewritten, because the wrong number is what made the card look like a small
  one.
- **TASK-382** — the merge-queue review gate asks the *handoff's* `reviewer:`
  field, not the *branch*. **Measured 2/2 PRs this run:** a builder obtained a
  review, applied the findings, pushed the fix, and that fix commit became the
  head — so no reviewer had seen the merge head, while the handoff honestly said
  `clean`. On #553 that pattern hid an Important defect (a false claim in a
  docstring, replicated into `.claude/memory/decisions.md` labelled MEASURED when
  only half was measured). The cheap check is
  `git log --oneline origin/main..<branch>` plus a scope test on the head commit:
  tests/docs/memory-only may merge on the builder's word, production code needs an
  independent pass. **Do not** widen it to "re-review every review-fix commit" —
  that makes the queue non-terminating.

One recurring signal that is **not** a defect and cost time four separate times:
a repo-wide run showing failures that are all Docker/testcontainer **container-start
contention**, with **zero assertion failures** run-wide and every affected package
green in isolation. Confirm with a filtered run and `--workspace-concurrency=2`,
say so, and move on.

---

## Ground rules carried forward

- Every bug fixed gets a regression test in the same change, confirmed to **fail**
  against the unfixed code — not merely pass against the fixed one.
- Full gate before any PR: `pnpm build`, then
  `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`,
  then `pnpm lint`, plus `pnpm typecheck` (it covers `test/` dirs `tsc --build`
  never reaches). `pnpm --filter` goes **before** the script name.
- Measure contrast in `browser_evaluate` against 4.5:1 and quote the numbers. Do
  not eyeball — every contrast defect on this project was found by measuring and
  none were visible in a screenshot. `TASK-380` owns a pre-existing
  `bg-muted`/`text-muted-foreground` pairing at ~4.43:1 in light mode.
- Read each new assertion back as a sentence about the product and ask whether
  that sentence is what we want true. Vacuity-checking is necessary and not
  sufficient.
