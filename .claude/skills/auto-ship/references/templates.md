# auto-ship templates — copy these literally, do not paraphrase

## Code-lane dispatch prompt

Dispatch via `Agent` with `run_in_background: true`,
`subagent_type: "general-purpose"`. Substitute `<TASK-ID>`, `<TASK-TITLE>`,
`<TASK-BODY>` (the card's title + body from the board), `<short-slug>`, `<ITEM-ID>`
(the card's project-item node id), `<PROGRESS-HELPER-PATH>` (absolute path to the
`.claude/auto-ship-progress.sh` written at run start):

> You are shipping ONE card from this repo's "TO DO" project board, end to end,
> under orchestration by auto-ship.
>
> **Task <TASK-ID>:** <TASK-TITLE>
> <TASK-BODY>
>
> Run the `yolo-ship` skill on this task with these ORCHESTRATED-MODE overrides:
> - **Work ONLY in your own isolated worktree.** You were dispatched with
>   `isolation: "worktree"`, so you start in a dedicated git worktree — confirm
>   `git rev-parse --show-toplevel` is NOT the primary checkout, and NEVER
>   `git checkout -b`, commit, or `git switch` in the shared main checkout (it would
>   clobber the orchestrator and sibling agents). Create your branch in the worktree.
> - Branch: `auto-ship/<TASK-ID>-<short-slug>`. PR title MUST start with
>   `[<TASK-ID>] `. Base `main`.
> - **Do NOT merge.** Stop at a green, verified-mergeable PR (yolo-ship ends at
>   Phase 6 for you). auto-ship merges it through a serialized queue.
> - **Do NOT edit the board's routing fields** (`Status`, `Depends on`) and never
>   touch another card. auto-ship owns routing. Return deferred follow-ups in your
>   handoff instead; auto-ship creates the cards.
> - **Report progress live on your card.** This card is item `<ITEM-ID>`. At each
>   yolo-ship phase boundary, append a one-line heartbeat to its progress block —
>   in a SINGLE Bash call: `source <PROGRESS-HELPER-PATH> && append_progress
>   "<ITEM-ID>" "<line>"`. Use the per-phase lines in yolo-ship's **Progress
>   reporting** section; prefix exceptions (codex findings, CI red, blocked) with
>   `⚠`. Best-effort: a failed progress write must NEVER block the ship. The helper
>   does the read-modify-write in shell — do not read the card body into your context.
> - Otherwise follow yolo-ship exactly: worktree, self-answering brainstorm,
>   written plan, subagent-driven TDD, build+test+lint gate, local Codex review,
>   open PR, drive CI green.
>
> Return ONLY this handoff, ≤150 words:
> ```
> task: <TASK-ID>
> outcome: pr-green | failed
> pr: <#> | -
> headSha: <sha> | -
> mergeable: y | n | -
> ci: green | red | pending
> signature: <normalized failure signature> | -    # required iff outcome=failed
> followups:
>   - <one line each, or "none">
> ```

## Walk-lane dispatch prompt

Dispatch ONE at a time (serialized). Substitute as above:

> You are running ONE manual-acceptance walk from this repo's "TO DO" board (a
> `(walk)`-titled card) under auto-ship, against the kind cluster.
>
> **Task <TASK-ID>:** <TASK-TITLE>
> <TASK-BODY>
>
> Run the `k8s-acceptance-loop` skill to perform this walk against
> `kind-ax-next-dev`. If the task involves the runner image (image-baked),
> rebuild it first (see the `docker-build-cache-runner-fixes` memory). Drive the
> UI via Playwright MCP; capture evidence.
>
> Return ONLY this handoff, ≤150 words:
> ```
> task: <TASK-ID>
> outcome: walk-pass | walk-fail
> evidence: <one line: what you observed>
> signature: <normalized failure signature> | -    # required iff walk-fail
> followups:
>   - <one line each, or "none">    # for walk-fail: the bug to fix
> ```

## Failure-signature normalization

Build a stable, low-cardinality string so the same root cause hashes identically
across attempts. Strip line numbers, timestamps, SHAs, PIDs, ports, tmp paths.
Shape: `<lane>:<TASK-ID>:<where>:<symptom>`.

- CI test fail: `ci:<TASK-ID>:<test-file-or-suite>:<error-class>`
  — e.g. `ci:ARCH-2:ipc-dispatcher.test:assertion`
- Build/lint:   `build:<TASK-ID>:<tool>:<first-error-code>`
  — e.g. `build:ARCH-6:tsc:TS2345`
- Walk:         `walk:<TASK-ID>:<step>:<symptom>`
  — e.g. `walk:CLI-1:git-clone:auth-403`
- Agent gave up: `agent:<TASK-ID>:<phase>:gave-up`

## Journal line formats — `.claude/auto-ship-log.md` (append-only)

The board is the live dashboard; this journal is the failure ledger + timeline the
loop-breakers read (and a resume rebuilds attempt history from).

```
<HH:MM:SS>  run start · actionable=<k> · budget <dmax> dispatches / <smax> spawns
<HH:MM:SS>  dispatch · <TASK-ID> <TASK-ID> …
<HH:MM:SS>  <TASK-ID>  pr-green #<n> mergeable=<y|n>
<HH:MM:SS>  <TASK-ID>  merged #<n> -> main (ff)
<HH:MM:SS>  <TASK-ID>  walk-pass | walk-fail
<HH:MM:SS>  <TASK-ID>  failed attempt=<N> sig=<signature> parent=<id|-> depth=<d> [-> PARKED]
<HH:MM:SS>  <TASK-ID>  recovered (crash) -> {merge|To Do}    # run-start reconcile, §7
<HH:MM:SS>  HALT · <reason: global-breaker|stall|cluster-down>
```
