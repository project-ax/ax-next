# agent-workspace — the six remaining follow-ups (handoff)

**Written:** 2026-09-02.
**Repo state:** `main` @ `b8fa2c95`, 0 open PRs, in sync with origin, clean tree.
**Board:** org `project-ax`, project **#1**. Lanes: Done 183 · Backlog 82 · To Do 6.

**Supersedes for these six cards only:**
`docs/plans/2026-08-22-agent-workspace-followups-session-2.md`. That document's
priority ordering is **spent** — its two blockers and everything on its critical path
have shipped. Its §2 corrections and §6 traps are still valid and worth reading.

---

## 1. What already happened (do not redo)

Of the 13 cards filed on 2026-08-22, **seven are Done**:

| Done | What it was |
|---|---|
| TASK-277 | The HIGH one — approving an attended decision after idle-floor expiry silently no-oped |
| TASK-279 | `decisions:executed` had no subscriber → no Activity receipt |
| TASK-274 | A failed decisions read was terminal until an unrelated user action |
| TASK-276 | `InThreadApprovals` conflated a 401 session expiry with a read failure |
| TASK-272 | `approvalMessages` returned `[]` on a failed read |
| TASK-269 | Dead `ToolGroup`/`VERB_MAP` in `ToolUse.tsx` |
| TASK-268 | The `ax-code-reviewer` delivery root cause |

**Both acceptance walks — TASK-236 and TASK-237 — are Done.** The epic is
acceptance-complete. The old handoff's "shortest path" no longer exists to walk.

Work has moved on: `main` is past **TASK-324** (`/` renders the workspace when the
preview flag is on), and the To Do lane holds **TASK-325–331**, which are a different
track. **Do not touch the To Do lane** — it is not this handoff's work.

---

## 2. The six that remain — all in Backlog, deps `none`

Verified against `main` @ `b8fa2c95` on 2026-09-02, not assumed from the old doc.

### 2.1 TASK-273 — no ErrorBoundary in `channel-web` · **do this first**

**Still true, re-verified.** There is no error boundary anywhere in
`packages/channel-web/src`: zero `ErrorBoundary` / `componentDidCatch` /
`getDerivedStateFromError` *implementations*, and `react-error-boundary` is not a
dependency. Every current match is a **comment noting its absence** —
`workspace-api.ts:293`, `workspace-api.ts:434`,
`__tests__/workspace-decision-queue.test.tsx:245`,
`lib/__tests__/workspace-api-decision-shape.test.ts:9`. The codebase has been
documenting this hole for eleven days instead of closing it.

So any throw during React's render phase **unmounts the whole chat SPA** — a blank
page, no signal to the user, nothing to catch it.

**Why it is now the priority, when it was not before.** In August this was contained:
the workspace surface was flag-gated, so the blast radius was small. That has changed
— **TASK-324 shipped `/` rendering the workspace when the flag is on**, and
**TASK-325 (in To Do) is about giving the flag a chart value so it can actually be
turned on.** The team is actively walking toward flipping this on. Flipping it with no
boundary anywhere means one unguarded shape assumption blanks the chat for every user,
and the realistic trigger is a deploy-time version skew — precisely when response
shapes drift and precisely when the page most needs to stay up.

TASK-261 fixed both *known* render-phase crash paths at the API boundary
(`WorkspaceShapeError`). This is the floor under the ones nobody has thought of.

Acceptance is on the card. Two notes:
- Decide granularity deliberately: one app-level boundary vs. per-surface (thread,
  composer, rail). Per-surface keeps the rest of the page usable and is probably right
  for chat — but say why in the PR.
- The fallback copy is user-facing: invoke `ux-design`. It must say something went
  wrong and what to do, not show a stack trace and not silently white-screen.
- **Do not** treat this as a substitute for boundary validation. The
  `WorkspaceShapeError` pattern is the primary defence; this is the backstop.

### 2.2 TASK-278 — the post-approval continuation turn never renders live

**Still true, re-verified:** neither `lib/workspace-decisions.ts` nor
`lib/conversation-decisions.ts` opens a `chat/stream` anywhere. After `POST /approve`
the client polls the decision row but opens no `/api/chat/stream/<reqId>`, so the
continuation turn runs with **no SSE consumer**. The user sees nothing until they
reload — while the approval copy promises *"we can carry straight on."*

A control that claims a behaviour the surface does not deliver. This is on the
**unflagged `/` path**, so it is live for every user today.

Either open/keep a stream consumer for the continuation `reqId`, or stop promising one
in the copy. Prefer the former.

### 2.3 TASK-270 — a hold has no persisted state

TASK-260 stopped a held call rendering as a *failure* (`is_error` omitted, host copy).
That was the honest floor, not the finished job: with no persisted "held" flag, a hold
still renders as an ordinary **completed** step. A real "Waiting" treatment (e.g. the
`text-warning` token, distinct from both success and error) needs a persisted flag plus
a reader.

Also folded in as context: a hold persisted *before* TASK-260 still renders red on
reload, because that fix is publish-time, not a history migration. Judged acceptable —
but it is the same missing concept.

### 2.4 TASK-271 — `activityPhrase` is host-authored but the transcript cannot see it

TASK-260's `mcp__<server>__` strip is a **cosmetic patch over a missing wire field**.
`activityPhrase` already exists host-side (TASK-229 shipped the contract); putting it on
the tool-call wire shape is the real fix for human-readable tool names. The prefix strip
only makes a raw identifier less ugly — it does not make it meaningful.

Keep the strip as the fallback for tools with no phrase. **Fence `activityPhrase`
server-side** at the trust boundary — it is agent-authored and reaches a user-facing
surface.

### 2.5 TASK-275 and TASK-280 — questions for a human, not work

**Do not build these. Ask, then record the answer on the card.**

- **TASK-280:** Undo is refused once `replayedAt` is set, so only
  `approved-pending-agent` rows are ever undoable and a reversible *host* tool's undo
  window is unreachable. Either that is intended (undo is a grace period before the
  agent acts, never a reversal — in which case the UI should stop offering Undo for
  host-replayed calls) or the `replayedAt` check is too blunt (it conflates "we ran it"
  with "it cannot be taken back"). **Note this bears on TASK-259's shipped work:** if
  host replays can never be undone, that whole class never had a live Undo button.
- **TASK-275:** two linked interaction decisions — whether the approval card should take
  focus on appearance (discoverable vs. disruptive; it currently announces via a polite
  live region instead), and whether to de-emphasise the composer while a decision is
  open. The second depends on a prior question nobody has settled: **what are the
  send-during-hold semantics?** Settle that first; the styling follows.

---

## 3. Suggested order

1. **TASK-273** — a real gate on the flag flip the team is actively working toward.
2. **TASK-278** — live on `/` today, and the copy currently overpromises.
3. **TASK-271**, then **TASK-270** — 271 first: it replaces a patch with the real wire
   field, and 270's "Waiting" treatment reads better once tool names are meaningful.
4. **TASK-275 / TASK-280** — surface to the human; do not guess.

TASK-273 and TASK-278 are independent and parallel-safe. 270 and 271 both touch
transcript rendering — sequence them, do not run them concurrently.

---

## 4. Constraints and traps that still apply

- **Do not touch the To Do lane** (TASK-325–331). Different track. Promote only the
  cards this handoff names, Backlog → To Do.
- **The spawn cap is still unresolved** and is at 10/run; the last two runs filed 21 and
  13. Nothing has been dispatched from held cards. Either raise it or promote by hand —
  a human call.
- `gh project item-create` leaves an item with **no Status** — invisible to every lane
  query. Set `Status` explicitly after creating any card.
- `gh project item-list --limit 300` **truncates this board** (300+ items; Archived eats
  the budget). Use `--limit 600`.
- **`pnpm -r run test` bails at the first failing package** (see CLAUDE.md — this rule
  was added since the last handoff). Use
  `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, and do
  **not** stop at the recursive part alone — it is one of three suites.
- `--filter` goes **before** the script name.
- `channel-web` typechecks its tests and has them in **two** directories
  (`src/__tests__/` and `src/components/workspace/__tests__/`), so `pnpm build` is
  load-bearing.
- A subagent going idle without returning is a **delivery** question before a liveness
  one — try retrieving from it via `SendMessage` before re-dispatching (TASK-268).
- **Verify the artifact, not the tree** — a green local gate can be measuring a working
  tree while the commit that would merge lacks the work. `git status` is the only tell.
- Verify a new guard **bites** by reverting it. A guard test green on both sides of its
  own change proves the property holds, not that it can ever fail.

Journal: `.claude/auto-ship-log.md` (gitignored, append-only).
