# dag-ship templates — copy these literally, do not paraphrase

## Code-lane dispatch prompt

Dispatch via `Agent` with `run_in_background: true`,
`subagent_type: "general-purpose"`. Substitute `<TASK-ID>`, `<TASK-TITLE>`,
`<TASK-BODY>` (copy the task's line from TODO.md), `<short-slug>`:

> You are shipping ONE task from this repo's `TODO.md`, end to end, under
> orchestration by dag-ship.
>
> **Task <TASK-ID>:** <TASK-TITLE>
> <TASK-BODY>
>
> Run the `yolo-ship` skill on this task with these ORCHESTRATED-MODE overrides:
> - Branch: `dag-ship/<TASK-ID>-<short-slug>`. PR title MUST start with
>   `[<TASK-ID>] `. Base `main`.
> - **Do NOT merge.** Stop at a green, verified-mergeable PR (yolo-ship ends at
>   Phase 6 for you). dag-ship merges it through a serialized queue.
> - **Do NOT edit `TODO.md`.** Return deferred follow-ups in your handoff instead.
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

> You are running ONE manual-acceptance walk from `TODO.md` under dag-ship,
> against the kind cluster.
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

## Status dashboard format — `.claude/dag-ship-status.md` (overwrite each change)

```
# dag-ship — live status
_updated <YYYY-MM-DD HH:MM:SS> · wave <N> · started <HH:MM:SS>_

<done>/<total> done · <k> in-flight · <k> ready · <k> blocked · <k> parked  (+<k> trigger-gated, skipped)
<progress-bar>   budget: <d>/<dmax> dispatches · <s>/<smax> spawns

## in-flight
<TASK-ID>  <state: ci|merging|walk-running>  <#PR|->  <ci: green|red|pending|->

## ready (next)
<TASK-ID>   (deps clear)

## blocked
<TASK-ID> <- <blocking TASK-ID(s)>

## parked 🛑
<TASK-ID>  (<N> attempts — <signature>)

## done ✅
<TASK-ID> #<PR> · <TASK-ID> #<PR> · …
```

## Journal line formats — `.claude/dag-ship-log.md` (append-only)

```
<HH:MM:SS>  run start · actionable=<k> · budget <dmax> dispatches / <smax> spawns
<HH:MM:SS>  wave <N> dispatch · <TASK-ID> <TASK-ID> …
<HH:MM:SS>  <TASK-ID>  pr-green #<n> mergeable=<y|n>
<HH:MM:SS>  <TASK-ID>  merged #<n> -> main (ff)
<HH:MM:SS>  <TASK-ID>  walk-pass | walk-fail
<HH:MM:SS>  <TASK-ID>  failed attempt=<N> sig=<signature> parent=<id|-> depth=<d> [-> PARKED]
<HH:MM:SS>  HALT · <reason: global-breaker|stall|cluster-down>
```
