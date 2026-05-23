# chat-qa-sweep — design

**Date:** 2026-05-23
**Status:** design, approved for implementation
**Artifact:** a Claude-driven QA skill at `.claude/skills/chat-qa-sweep/`

## Purpose

A QA pressure-test for the chat UI. Claude drives the running chat surface against the
local kind cluster `ax-next-dev` via Playwright MCP, runs a fixed catalog of
common-activity scenarios plus a fault-injection battery, captures evidence, and emits a
structured findings report.

It **finds** problems; it does not fix them. Any real bug it surfaces is filed/fixed
separately, with a regression test, per the `CLAUDE.md` bug-fix policy. A passing sweep is
necessary, not sufficient — automated coverage is what keeps a fix from regressing.

## How it differs from `k8s-acceptance-loop`

`k8s-acceptance-loop` is a **fix-until-one-named-scenario-passes** loop: the user names a
single expected outcome and Claude iterates (rebuild / fast-loop) until it passes.

`chat-qa-sweep` is the opposite shape: **run-the-whole-battery-and-report**. It does not
iterate on fixes. It runs every scenario it can, records PASS / FAIL / GLITCH per scenario
with evidence, and hands back a report. The two skills are complementary — a failure found
by the sweep is often handed to the loop to fix.

## No duplication of cluster scaffolding

The sweep does **not** restate cluster preconditions, the browser entry point, or the
Playwright-MCP driver recipes. Those live in `k8s-acceptance-loop` and stay there as the
single source of truth:

- preconditions / first-run cluster setup → `k8s-acceptance-loop` §3
- browser entry point (port-forward to :9090, sign-in) → `k8s-acceptance-loop` §4 and
  `references/playwright-recipes.md` (Recipe 1 sign-in, Recipe 2 send-and-wait, Recipe 4
  multi-turn, Recipe 5 failure capture)

`chat-qa-sweep`'s `SKILL.md` says "assume that baseline; if the cluster isn't up, go run
`k8s-acceptance-loop` §3 first," and spends its own content on the catalog, the fault
levers + restore discipline, and the report format.

## File layout

```
.claude/skills/chat-qa-sweep/
  SKILL.md                    # when to use, run model, per-scenario protocol, stop/report rules
  references/
    scenario-catalog.md       # happy-path battery (11 scenarios, ordered)
    fault-injection.md        # chaos battery: lever · timing · expected UI surface · RESTORE
    report-template.md        # findings report format
```

## The existing UI error surfaces (what faults must land in)

The fault battery asserts that injected errors reach an *existing* error-display component,
never a silent hang or white-screen. The surfaces, in `packages/channel-web/src`:

- `components/PaneStatus.tsx` — pane-level `error` variant (`bg-destructive-soft border
  border-destructive/25`). The primary "this pane failed" chrome.
- `components/Thread.tsx` — per-message `msg-error` styling + retry affordance.
- `components/Toast.tsx` — transient error notifications.
- `components/ui/alert.tsx` — the shadcn `Alert` primitive, for inline error blocks.

A fault PASS requires the error to render in one of these **and** no console crash /
white-screen **and** (where applicable) recovery after the restore step.

## Run model

1. **Preconditions.** Confirm `ax-next-dev` is up and the chat surface loads (delegate to
   `k8s-acceptance-loop` §3/§4). If not, stop and report "environment not ready" — do not
   half-run the battery.
2. **Happy-path battery** (cluster healthy), in catalog order. Some scenarios produce
   artifacts later scenarios reuse (see ordering, below).
3. **Fault-injection battery.** For each fault: inject → observe the UI → **restore the
   cluster to a clean baseline** → confirm-clean before the next fault. Restore discipline
   is mandatory; a contaminated baseline makes every later result a lie.
4. **Report.** Emit the findings report (see format).

**Don't stop on first failure.** A pressure test wants the full picture, so record the
failure and continue. The *only* early exit is an environment/precondition failure that
makes remaining scenarios meaningless (cluster down, can't sign in, white-screen on load).

## Scenario ordering and prerequisites

Ordering matters because the deep session-reload scenario (#8) reloads a session that
**earlier scenarios created**:

- #3 (npx command) leaves a tool-call in a session.
- #5 (upload attachment) leaves an attachment in a session.
- #8 reloads a session that already contains prior turns + ≥1 tool call + ≥1 attachment,
  so it must run *after* #3 and #5 against the same session (or the catalog seeds such a
  session explicitly).

Other per-scenario prerequisites the catalog must call out:
- #3 npx — credentialed CLI tools enabled (npx allowlisted, shipped PR #126).
- #4 use-a-skill — an agent with at least one skill attached.
- #7 artifact — the agent able to `artifact_publish`.

## Happy-path battery

Each catalog entry = steps (in Playwright-MCP terms) · PASS criteria · the UI element that
proves it. Scenarios 1–10 below were the original set; **11–15 (cancel/stop, double-submit
race, hostile input, `/error` presentation sanity, glitch-as-lens) were added in the
gap-test revision** — see the Revision section at the end.

1. **New chat** — `NewSessionButton` → empty `Thread` + ready `Composer`.
2. **Always-a-response** — send a plain message → assistant turn appears *and completes*;
   no hung spinner, no empty bubble.
3. **npx command** — prompt that triggers npx → `ToolUse` block renders with output;
   exit/result visible.
4. **Use a skill** — message that should invoke an attached skill → agent demonstrably uses
   it.
5. **Upload attachment** — attach a file → `AttachmentComposerChip` in composer → on send,
   reconstructs as `AttachmentChip` on the message.
6. **Download attachment** — click an `AttachmentChip` → file downloads.
7. **Artifact creation** — prompt the agent to publish an artifact → `ArtifactChip` appears
   on the assistant message.
8. **Load old session + continue (deep)** — reload a session (from #3/#5) via `SessionRow`
   in `SessionList`. Assert the `conversations:get` read path reconstructs everything:
   - (a) prior user/assistant messages render;
   - (b) old `ToolUse` blocks display correctly (not collapsed/empty/orphaned);
   - (c) old `AttachmentChip`s render **and are still downloadable** (click → file
     downloads — exercises chip reconstruction on the read path, not just the live-turn
     path);
   then **prove context continuity**: post a new message answerable only from prior-turn
   content (e.g. "what was the output of the command you ran earlier?" / "summarize the
   file I attached"). PASS = reply demonstrably uses the old context (references the actual
   earlier tool output / attachment content). FAIL = agent answers as if the history were
   absent.
9. **Title generation** — after turn 1, the session title changes from its default to a
   generated one (SSE live-refresh + ~10s poll fallback, per PR #122).
10. **Parallel sessions** — open 2+ sessions concurrently (split panes if the UI supports
    it, else multiple tabs), interleave messages → each session gets its *own* correct
    response, no cross-talk, no response landing in the wrong pane.
11. **Glitch sweep** — woven through every scenario above: no console errors, no
    white-screen, every spinner resolves, every chip renders, no orphaned/duplicated
    messages, layout/scroll stays sane.

## Fault-injection battery (4 faults)

Each fault = lever · inject-timing · expected UI surface · restore. Faults are injected
**mid-stream** (during an in-flight turn) unless noted.

- **A. Sandbox killed mid-session** — `kubectl -n ax-next-runners delete pod <runner>`
  while a turn is streaming. Expected: error surfaced via `PaneStatus`/`msg-error`/`Toast`,
  *not* a silent hang; a subsequent message respawns a sandbox and works. Restore: none
  (pod is gone; next turn respawns).
- **B. Host killed mid-session** — delete / `rollout restart` the host pod mid-turn.
  Expected: connection-lost / network error surfaced; after the host is Ready again the
  session reloads and continues. Restore: wait for host `Ready`.
- **C. LLM provider error** — swap `anthropic.apiKey` to garbage (`helm --set` + restart),
  then send a message. Expected: a provider error surfaced in the UI, not swallowed.
  Restore: re-set the real key + restart. **Note:** a bad key yields a 401-style provider
  *rejection*; true quota exhaustion ("out of tokens", 429) can't be forced on demand, so
  this lever stands in for the whole "provider rejects the request" class.
- **D. Temporary network error** — kill the client↔host port-forward mid-request. Expected:
  `Failed to fetch` / `net::ERR_*` → UI shows a network/retry state (not a white-screen or
  silent stall); recovers when the forward is restarted. Restore: restart the port-forward.

**Fault PASS** = error reaches an existing error component **and** no console crash /
white-screen **and** recovery works after restore. **Fault FAIL** = silent hang,
white-screen, unhandled exception in console, or error swallowed entirely.

## Report format

`references/report-template.md` defines:

1. **Results table** — `Scenario | Category (happy/fault) | Result (PASS/FAIL/GLITCH) |
   Evidence (snapshot ref, network status, screenshot) | UI surface used`.
2. **Glitch log** — console errors and visual anomalies, each with a screenshot reference.
3. **Cluster-restored checklist** — every fault's restore step confirmed (so the cluster is
   left clean).
4. **Triage summary** — for each non-PASS, a one-line call: real bug vs environment, and a
   pointer to hand it to `k8s-acceptance-loop` if it's a fixable behavior.

## What this skill does NOT do

- It doesn't fix bugs. Findings are filed/fixed separately, with a regression test.
- It doesn't pick its own scenarios at random — the catalog is fixed so runs are
  comparable across sessions.
- It doesn't restate cluster setup or the Playwright driver basics — those are
  `k8s-acceptance-loop`'s.
- It doesn't deploy to a real cluster; it targets `ax-next-dev` (kind) only.
- It mutates cluster state (pod kills, key swaps, port-forward) — so the restore checklist
  is part of "done," not optional cleanup.

## Voice & tone

User-facing copy in the skill follows `CLAUDE.md`'s nervous-crab voice: self-deprecating
about our paranoia, direct when describing real failures. The report itself stays plain and
factual — when something is broken, say so with the evidence.

## Revision — gap-test outcome (2026-05-23)

After drafting the four skill files, the skill was tested per `writing-skills` with two
subagents: a **baseline** (plan a chat-UI pressure test from first principles, no skill)
and a **with-skill reviewer** (read the skill, produce an execution plan, critique harshly).
A live-cluster run isn't feasible from this seat, so this retrieval/application gap test was
the right-sized check for a reference skill. Both surfaced real improvements, folded in:

**Correctness / safety (must-fix):**
- **Fault C was cluster-bricking.** The restore did `--set anthropic.apiKey="$ANTHROPIC_API_KEY"`;
  if that env var is unset, it sets the key to an empty string and bricks the cluster while
  looking like it succeeded. Now: capture the live key to a **file on disk** before
  injecting, refuse to inject if capture fails, restore from that file, refuse to restore an
  empty value, and record the inject path (helm vs DB credential).
- **Port-forward via the background-run mechanism, not a bare `&`.** Shell state doesn't
  persist between tool calls, so a `&`-job from one call isn't reliably alive in the next —
  which silently contaminated faults B/C/D. The "capture to a file" fix above also addresses
  this for the key.
- **Max-wait rule.** Every `browser_wait_for` is bounded; elapsed bound = the definition of
  "hung spinner" = FAIL. One stuck scenario can't stall the sweep.
- **Ordering contradiction resolved.** "Run all in order" fought the real dependency. Added
  an explicit dependency graph: only #3 → #5 → #8 share a session (and #6 needs #5);
  everything else is order-independent. #4 is standalone.

**Grounding / coverage (verified against the code, then added):**
- Assert on the **accessibility tree** (roles/text/CSS like `.agent-status`, `.msg-error`),
  not React source names — `browser_snapshot` returns a11y, not component names.
- Documented the real **two-phase wire** (`POST /api/chat/messages` → 202 `{conversationId,
  reqId}`, then `GET /api/chat/stream/:reqId` SSE; `/api/chat/title-events`; the ~1s
  `conversations:get` read lag; `DELETE …` soft-delete cleanup).
- Corrected the error-surface list to include `AgentStatus` (status-row errors + stop/retry/
  dismiss), which was under-described.
- Added scenarios **11 cancel/stop**, **12 double-submit race**, **13 hostile input**
  (empty/huge/multibyte/markdown-injection), **14 error-presentation sanity** via the
  client-side `/error` + `/status` dev triggers (a deterministic, backend-free check of the
  three error UIs — `transient`→status-row, `inline`→`.msg-error`, `toast`→Toast), and **15
  glitch-as-lens** (incl. a narrow-viewport `browser_resize` glance).
- Fault A gained a **warm-runner-reuse caveat** (PR #124 — confirm you kill the *serving*
  pod, use a long stream) and a *runner-never-spawns* variant; Fault B prefers `rollout
  restart` over a wedge-prone `delete pod`; Fault C notes a *mid-stream truncation* variant.

The strongest part per the reviewer: the description triggers cleanly and the
"Not the same as k8s-acceptance-loop" table disambiguates the two skills well.
