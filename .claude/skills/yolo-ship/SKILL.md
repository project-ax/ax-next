---
name: yolo-ship
description: Use when asked to implement, build, or ship a task or feature end-to-end with minimal supervision and you are expected to own it from request to a passing, review-clean pull request. Triggers on "implement X end to end", "build X and open a PR", "take this and run with it autonomously", "ship this task", or any request to deliver a unit of work with minimal back-and-forth.
user-invocable: true
---

# yolo-ship — implement a task end-to-end (autonomously)

## Overview

One task → one worktree → phases (**brainstorm → design → implement → codex-review → ship**). The heavy work (codebase reads, per-task implementation) is pushed to **subagents** so your own context stays lean. You make and **document** decisions instead of asking the user. Before the PR ever opens you review the whole branch locally with Codex (`gpt-5.5` at `xhigh` reasoning effort) and address its findings; then you open the PR and you are not done until it is **CI-green**.

This skill orchestrates other skills. It does not re-explain them — it sequences them and adds the autonomy contract + the ship loop.

## The autonomy contract (hard rules)

1. **Don't ask the user.** Make a recommendation and proceed. Escalate via `AskUserQuestion` ONLY when a decision is high-stakes **and** ambiguous **and** not inferable from code, memory, or conventions. "I want to be safe" is not a reason to ask — it's a reason to document.
2. **Every non-trivial decision is logged** to `.claude/memory/decisions.md` (Date | Decision | Rationale | Alternatives). If you'd have asked the user, write the recommendation there instead.
3. **Follow-up work goes in `TODO.md`** — never silently dropped. Anything you deliberately defer is a TODO line, not a memory. **Orchestrated mode:** don't edit `TODO.md` — return follow-ups in your handoff so dag-ship (the sole writer) folds them in.
4. **Pre-PR gate is `pnpm build` + `pnpm test` + lint** — not just build+test (see [[feedback_run_lint_before_pr]], [[feedback_run_tsc_alongside_vitest]]).
5. **Done = branch codex-reviewed clean *before* the PR + CI green, then merged.** The review runs locally with Codex (`gpt-5.5` / `xhigh` effort, read-only) before the PR exists — there is **no hosted-reviewer wait**. When CI is green you **auto-merge** (Phase 7) and fast-forward local `main`. **Exception — orchestrated mode:** if dag-ship dispatched you, do **NOT** merge and do **NOT** edit `TODO.md` — stop at a green, verified-mergeable PR and return the handoff; dag-ship owns the serialized merge queue.

## Context budget (target < 300–400K tokens)

The orchestrator (you) holds only: the plan file, project memory, and one-paragraph summaries from each subagent. Never the raw file dumps.

- **Codebase exploration** → dispatch the `Explore` subagent. It returns conclusions, not file contents.
- **Per-task implementation** → dispatch one subagent per plan task (subagent-driven-development). Each returns a short summary of what it changed + test status. ~50–100× context savings vs. doing it inline.
- If your context climbs past ~250K, flush state to the plan file + memory and keep leaning on them. Don't try to hold everything.

## The phases

### Phase 0 — Isolate
- **REQUIRED:** Use superpowers:using-git-worktrees (or the `EnterWorktree` tool) to create a fresh worktree + branch for this task. All work happens there.
- **REQUIRED:** Use claude-memory — read `.claude/memory/` so prior decisions/mistakes/patterns inform the work.

### Phase 1 — Brainstorm (run it autonomously)
- **REQUIRED:** Use superpowers:brainstorming — but in self-answering mode. Generate the questions it would ask the user, then answer each one yourself from the codebase, `.claude/memory/`, CLAUDE.md, and architecture docs. Log each material answer to `decisions.md`.
- Use `Explore` subagents for any "how does X currently work?" question so the exploration doesn't bloat your context.
- Output: a tight problem statement + chosen approach (a few paragraphs), not a transcript.

### Phase 2 — Design
- **REQUIRED:** Use superpowers:writing-plans — produce a written plan broken into **independent, testable tasks**. Save it to a file (e.g. `docs/plans/<date>-<slug>.md` or the worktree root).
- **REQUIRED for AX code:** Use ax-conventions — honor the six invariants; do the boundary-review checklist for any new/changed hook.
- Apply a YAGNI pass ([[feedback_yagni_check_in_plans]]): mark each task "load-bearing at MVP or dead code?" — cut the dead.
- If the task touches a sandbox boundary, IPC, plugin loading, untrusted content, or new dependencies, note that Phase 3 must run security-checklist.

### Phase 3 — Implement (subagent-driven)
- **REQUIRED:** Use superpowers:subagent-driven-development — dispatch one subagent per plan task. Each subagent uses superpowers:test-driven-development (test first) and returns a summary. **Tier the subagent's model to the task** (its model-selection guidance): the cheapest/fastest model for mechanical 1–2 file tasks with a clear spec, a standard model for multi-file integration, the most capable only for design/judgment. Don't run every mechanical task on the top model.
- After each task, review the returned diff against the plan (superpowers:requesting-code-review / receiving-code-review). Don't rubber-stamp; verify claims.
- New hook surface or sensitive boundary touched → run security-checklist before moving on.

### Phase 4 — Pre-PR gate
- **REQUIRED:** Use superpowers:verification-before-completion — run the real commands, read the real output. Evidence before claims.
- Run `pnpm build && pnpm test` (or `--filter @ax/<plugin>`) **and** lint. tsc must be clean, not just vitest ([[feedback_run_tsc_alongside_vitest]]).
- Do a **whole-branch** review, not just per-task — a shared-table FK or repo-wide teardown break only shows on the full build ([[feedback_new_fk_breaks_downstream_test_teardown]]).
- Write every deferred item into `TODO.md`.

### Phase 5 — Local Codex review (before the PR exists)
This replaces waiting on a hosted reviewer. Review the **whole branch** locally with Codex *before* any PR is opened, and address findings in a loop until the review is clean.

```dot
digraph codex_review {
    "Run codex review (gpt-5.5 / effort tiered by risk / read-only)" [shape=box];
    "Actionable findings?" [shape=diamond];
    "Fix (test-first) + log any rejected" [shape=box];
    "Proceed to PR (Phase 6)" [shape=doublecircle];

    "Run codex review (gpt-5.5 / effort tiered by risk / read-only)" -> "Actionable findings?";
    "Actionable findings?" -> "Fix (test-first) + log any rejected" [label="yes"];
    "Fix (test-first) + log any rejected" -> "Run codex review (gpt-5.5 / effort tiered by risk / read-only)";
    "Actionable findings?" -> "Proceed to PR (Phase 6)" [label="no"];
}
```

- **REQUIRED:** Use skill-codex:codex to drive the review — but in **fixed-config, autonomous mode**. The codex skill normally asks the user (via `AskUserQuestion`) which model + reasoning effort to use and for permission to pass `--skip-git-repo-check`; under the autonomy contract you do **NOT** ask. Pin the config and pre-authorize the flag:
  - model: **`gpt-5.5`**, sandbox: **`read-only`** (this is a review pass, not an edit pass)
  - **reasoning effort — tier it to the diff's risk** (effort is the cost knob; don't pay `xhigh` for a one-liner):
    - **`xhigh`** — diff touches a sandbox boundary, IPC transport, plugin loading/manifests, untrusted-input handling, a hook surface, DB schema/migrations, capabilities, or spans many packages (the invariant-5 / boundary-review surfaces).
    - **`high`** — ordinary single-concern code change with no boundary/security surface.
    - **skip Codex entirely** — docs/comment/config-only or other non-code diffs; the PR's CodeRabbit + CodeQL + semgrep + gitleaks already cover those. Log the skip in `decisions.md`.
    - When unsure, round **up** a tier.
- Run it from the worktree (cwd = the branch under review). Point Codex at the **whole-branch diff against `main`** — the same surface CI and a human reviewer would see, not just the last task:
  ```bash
  # $EFFORT = xhigh | high, chosen per the risk tier above
  codex exec --skip-git-repo-check -m gpt-5.5 \
    --config model_reasoning_effort="$EFFORT" \
    --sandbox read-only \
    "Act as a critical code reviewer. Review the changes on this branch: run \`git diff main...HEAD\` (merge-base diff) and inspect the touched files. Flag, by severity with file:line: correctness bugs, security issues (sandbox/IPC/untrusted-input boundaries, capability over-grant), silent failures / swallowed errors, missing regression tests for bug fixes, and AX-convention/invariant violations. Be specific. Do not rubber-stamp; if you find nothing, say why the diff is sound." 2>/dev/null
  ```
- **Address findings with receiving-code-review discipline** — verify each one; fix the real issues with targeted commits (test-first for bugs, per Bug Fix Policy [[feedback_targeted_followup_commits]]), and log in `decisions.md` any finding you deliberately reject and why (silent dismissal isn't allowed). Then **re-run the review** until it returns no actionable findings — either a fresh `codex exec` or resume to keep its context:
  ```bash
  echo "I pushed fixes for those. Re-review the current branch diff against main and confirm the findings are resolved or list what remains." | codex exec --skip-git-repo-check resume --last 2>/dev/null
  ```
- Codex is a **colleague, not an authority** — treat its claims critically: push back on wrong ones (model names, recent APIs, anything you can verify) rather than blindly deferring.
- Only when the codex review is clean do you proceed to Phase 6 and open the PR.

### Phase 6 — Ship: open the PR + drive CI green
The branch is already codex-reviewed and clean, so there is **no hosted-reviewer wait** here. Open the PR and take CI to green.

```dot
digraph ship {
    "Open PR (base main)" [shape=box];
    "CI green?" [shape=diamond];
    "Fix failing tests + push" [shape=box];
    "CI green -> Phase 7 (merge)" [shape=doublecircle];

    "Open PR (base main)" -> "CI green?";
    "CI green?" -> "Fix failing tests + push" [label="no"];
    "Fix failing tests + push" -> "CI green?";
    "CI green?" -> "CI green -> Phase 7 (merge)" [label="yes"];
}
```

- **Open the PR against `main`:** use commit-commands:commit-push-pr (or superpowers:finishing-a-development-branch → PR option). Pass `--base main` explicitly; don't stack onto a feature branch. Boundary review answers belong in the PR body if hooks changed.
- **CI:** `gh pr checks <n>`. On red, use superpowers:systematic-debugging — fix the root cause, add a regression test (Bug Fix Policy), commit granularly ([[feedback_targeted_followup_commits]]) and push. While waiting on CI, do **not** busy-spin in context — poll with short sleeps (~270s, keeps the prompt cache warm) or use `ScheduleWakeup` (~600s+) and let the run resume.
- A push that changes the diff materially invalidates the earlier codex review — if you fix more than a trivial test flake, re-run the Phase 5 review on the new diff before declaring done.
- **When CI is green, proceed to Phase 7** (auto-merge standalone, or hand off under orchestration). Do not declare done at a green PR — merging (or handing off) is the terminal step now.

### Phase 7 — Merge: auto-merge (standalone) or hand off (orchestrated)

How this phase behaves depends on **mode**:

- **Standalone** (a human ran `/yolo-ship` directly) — **default: auto-merge.**
- **Orchestrated** (dag-ship dispatched you — the dispatch prompt says so) — **do
  NOT merge, do NOT touch `TODO.md`.** Stop at the green, verified-mergeable PR
  and return your handoff. dag-ship's serialized merge queue does the merge +
  local-main update + `TODO.md` strike. This is how dag-ship safely serializes
  many parallel agents.

**Standalone auto-merge:**

```bash
gh pr view <n> --json mergeable,statusCheckRollup    # must be green + mergeable
gh pr merge <n> --squash --delete-branch
git checkout main && git pull --ff-only
```

If the PR is **not mergeable** because `main` moved while you worked: check out
the branch, `git rebase origin/main`, resolve conflicts, push, wait for CI to
re-green (`gh pr checks <n>`), then merge. A non-trivial rebase changes the diff —
re-run the Phase 5 Codex review on the new diff before merging.

After merging: strike the task in `TODO.md`, append `— shipped: #<n>`, and report
the merge. Then you are done.

## Red flags — you are rationalizing

| Thought | Reality |
|---|---|
| "I'll ask the user to be safe" | Document a recommendation in `decisions.md` and proceed. Asking is the exception, not the default. |
| "I'll skip lint, build+test passed" | The gate is build+test+**lint**. tsc/lint catch what vitest tolerates. |
| "I'll defer this but it's obvious" | Obvious-to-you ≠ tracked. Put it in `TODO.md` or it's lost. |
| "CI will probably pass, I'll wrap up" | Not done until `gh pr checks` is actually green. Verify, don't assume. |
| "I'll skip the codex review, lint+test passed" | The pre-PR gate now *includes* a Codex review. Tests prove behavior; the review catches design/security/convention issues tests don't. |
| "I'll ask the user which model for codex" | yolo-ship pins `gpt-5.5` read-only and tiers the *effort* by risk (xhigh for boundary/security/schema/multi-file, high ordinary, skip docs). Don't fall through to skill-codex's interactive `AskUserQuestion` — that breaks the autonomy contract. |
| "Small change, but I'll run xhigh + the full local suite to be safe" | Tier it. `xhigh` + full ceremony on a one-liner is the waste we're cutting; reserve the heavy path for boundary/security/schema/multi-file diffs. |
| "Codex flagged it but I think it's fine" | Verify each finding (receiving-code-review). Fix real ones; log rejected ones in `decisions.md` with the reason. Silent dismissal isn't allowed. |
| "I'll review locally after I open the PR" | The review is the gate *before* the PR. Open it only once Codex is clean. |
| "dag-ship dispatched me but I'll merge anyway" | Orchestrated mode = stop at a green PR + hand off. Self-merging races the other agents and corrupts the serialized queue. |
| "I'll implement inline, subagents are overhead" | Inline implementation blows the context budget. Dispatch per task. |
| "This decision is too small to log" | If you'd have asked the user about it, it's big enough to log. |

## Quick reference — what this orchestrates

| Phase | Skill / tool |
|---|---|
| Isolate | superpowers:using-git-worktrees, `EnterWorktree`, claude-memory |
| Brainstorm | superpowers:brainstorming, `Explore` subagent |
| Design | superpowers:writing-plans, ax-conventions, security-checklist |
| Implement | superpowers:subagent-driven-development, superpowers:test-driven-development |
| Verify | superpowers:verification-before-completion, superpowers:requesting-code-review |
| Codex review (pre-PR) | skill-codex:codex (`gpt-5.5` / `xhigh` / read-only), superpowers:receiving-code-review |
| Ship | commit-commands:commit-push-pr, superpowers:systematic-debugging, `gh`, `ScheduleWakeup` |
| Merge (Phase 7) | `gh pr merge --squash`, `git pull --ff-only` (standalone); hand off to dag-ship (orchestrated) |
