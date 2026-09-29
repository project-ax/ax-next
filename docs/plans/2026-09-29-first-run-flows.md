# First-run flows — welcome card, add-agent escape hatch, hidden kickoff (TASK-689)

Scope: `packages/channel-web` only. Origin: UX audit of the two first-run experiences on
ax-next-dev, 2026-09-29 (first login → name the agent; "+ New agent…").

## What the audit found

| # | Finding | Where |
|---|---|---|
| 1 | **Critical.** Failure on the add-agent path lands on a card that says "your **first** agent", offers only "Try again", ignores Escape; the only exit is a reload. | `FirstRunAutoCreate.tsx` error branch |
| 2 | First run is a modal over an empty dim page: no product name, no welcome; the odd one out between the branded login card and the branded "Setting up…" card. | `NewAgentDialog.tsx`, `App.tsx` gate |
| 3 | "+ New agent…" makes the whole workspace vanish behind the dialog (the gate *replaces* the tree — TASK-510) and repeats first-run copy to someone with agents. | `App.tsx` gate |
| 4 | After create, the thread opens with a `hi` the person never typed, drawn twice until the reply lands (optimistic sent bubble + committed turn). | `WorkspaceShell` kickoff, `AgentView` `setSent`, thread builder |

## Design (three tasks)

**T1 — both flows become `SetupShell` cards** (`NewAgentDialog` → `NewAgentCard`; it is no
longer a dialog and a name that says otherwise is how TASK-250's mistake happened).
Keep the gate as is: it still replaces the workspace, so the focus-restore work
(TASK-510/533/547) is untouched. First run: "Welcome to ax" / "First, let's create your
personal AI assistant." Add: "New agent" / "Give it a name. It'll introduce itself in a
moment." + Cancel (Escape too). Field "Agent name", placeholder "e.g. Juniper", helper
"You can change it later." Failure card: heading per flow, names the agent, keeps the name,
"Try again" + ("Change name" on first run | "Cancel" when adding).

**T2 — hidden kickoff.** `KICKOFF_TEXT` becomes a reserved sentence; the thread builder
skips a user turn at `turnIndex 0` with exactly that text; the kickoff draws no bubble.
The model-written greeting is the first thing in the thread. A failed kickoff turn must
still surface an error (the `sent` state drives that UI). Conversation titles are
generated from the raw transcript, so the sentence reaches the title model — verify titles
in the browser walk and tune the wording if it leaks.

**T3 — doubled bubble on a first message typed from Today.** Only if reproducible: failing
test first, then fix. Otherwise dropped and recorded.

## Explicitly not doing

- A canned/UI-inserted greeting, a transcript marker, or prompt / `@ax/conversations`
  changes (too much infrastructure for the benefit; the transcript is the SDK jsonl and
  `conversations:append-turn` was deleted on purpose).
- Rendering the add flow as a true overlay over a live workspace (TASK-510 costed it as a
  bigger change).
- Rail permission list → TASK-685 (merged). Stuck "Working" pill → TASK-686.

## YAGNI pass

Every task is load-bearing: T1 fixes a Critical trap and the "no welcome" complaint; T2 is
the "random hi" complaint; T3 is a candidate bug whose existence is checked, not assumed.

## Verify

`pnpm build`, `DOCKER_HOST=… pnpm -r --no-bail run test` (channel-web alone: 220 files / 3167
tests green on the untouched branch), `tsc`, lint. Then a browser re-walk of both flows on
ax-next-dev at 1280px and 390px, including a forced bootstrap failure, and a title check
across several fresh agents.
