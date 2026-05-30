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
> - **If you hit a decision only a human can own** — a product / scope / requirements
>   choice you cannot responsibly self-answer — **stop**, do NOT open a PR, and return
>   `outcome: blocked` with `needs-input:` listing the specific questions. This is
>   **not** a failure (it doesn't count as an attempt); auto-ship routes the card to the
>   Needs Input lane for the human. Reserve it for genuine human-owned decisions, not
>   technical unknowns you can resolve by reading the code.
> - **Learn from what merged before you.** Your card body may carry a `Predecessor
>   learnings` block — lessons from same-epic cards merged ahead of you. Re-read your card
>   body (item `<ITEM-ID>`) at the start, fold those lessons into your plan, and if one
>   invalidates this card's premise (the design was built differently than this card
>   assumed), return `outcome: blocked` with the scope question instead of guessing. When
>   you finish, return the lessons YOUR work creates for later tasks in the `learnings:`
>   handoff field (and commit durable ones to `.claude/memory/` as usual).
> - **Report progress live on your card.** This card is item `<ITEM-ID>`. At each
>   yolo-ship phase boundary, append a one-line heartbeat to its progress block —
>   in a SINGLE Bash call: `source <PROGRESS-HELPER-PATH> && append_progress
>   "<ITEM-ID>" "<line>"`. Use the per-phase lines in yolo-ship's **Progress
>   reporting** section; prefix exceptions (review findings, CI red, blocked) with
>   `⚠`. Best-effort: a failed progress write must NEVER block the ship. The helper
>   does the read-modify-write in shell — do not read the card body into your context.
> - Otherwise follow yolo-ship exactly: worktree, self-answering brainstorm,
>   written plan, subagent-driven TDD, build+test+lint gate, local review,
>   open PR, drive CI green.
>
> Return ONLY this handoff, ≤150 words:
> ```
> task: <TASK-ID>
> outcome: pr-green | failed | blocked
> pr: <#> | -
> headSha: <sha> | -
> mergeable: y | n | -
> ci: green | red | pending
> signature: <normalized failure signature> | -    # required iff outcome=failed
> needs-input: | -                                  # required iff outcome=blocked
>   - <one question per line — a decision only a human can make>
> learnings: | -                                    # facts that change assumptions for OTHER tasks; "none" if nothing
>   - <one line each — changed interface / established pattern / decision / gotcha / invalidated premise>
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

## Triage dispatch prompt

Dispatch ONE `general-purpose` agent **without** a worktree (board-only, no code).
Substitute `<CANDIDATES>` — one `"<ITEM-ID> <TASK-ID>"` per line — and
`<PROGRESS-HELPER-PATH>` (absolute path to `.claude/auto-ship-progress.sh`, which
carries `set_needs_input`). The agent fetches bodies itself; do **not** paste bodies
into the prompt.

> You are the **triage agent** for auto-ship. For each candidate card below, fetch its
> body from the board and judge two things. Do NOT write code, open a worktree, or
> touch any lane / `Status` / `Depends on` field — auto-ship owns routing.
>
> Candidates (`<ITEM-ID> <TASK-ID>` per line):
> <CANDIDATES>
>
> Fetch each body:
> `gh api graphql -f query='query($i:ID!){node(id:$i){... on ProjectV2Item{content{... on DraftIssue{id body}}}}}' -f i="<ITEM-ID>"`
>
> 1. **walk?** — is this a manual-acceptance walk (the body asks to *verify behaviour
>    in the running UI / cluster by hand*, not write code)? → `walk: y`, else `n`.
> 2. **specified vs underspecified** — a card is **specified** iff a competent engineer
>    could build it to a mergeable PR **without making a product / scope / requirements
>    decision only the requester can own**. Missing *technical* detail the agent can
>    discover by reading the code is NOT underspecified. Missing *decisions* (which of
>    two behaviours, ambiguous acceptance criteria, which system to integrate, unclear
>    scope) ARE. Hold a **high bar** — over-flagging stalls the autonomous loop.
>
> Then edit the body (the ONLY thing you write):
> - **underspecified** → splice in the needs-input block with your specific questions,
>   one per line, via `source <PROGRESS-HELPER-PATH> && set_needs_input "<ITEM-ID>"
>   $'<question 1>\n<question 2>\n…'`. Use `$'…'` ANSI-C quoting (NOT plain `"…"`) so each
>   `\n` is a real newline. The helper renders, per question, a `**Qn.**` line then its
>   **own blank** `**An.**` line (Q and A never share a line; the answer starts empty),
>   and splices the START/END markers. **If `set_needs_input` is undefined after sourcing**
>   (a stale helper file), do NOT improvise the layout — write the block into the body
>   yourself so that each question is a `**Qn.**` line, then a blank line, then a blank
>   `**An.**` line, then a blank line, with `<!-- AUTOSHIP-NEEDS-INPUT:START -->` /
>   `<!-- AUTOSHIP-NEEDS-INPUT:END -->` each on its own line around the whole block. Q and
>   A must never share a line and each `An` must start blank — that is the regression this
>   guards against. (Plain double quotes pass a literal `\n`; the helper normalizes it, but
>   prefer `$'…'`.)
> - **specified but a needs-input block exists** (the user answered) → fold the Q&A
>   into a durable `## Clarifications` section *outside* the `AUTOSHIP-NEEDS-INPUT`
>   markers and delete the block, so the builder sees the answers as spec and nothing
>   is lost.
> - **specified, no block** → leave the body untouched.
>
> Return ONLY this handoff, ≤150 words:
> ```
> triage:
>   - id: <ITEM-ID> task: <TASK-ID> walk: y|n verdict: specified | needs-input
>   - …
> ```

## Decomposition dispatch prompt

For **Design-intake mode** (SKILL.md). Dispatch ONE `general-purpose` agent **without** a
worktree (board-only, commits nothing). Substitute `<DESIGN-PATH>` (absolute path to the
design doc), `<EPIC-SLUG>` (derive from the doc filename, e.g. `2026-05-30-foo-design` →
`foo`), `<BASE-N>` (current max `[TASK-<num>]` on the board; the agent numbers from
`<BASE-N>`+1), `<PNUM>` / `<OWNER>` (board coordinates), and `<DRY-RUN>` (`yes` / `no`).

> You are the **decomposition agent** for auto-ship. Turn a finished design doc into
> PR-sized cards on the "TO DO" project board. Do NOT write code, open a worktree, or set
> any `Status` / `Depends on` field — auto-ship owns routing and will route the cards you
> create.
>
> Design doc: `<DESIGN-PATH>`   epic slug: `<EPIC-SLUG>`   number cards from: TASK-<BASE-N>+1
> dry-run: <DRY-RUN>
>
> 1. Read the design doc in full. Using `writing-plans` thinking, break the work into
>    **independent, PR-sized, testable** slices — each a single coherent PR a competent
>    engineer could ship on its own. Apply a YAGNI pass: cut anything not load-bearing for
>    the design's goal. Sequence the slices into a dependency DAG (which must merge before
>    which). Honor `ax-conventions` when shaping the slices (don't split across a hook
>    boundary in a way that strands a half-wired plugin).
> 2. **If dry-run = no:** for each slice i (1..N), in dependency order, create a
>    draft-issue card —
>    `gh project item-create <PNUM> --owner <OWNER> --title "[TASK-<n>] <title>" --body "<body>"`
>    where `<n>` = <BASE-N>+i. Capture each returned item id. The **body** must be
>    self-contained and specified enough to ship without a human decision, and MUST begin
>    with these two marker lines, then the spec:
>    ```
>    epic: <EPIC-SLUG>
>    design: <DESIGN-PATH>
>
>    <scope: what this PR delivers>
>
>    ## Acceptance
>    - <criterion>
>    ```
>    Append `(walk)` to the title for a slice that is a manual-acceptance walk (verify
>    behaviour in the running UI / cluster), not code.
>    **If dry-run = yes:** do everything EXCEPT `item-create` — create no cards; return the
>    manifest with `item: -` for each so the orchestrator can print the proposed breakdown
>    with zero board writes.
> 3. Return ONLY this handoff (the manifest — ids, titles, deps; **NO bodies**):
>    ```
>    epic: <EPIC-SLUG>
>    cards:
>      - task: TASK-<n>  item: <ITEM-ID | ->  title: <title>  deps: <space-sep TASK-ids | none>
>      - …
>    ```

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
<HH:MM:SS>  <TASK-ID>  id-assigned [TASK-n]                  # triage gave an untagged card an ID
<HH:MM:SS>  <TASK-ID>  triaged clean | needs-input | walk    # triage verdict; `clean` skips re-triage
<HH:MM:SS>  dispatch · <TASK-ID> <TASK-ID> …
<HH:MM:SS>  <TASK-ID>  pr-green #<n> mergeable=<y|n>
<HH:MM:SS>  <TASK-ID>  merged #<n> -> main (ff)
<HH:MM:SS>  <TASK-ID>  walk-pass | walk-fail
<HH:MM:SS>  <TASK-ID>  failed attempt=<N> sig=<signature> parent=<id|-> depth=<d> [-> PARKED]
<HH:MM:SS>  <TASK-ID>  blocked -> Needs Input                # agent escalation; NOT a failure attempt
<HH:MM:SS>  <TASK-ID>  recovered (crash) -> {merge|To Do}    # run-start reconcile, §7
<HH:MM:SS>  HALT · <reason: global-breaker|stall|cluster-down>
```
