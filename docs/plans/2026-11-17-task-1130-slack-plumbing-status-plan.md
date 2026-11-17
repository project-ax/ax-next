# TASK-1130: Slack hides the SDK's ToolSearch plumbing from the status line — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Slack reply never shows a status line for the Claude Agent SDK's `ToolSearch` call (it loads a deferred tool's schema) or for that call's step summary. The web's step panel already hides both. Every other status, real calls' step summaries included, shows as it does today.

**Architecture:** channel-slack only, plus a comment in channel-web. `turn.ts` gets a local twin of channel-web's `PLUMBING_TOOL_NAMES` (`new Set(['ToolSearch'])`, exact names). In `onChunk`, a `tool-use` for a plumbing call sets no status and doesn't count as said. A `step-summary` whose call id this turn recorded under a plumbing name (the existing `toolNames` map) is dropped. Paragraph breaks, holds and artifacts are unchanged. A test reads the web's set from its source, so the twins can't drift silently. No hook, payload, IPC, manifest or UI change.

**Tech Stack:** TypeScript, vitest, `@ax/channel-slack` (host plugin), one comment in `@ax/channel-web`.

**Spec:** the card (TASK-1130, from the TASK-1097 walk, `deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md:62`; extra evidence: `deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md` finding 2) and `docs/plans/2026-11-09-channel-slack-design.md` §5 (the status line). Planner decisions and rejected alternatives: `.claude/memory/decisions/2026-11-17-TASK-1130.md`. Read it. Task 1 appends its security-checklist row there.

## The problem, measured

- **The walk's two lines are not runner narration or model text.** They are `@ax/step-summaries` lines: the fast model's one-line summary of the reasoning before a tool call, sent as a `step-summary` chunk keyed by the call id. The builder measured this in kind's `conversations_v1_events` on 2026-11-17:
  - "Loading the routine creation tool schema." summarized a `ToolSearch` call (input `select:mcp__ax-host-tools__routine_create,…`), in both walk conversations.
  - "Generating a unique request identifier for retry." summarized a real `routine_create` retry.
  - 10 of the 46 summaries stored on kind are for `ToolSearch` calls.
- **Slack.** `turn.ts:597-607` sends each tool-use's phrase (or "Working") and every step summary to `stream.status`. That sets the title of the reply's single `task_update` card (`reply-stream.ts:43-47`). Slack can't remove the card, and it ends ✓ with whatever its latest title was.
- **Web.** `shapeSteps` drops calls named exactly `ToolSearch` (`channel-web/src/lib/workspace-steps.ts:676-696`, #1140), on both the live path and reload. A summary is only ever drawn as its own call's `intent`, matched by call id. The live title (`liveNote`, `reply-groups.ts:173`) reads intents of shown steps only. So the web never shows the first line. It does show the second one: as the live title, and as an intent row in the panel.
- **Why the line survives a later retitle.** A summary is computed off the stream's path (`step-summaries/src/plugin.ts:139-146`), and `ToolSearch`'s own result comes back almost at once. So the line shows live. It also stays as the finished title whenever it lands after the next call's status, or when nothing else reports before the turn ends. A held call ends the turn and its sink right away (`turn.ts:796-800`), usually before that call's own summary comes back.

## Design (decided; the alternatives are in the decisions shard)

- **Plumbing** means the `toolName` is exactly in `PLUMBING_TOOL_NAMES` = `['ToolSearch']`. `mcp__notion__ToolSearch` and `toolsearch` are real steps, the same rule the web uses.
- **`tool-use` for a plumbing call:** `toolNames` still records it. No `stream.status`, and `said` stays unchanged.
- **`step-summary`:** dropped when `toolNames.get(toolCallId)` is a plumbing name. `said` stays unchanged. A summary with no call id, or for a call this turn never saw, shows as it does today.
- **Unchanged:**
  - The started/cap/grace bookkeeping: a plumbing chunk still means the turn has begun.
  - `BREAKS_TEXT`: a plumbing call still starts a new paragraph.
  - `tool-result`: a held plumbing call still ends the reply with the held line. A hold is never hidden.
  - Artifacts.
- **Turns that only load a schema and say nothing else:**
  - Woken turn (after Allow): it has said nothing, so it ends quietly (`said-nothing`) instead of posting a lone ✓ card.
  - Invoke turn: it says `COPY.emptyReply`, like any reply with nothing to show.
- **Real calls' step summaries stay the status title.** The web shows them too. The finished title differs on purpose (TASK-1093 decisions: Slack has no host verb table, and a "Working ✓" title was rejected).

## Global Constraints

- No hook, payload, IPC, manifest or UI change, so no boundary review.
- channel-slack must not import channel-web (invariant 2). The twin is a local constant, checked by a test that reads the web's source. Precedent: `HOST_RE` in `permission-prompts.ts:100-113`, checked by `permission-prompts.test.ts:105-115`.
- Exact-name match only: `'ToolSearch'`.
- Nothing new is logged. No text, tool name or summary reaches a log line.
- No literal invisible characters in source (`source-hygiene.test.ts`).
- Commands:
  - `--filter` goes before the script: `pnpm --filter @ax/channel-slack test`.
  - One file: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/router.test.ts -t "<name>"`.
  - Tests aren't type-checked by `tsc` here, so also run `pnpm --filter @ax/channel-slack build`.
- Full gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- Memory:
  - New rows go only in two shards: `.claude/memory/decisions/2026-11-17-TASK-1130.md` and `.claude/memory/context/2026-11-17-TASK-1130.md`.
  - Never touch a root archive. Never edit or delete an existing memory line. The stale VISUALS-1 row stays as it is; a new row corrects it (Task 3).
- PR body and comments: package names like `@ax/step-summaries` only inside backticks.
- User-facing prose (changeset, report notes): CLAUDE.md voice. Plain words, short sentences, "we".

## Review Focus

1. **The plumbing summary lands after the next real call's status.** It's computed off the stream's path. The card must keep the real call's title. Pinned by Task 1, test B.
2. **A turn that only loads a schema, then ends.** An invoke turn posts the empty-reply line and no card. A woken turn ends quietly (`said-nothing`) and posts nothing. Pinned by Task 1, tests D and E.
3. **A tool that is only named like it** (`mcp__notion__ToolSearch`, `toolsearch`) is a real step. Its "Working" status and its summary both show. Pinned by Task 1, test C.
4. **Text before and after a plumbing call** stays as two paragraphs, with no "On it.Done." glue. Pinned by Task 1, test A.
5. **A plumbing call held for approval.** Never seen in practice, but possible in principle. The reply still ends with the held line. Pinned by Task 1, test F.

## Files

| File | Change | Task |
|---|---|---|
| `packages/channel-slack/src/turn.ts` | exported `PLUMBING_TOOL_NAMES` after `ARTIFACT_TOOLS` (:243-252); `onChunk` `tool-use` and `step-summary` cases (:597-607); `toolNames`/`said` comments (:545-557) | 1 (2: one comment sentence) |
| `packages/channel-slack/src/__tests__/router.test.ts` | tests A–D and F after "a step summary retitles the card…" (:809-830) | 1 |
| `packages/channel-slack/src/__tests__/turn.test.ts` | test E (one row, :1452-1467); the drift test | 1, 2 |
| `packages/channel-web/src/lib/workspace-steps.ts` | comment only (:676-684): name the Slack twin | 2 |
| `docs/plans/2026-11-09-channel-slack-design.md` | §5 status line (:373-374) | 3 |
| `deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md` | :62, attribution note | 3 |
| `deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md` | :34 and :57, finding 2 | 3 |
| `.claude/memory/context/2026-11-17-TASK-1130.md` | new shard | 3 |
| `.changeset/slack-plumbing-status.md` | new, patch | 3 |

Order: 1 → 2 → 3. Task 2 imports Task 1's export, and Task 3 describes both.

---

### Task 1: Slack drops the plumbing call's status and its summary `[tier: sensitive]`

**security-checklist: required.** CLAUDE.md invariant 5 applies: `onChunk` handles untrusted runner chunks (the `toolName` a runner reports, and a fast model's summary text). Here is the walk you should expect. Verify each point against the code; don't copy it.

- **Sandbox:** no new route, Slack method, egress, file, process or env read. The filter is an exact Set lookup on fields the registry already narrowed with `typeof`. It only removes display; it never adds anything.
- **Prompt injection:** a model (or a compromised runner) can label a chunk `ToolSearch`. The most that buys is hiding that one call's status and its summary, which a runner could already do by not sending them. Holds, artifacts, permission cards, text and the failure line are untouched.
- **Supply chain:** no new dependency.

Append the walk as one row to the decisions shard, and paste it into the PR's `## Security review`.

**Files:**
- Modify: `packages/channel-slack/src/turn.ts:243-252` (add the twin after `ARTIFACT_TOOLS`), `:545-557` (comments), `:597-607` (`onChunk`)
- Test: `packages/channel-slack/src/__tests__/router.test.ts` (inside `describe('createEventRouter: a DM from the owner')`, after the test at :809-830)
- Test: `packages/channel-slack/src/__tests__/turn.test.ts:1452-1467`

**Interfaces:**
- Produces: `export const PLUMBING_TOOL_NAMES: ReadonlySet<string>` in `packages/channel-slack/src/turn.ts`, value `new Set(['ToolSearch'])`. Task 2 imports it.

- [ ] **Step 1: Write the failing tests.**

  **The ordering trap.** The `world()` harness fires a whole script before the first flush (`FLUSH_INTERVAL_MS` = 1 s), so the one card holds whatever the latest title was. A plumbing summary followed by any later status would be hidden even without the fix. In every test below, the plumbing summary is the last status.

  In router.test.ts, add these shared helpers next to the new tests:

  ```ts
  const toolSearch = (id: string) => ({
    kind: 'tool-use', toolCallId: id, toolName: 'ToolSearch',
    input: { query: 'select:mcp__ax-host-tools__routine_create' },
  });
  const LOADING = 'Loading the routine creation tool schema.';
  const cards = (calls: readonly SlackCall[]) =>
    calls.flatMap(chunksOf).flatMap((c) => (c.type === 'task_update' ? [[c.title, c.status]] : []));
  ```

  Each test does `world()`, `w.scripts.push({ chunks, end: 'turn-end' })`, `await w.dispatch(INSTALL, dm())`, `await w.idle()`.

  - **A** `"the SDK's ToolSearch is plumbing: neither the call nor its step summary shows, and the text after it still starts a new paragraph"`
    - Chunks: `{kind:'text', text:'On it.'}`, `toolSearch('ts1')`, `{kind:'step-summary', toolCallId:'ts1', text: LOADING}`, `{kind:'tool-result', toolCallId:'ts1', output:'loaded'}`, `{kind:'text', text:'Done.'}`.
    - Expect `cards(w.slack.calls)` to equal `[]`.
    - Expect `replyIn(w.slack.calls, DM_ALICE)` to be `'On it.\n\nDone.'`.
  - **B** `"a ToolSearch summary that lands after the next call began doesn't retitle the card"`
    - Chunks: `toolSearch('ts1')`; `{kind:'tool-result', toolCallId:'ts1', output:'loaded'}`; `{kind:'tool-use', toolCallId:'c1', toolName:'mcp__ax-host-tools__routine_create', input:{}, activityPhrase:'Creating a routine'}`; `{kind:'step-summary', toolCallId:'c1', text:'Creating a daily noon reminder.'}`; `{kind:'step-summary', toolCallId:'ts1', text: LOADING}` (with the comment "@ax/step-summaries answers off the stream's path: the plumbing call's line can come last"); `{kind:'tool-result', toolCallId:'c1', output:'{"routineId":"rt_1"}'}`; `{kind:'text', text:'Set for noon every day.'}`.
    - Expect `cards(...)` to equal `[['Creating a daily noon reminder.', 'in_progress'], ['Creating a daily noon reminder.', 'complete']]`.
    - Expect the reply to be `'Set for noon every day.'`.
  - **C** `it.each(['mcp__notion__ToolSearch', 'toolsearch'])('a tool only named like it (%s) is a real step: its status and its summary show')`
    - Two DMs. The second is `dm({ ts: '1763035300.000300' })`, as the existing two-turn test at :809 does.
    - Script 1: `{kind:'tool-use', toolCallId:'c1', toolName: name, input:{}}`, `{kind:'text', text:'Looking.'}`.
    - Script 2: `{kind:'tool-use', toolCallId:'c2', toolName: name, input:{}}`, `{kind:'step-summary', toolCallId:'c2', text:'Searching the team wiki for the roadmap.'}`, `{kind:'text', text:'Found it.'}`.
    - Expect `cards(...).map(([title]) => title)` to equal `[COPY.statusDefault, COPY.statusDefault, 'Searching the team wiki for the roadmap.', 'Searching the team wiki for the roadmap.']`.
  - **D** `'a turn whose only call was ToolSearch, and that said nothing: the empty-reply line, and no card'`
    - Chunks: `toolSearch('ts1')`, its `step-summary` (`LOADING`), its `tool-result`.
    - Expect `cards(...)` to equal `[]`.
    - Expect the reply to be `COPY.emptyReply`.
  - **F** `'a ToolSearch call held for approval still ends the reply with the held line: a hold is never hidden'`
    - Chunks: `toolSearch('ts1')`, `{kind:'tool-result', toolCallId:'ts1', output:'Held for approval', held:true}`.
    - Expect `cards(...)` to equal `[]`.
    - Expect the reply to be `COPY.heldForSender(TODAY)`. There's no decisions service in `world()`, so this is the Today line, as in the test at :857.

  In turn.test.ts, add one row to `"a turn-end after %s: no message, and the quiet end is logged by code"` (:1452). The existing assertions apply: no Slack call, no sink left, one `said-nothing` line.

  - **E** `['only a ToolSearch schema load and its step summary', [{kind:'tool-use', toolCallId:'toolu_ts', toolName:'ToolSearch', input:{query:'select:mcp__ax-host-tools__routine_create'}}, {kind:'step-summary', toolCallId:'toolu_ts', text:'Loading the routine creation tool schema.'}, {kind:'tool-result', toolCallId:'toolu_ts', output:'loaded'}]]`

- [ ] **Step 2: Run them and check the failures.**

  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/router.test.ts src/__tests__/turn.test.ts -t "ToolSearch|named like it"`

  Expected:
  - **A and D fail:** a card titled "Loading the routine creation tool schema." appears.
  - **B fails:** the card is titled with that line.
  - **E fails:** a `startStream`/`stopStream` pair is posted.
  - **C and F pass already.** They guard against filtering too much.

- [ ] **Step 3: Implement it in `turn.ts`.**

  - **The twin.** After `ARTIFACT_TOOLS`, add `export const PLUMBING_TOOL_NAMES: ReadonlySet<string> = new Set(['ToolSearch']);`. Its doc comment says:
    - These calls are the runner's own plumbing, not something the agent did, so they get no status and no step summary.
    - `ToolSearch` is the Claude Agent SDK loading a deferred tool's schema before the agent can call it.
    - Exact name only: a connector's own `mcp__x__ToolSearch` is a real step.
    - This is a twin of channel-web's `PLUMBING_TOOL_NAMES` (`packages/channel-web/src/lib/workspace-steps.ts`), which hides the same calls from the web's step panel. It's kept here rather than imported (invariant 2). Change them together.
  - **A private helper.** Add `function isPlumbing(name: string | undefined): boolean`. TypeScript rejects `has(undefined)`.
  - **`case 'tool-use'`.** Keep the `toolNames.set(…)` line first. Then, if `isPlumbing(c.toolName)`, return, before `said = true` and `stream.status`.
  - **`case 'step-summary'`.** If `c.toolCallId !== undefined && isPlumbing(toolNames.get(c.toolCallId))`, return, before `said` and the status. Otherwise behave as today.
  - **Keep both checks inside the `switch`.** The started/cap/grace lines and the `BREAKS_TEXT` bookkeeping above it must still see plumbing chunks.
  - **Comments.**
    - `toolNames` gets one line: "Every call's tool name by id: a result finds its artifact tool here, and a step summary its plumbing call."
    - The `said` comment (:553-557) gains: "A plumbing call (PLUMBING_TOOL_NAMES) and its summary are none of these."

- [ ] **Step 4: Run the package and build it.**

  Run: `pnpm --filter @ax/channel-slack test && pnpm --filter @ax/channel-slack build`

  Expected: all tests pass, including the five existing status tests (:778-830, and :1586-1597 in turn.test.ts), and `tsc` is clean.

- [ ] **Step 5: Mutation check.**

  Predict which tests each mutant should kill, then run them. Restore each file per yolo-ship › "Mutation testing: restore without clobbering".

  | Mutant | Should kill |
  |---|---|
  | M1: drop the `tool-use` return | A, D, E |
  | M2: drop the `step-summary` check | A, B, D, E |
  | M3: use `includes`/`endsWith`/case-insensitive matching | C |
  | M4: set `said = true` before the plumbing return | E |
  | M5: drop every chunk of a plumbing call at the top of `onChunk`, tool-result included | A (the text glues), F (the held line is lost) |

  Record the counts in the security-checklist row.

- [ ] **Step 6: Run the security-checklist walk.** Append its row to `.claude/memory/decisions/2026-11-17-TASK-1130.md`.

- [ ] **Step 7: Commit.**

  ```bash
  git add packages/channel-slack/src/turn.ts packages/channel-slack/src/__tests__/router.test.ts packages/channel-slack/src/__tests__/turn.test.ts .claude/memory/decisions/2026-11-17-TASK-1130.md
  git commit -m "[TASK-1130] Slack: the SDK's ToolSearch and its step summary never touch the status line"
  ```

---

### Task 2: Keep the twin honest `[tier: integration]`

**Files:**
- Test: `packages/channel-slack/src/__tests__/turn.test.ts` (imports; a new `describe` at the end)
- Modify: `packages/channel-slack/src/turn.ts` (one sentence in the twin's comment)
- Modify: `packages/channel-web/src/lib/workspace-steps.ts:676-684` (comment only)

**Interfaces:**
- Consumes: `PLUMBING_TOOL_NAMES` from `../turn.js` (Task 1).

- [ ] **Step 1: Write the drift test.**

  Add imports: `readFileSync` from `node:fs`, `fileURLToPath` from `node:url`, and `PLUMBING_TOOL_NAMES` from `../turn.js`.

  The helper is anchored to the start of a line, so a comment that mentions the name can't match (patterns.md, TASK-331):

  ```ts
  /** channel-web's PLUMBING_TOOL_NAMES as its source spells it: read from the file, never imported (invariant 2). */
  function webPlumbingToolNames(): string[] {
    const file = fileURLToPath(new URL('../../../channel-web/src/lib/workspace-steps.ts', import.meta.url));
    const found = /^[ \t]*(?:export[ \t]+)?const[ \t]+PLUMBING_TOOL_NAMES\b[^=\n]*=[ \t]*new Set\(\[([^\]]*)\]\)/m
      .exec(readFileSync(file, 'utf8'));
    if (found === null) throw new Error('channel-web/src/lib/workspace-steps.ts no longer spells PLUMBING_TOOL_NAMES the way this test reads it');
    const names = [...found[1]!.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]!);
    if (names.length === 0) throw new Error("read no names from channel-web's PLUMBING_TOOL_NAMES");
    return names;
  }
  ```

  The test: `describe("PLUMBING_TOOL_NAMES: channel-web's twin (TASK-1130)")` › `it("names exactly the calls the web's step panel hides")`, asserting `expect([...PLUMBING_TOOL_NAMES].sort()).toEqual(webPlumbingToolNames().sort())`.

- [ ] **Step 2: Prove it can fail, then restore.**

  Both sets are `['ToolSearch']` today, so the guard is proven by mutants:
  - (a) Add `'Skill'` to channel-slack's set. The test should fail and show both lists.
  - (b) Change the regex's constant name to `PLUMBING_TOOL_NAMEZ`. The test should throw "no longer spells…".

  Restore both (yolo-ship › restore without clobbering), then run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/turn.test.ts -t "twin"`. Expected: PASS.

- [ ] **Step 3: Point the two comments at each other.**

  - **channel-slack's twin comment** gains: "turn.test.ts reads the web's from its source and fails when the two differ."
  - **channel-web's comment** (:676-684) gains a paragraph:

    > channel-slack keeps a twin (`PLUMBING_TOOL_NAMES` in packages/channel-slack/src/turn.ts): there, neither the call nor its step summary changes a reply's status line. Its turn.test.ts reads this set from this file and fails when the two differ, so change them together, and keep it a `new Set([...])` of quoted names (that's what it reads).

  No channel-web code changes.

- [ ] **Step 4: Run the tests and build.**

  Run: `pnpm --filter @ax/channel-slack test && pnpm --filter @ax/channel-slack build`. Expected: PASS.

  channel-web only gets a comment. The Phase 4 full gate builds and tests it.

  Known gap, accepted (decisions shard): CI selects affected packages, so a channel-web-only PR won't run this test. It runs on the next PR that touches channel-slack, or on a full run. The `HOST_RE` precedent has the same gap.

- [ ] **Step 5: Commit.**

  ```bash
  git add packages/channel-slack/src/__tests__/turn.test.ts packages/channel-slack/src/turn.ts packages/channel-web/src/lib/workspace-steps.ts
  git commit -m "[TASK-1130] Keep Slack's PLUMBING_TOOL_NAMES twin in step with the web's (drift test)"
  ```

---

### Task 3: Correct the stale lines, and add the changeset `[tier: mechanical]`

These are yolo-ship rule 5 fixes: the lines that made this card read as "runner narration", and a stale memory row that says the web shows `ToolSearch`.

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md:373-374`
- Modify: `deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md:62`
- Modify: `deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md:34`, `:57`
- Create: `.claude/memory/context/2026-11-17-TASK-1130.md`. Get the path with `target=$(scripts/memory-write-target.sh --shard context TASK-1130)`, never a variable called `path`, then `mkdir -p "$(dirname "$target")"`.
- Create: `.changeset/slack-plumbing-status.md`

- [ ] **Step 1: Update the design doc §5.** After "(one `task_update` card that changes in place)." on :374, add, keeping the bullet's indentation:

  > Its title is the latest thing the turn reported: a step summary, or a call's activity phrase ("Working" without one). The Claude Agent SDK's `ToolSearch` (it loads a deferred tool's schema) is plumbing, not a step: as in the web's step panel (#1140), neither that call nor its step summary touches the line (TASK-1130).

- [ ] **Step 2: Add a note to the TASK-1097 report.** At the end of :62, add:

  > *Measured later (TASK-1130): it wasn't runner narration or model text. Both are `@ax/step-summaries` lines, shown as the reply's status card title. The first summarizes the SDK's `ToolSearch` call (loading a tool's schema), which the web already hid and Slack now hides too. The second is a real `routine_create` call's summary, which the web shows as well.*

- [ ] **Step 3: Correct the TASK-1134 report.**

  - On :34, replace "This ties to TASK-1130." with:

    > These were the model's own words, not runner narration or a step summary (measured during TASK-1130), so they need a follow-up of their own.

  - Replace :57 with:

    > - Finding 2 needs its own follow-up (the model's words, measured during TASK-1130), and finding 10 belongs to TASK-1133.

- [ ] **Step 4: Write the context shard.**

  Heading: `# TASK-1130 — Slack status line and runner plumbing (context)`. Then three bullets, each starting `- 2026-11-17 — `:

  1. **CORRECTS `context/2026-11-06-VISUALS-1.md`, the row ending "nothing in channel-web special-cases ToolSearch".**
     - That row was written in #1135 (e4e4e89f9, 08:03 -0500). #1140 (f505c964e, 10:13 the same day) added `PLUMBING_TOOL_NAMES` to `channel-web/src/lib/workspace-steps.ts`.
     - Since then, `shapeSteps` has dropped calls named exactly `ToolSearch` on both the live path and reload. Their step summaries go with them, because a summary is drawn as its call's `intent`.
     - Since TASK-1130, channel-slack keeps a twin in `turn.ts`, checked against the web's by `turn.test.ts`.
  2. **Slack's "narration" lines were `@ax/step-summaries` lines, not runner or model text.** Measured on kind, `conversations_v1_events`, 2026-11-17.
     - "Loading the routine creation tool schema." summarized a `ToolSearch` call.
     - "Generating a unique request identifier for retry." summarized a real `routine_create` retry.
     - 10 of the 46 summaries stored on kind were for `ToolSearch`.
     - Slack drew each summary as the status card's title. When a line in a reply looks like narration, check the conversation's `step-summary` events first.
  3. **TASK-1134 finding 2 was the model's own text** (assistant `text` blocks).
     - "…is now connected!" came right after `request_capability`'s re-issued call returned `{"status":"requested"}`.
     - "queued" paraphrased the hold note.
     - Not a channel-slack bug.

- [ ] **Step 5: Write the changeset.** `.changeset/slack-plumbing-status.md`:

  ```md
  ---
  '@ax/channel-slack': patch
  ---

  Slack replies no longer open with lines like "Loading the routine creation tool schema." That was the agent quietly fetching a tool's instructions before using it: housekeeping, not news. The web app already kept it out of sight, and now Slack does too. What the agent is actually doing still shows on the reply's status line.
  ```

- [ ] **Step 6: Verify.**

  Run: `scripts/memory-append-check.sh`. Expected: exit 0 (shard-only, no deletions).

  Run: `git diff --stat origin/main...HEAD`. Expected: only this plan's files.

- [ ] **Step 7: Commit.**

  ```bash
  git add docs/plans/2026-11-09-channel-slack-design.md deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md .claude/memory/context/2026-11-17-TASK-1130.md .changeset/slack-plumbing-status.md
  git commit -m "[TASK-1130] Correct the narration attribution; design doc §5; changeset"
  ```

---

## Handoff notes for the builder

**Follow-ups.** Return these in the handoff; auto-ship files them, not you.

- **F1, `@ax/step-summaries`.** Spend no fast-model call on `ToolSearch`: about 1 in 5 summaries on kind, and neither channel shows them. Also decide whether the reasoning before it should carry to the next real call. That would make step-summaries a third holder of the plumbing list.
- **F2, the `@ax/step-summaries` prompt.** Lines narrate argument mechanics ("Generating a unique request identifier for retry.") rather than the person's goal. Both channels show them.
- **F3, TASK-1134 finding 2.** The model read `request_capability`'s `{"status":"requested"}` as "now connected!" and paraphrased the hold note as "queued". It's tool-result wording or agent guidance, not a channel bug.

**Learning to forward.** The card's own text ("runner narration") is board text, not a repo line, so it's corrected in the PR and the handoff, not in a file.
