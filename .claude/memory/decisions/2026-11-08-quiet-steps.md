# quiet-steps — tool calls collapse above the reply (2026-11-08)

- **Step panel is CLOSED by default** (reverses the TASK-352 "open by default" choice). Vinay: the 48-row list was "noisy and mostly useless"; model is Claude.ai's one-line collapsed activity header.
- **Title has no counts and no per-kind tally.** `stepsTitle()` in `lib/workspace-steps.ts`: running → the current step in present tense ("Reading index.ts…"); done → the 1–2 dominant kinds ("Looked through files and ran commands"); single step → that step; then `, N didn't finish` / `, N waiting for you`. No reasoning-based titles (explicitly declined: needs a model call per turn).
- **Panel sits ABOVE the reply; artifacts/visuals/files sit below the answer.** `lib/reply-groups.ts` folds each run of consecutive agent/steps messages into one reply. The answer = the LAST non-empty text in the run (not "text after the last tool call": an answer followed by a silent memory-save turn would otherwise vanish into the panel). Earlier text becomes narration inside the panel.
- Side effect: reload now groups like live (one panel per reply), closing the old TASK-352 seam caveat.
- Folded turns keep memory-source jumps working via `data-turn-ids` (`lib/thread-jump.ts`).
- Built-in tools (Bash/Read/Write/Edit/Glob/Grep/WebFetch/WebSearch — same names in both runners) get plain verbs; raw input moved from `text` to `detail`, shown in monospace only when a row is opened. Same-kind done runs fold into "Ran 6 commands"; failed/held steps never fold.
