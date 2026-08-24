# TASK-260 — a hold is not a failure (claude-sdk transcript)

**Branch:** `auto-ship/TASK-260-hold-not-failure` · **Epic:** agent-workspace · **Parent:** TASK-236 (walk-fail)

## The defect, traced

`@ax/decisions` returns `hold({ decisionId, note })` from `tool:pre-call`. The
claude-sdk runner has no SDK-native "hold", so `pre-tool-use.ts` collapses it onto
`permissionDecision: 'deny'` with `permissionDecisionReason = note`. The CLI then
synthesises a `tool_result` with `is_error: true` whose content is that note, and
`main.ts` forwards it verbatim — as a durable `ContentBlock` and as a
`{kind:'tool-result', isError:true}` stream chunk.

Downstream, `history-adapter.ts` turns `is_error` into `state:'output-error'` and
`ToolUse.tsx` paints the group red, badges the step `FAILED`, prints the raw SDK
tool name `mcp__ax-host-tools__request_capability`, and dumps the model-facing note —
`dec_…` id and all — under an `error` heading.

Nothing failed. Three things are wrong at once: the **status** (failure vs waiting),
the **audience** (model-facing prose on a human surface), and the **identifiers**.

## The shape of the fix

One principle: **the model's copy and the human's copy of a held call are different
artifacts, and on the claude-sdk runner they already live in different stores.** The
model's context is the SDK's own JSONL; the human's transcript is the display event
log the runner publishes at `event.turn-end`. So the runner can hand each audience
what it needs without either one degrading the other.

- The JSONL keeps the full instructive note (stop, don't retry, don't route around).
- The published/streamed tool result becomes a short host-authored line written for a
  person, with `is_error` dropped so nothing renders as a failure.

Two smaller edges close the identifier half:

- `dec_…` is removed from `holdNote` **at source** in `@ax/decisions`. It has no
  consumer: the model cannot act on it, and the correlation the system actually
  enforces is the call fingerprint. Removing it makes the leak structurally
  impossible on every runner rather than relying on each runner to scrub it — and it
  fixes the same leak on the aisdk runner, whose hold text is a single artifact
  serving both audiences.
- `mcp__<server>__` is stripped at the **display** boundary (`history-adapter.ts` for
  hydration, `transport.ts` for the live stream), so the SDK's wire name never
  renders. `stripMcpToolPrefix` already exists for exactly this; it was only wired to
  artifact-chip keying.

## Explicitly NOT doing

- **No new field on `ToolResultBlock`** (`@ax/ipc-protocol`). That block is Anthropic
  content-block vocabulary; a non-Anthropic `held` flag riding a shape that can be
  handed to a provider API is a trap. Consequence, accepted: the client has no
  explicit hold state, so the step renders as an ordinary completed step whose body
  says it is waiting. The card's own bar is "distinct from a tool failure (the aisdk
  runner already shows the hold text as a tool result)" — this clears it.
- **No in-thread approval card.** TASK-261 owns mounting `ApprovalCard` on `/`,
  pinned above the composer. Coordinated directly with that agent: it is not adding a
  transcript join key and not parsing the note, so this PR is free to drop the id.
- **No change to the `decision-resolved` opening message.** Its `dec_…` rides
  `chatEndHistory` → `chat:end` (memory-strata, audit-log), never the display log.
  Out of scope; only the dangling reference is fixed (see task 1).
- **No change to the aisdk runner's `holdText`.** The card names its rendering as the
  acceptable baseline.

## Tasks

### Task 1 — `@ax/decisions`: the id leaves the prose
`packages/decisions/src/templates.ts` (+ `__tests__/templates.test.ts`, `pre-call.ts`,
`delivery.ts`, `index.ts`)

- `holdNote` drops `decisionId` from its input and from the sentence.
- `decisionApprovedNote` / `decisionDismissedNote` drop their `decisionId` parameter
  too — not for scope's sake but because a `dec_…` the model has never seen is a
  dangling reference, strictly worse than no token.
- Update the doc comments that justify the interpolation (they claim it reaches a
  runner stderr line — it does, but from the latch, not from the note).
- **Regression test:** no string this module produces matches `/dec_/`.

Load-bearing at MVP? Yes — it is acceptance bullet 2, and it is the only edit that
fixes the leak on both runners.

### Task 2 — claude-sdk runner: a held call publishes a human's line
`packages/agent-claude-sdk-runner/src/held-calls.ts` (new), `pre-tool-use.ts`,
`main.ts` (+ tests)

- New tiny module: a per-turn registry of tool-call ids that were held, plus the
  host-authored constant the display gets. No state beyond a `Set<string>`.
- `createPreToolUseHook` gains an optional `onHold(toolCallId)` callback, invoked only
  when the SDK handed us a non-empty `toolUseID` (the existing code is careful about
  `''` vs `undefined`; keep that care).
- `main.ts` records held ids, and in the `tool_result` branch, for a recorded id:
  publishes `content` = the constant and **omits** `is_error`, both on the durable
  `ContentBlock` and on the `emitChunk` payload. The registry clears at the `result`
  turn boundary, next to `drainHoldLatch` — a hold must not bleed into the next turn.
- The model's JSONL is untouched.

Load-bearing at MVP? Yes — acceptance bullets 1 and 3.

### Task 3 — display: the SDK wire name never renders
`packages/channel-web/src/lib/history-adapter.ts`, `packages/channel-web/src/lib/transport.ts` (+ tests)

- Hydration: `toolName: stripMcpToolPrefix(block.name)`.
- Live: `toolName: stripMcpToolPrefix(frame.toolName)`.
- Safe for the artifact chip: `Thread.tsx` registers `ArtifactPublishTool` under both
  the bare and the `mcp__`-prefixed name, so the bare form still resolves.
- **Note:** `transport.ts` is also being edited by TASK-261 in a different region
  (a new `decisionRaised` SSE arm). Rebase, then rebuild — do not trust the merge.

Load-bearing at MVP? Yes — acceptance bullet 2 names `mcp__ax-host-tools__*`.

### Task 4 — `ToolUse.tsx`, per the ux-design ruling
`packages/channel-web/src/components/ToolUse.tsx` (+ `src/__tests__/tool-use.test.tsx`)

The pass corrected two premises this plan started with, both verified by grep before
acting on them:

- **`ToolGroup` is dead code.** `Thread.tsx` imports only `ArtifactPublishTool` and
  `ToolFallback`; the only other reference to `ToolGroup` in the repo is its own test.
  The collapsed header a user actually sees comes from `chainOfThoughtLabel` in
  `ChainOfThought.tsx` ("Ran a command"), which has no destructive tint at all. So
  **there is no red chevron to drop and no `VERB_MAP` entry worth adding** — editing a
  lookup table nothing renders would look like a fix and be none. Cut from the plan.
  *(Update 2026-08-24 — TASK-269 deleted `ToolGroup` and `VERB_MAP` outright, so the
  code this bullet describes no longer exists. `ChainOfThought.tsx` is the only
  collapsed tool disclosure now.)*
- **The live surface is `ToolFallback` alone**, and its status word is the lie. With
  `is_error` gone, a held step would badge `DONE` one line above "Nothing has happened
  yet" — a contradiction in adjacent pixels.

So Task 4 is:

- **Delete the settled-state status word.** Render the chip only for `running` and
  `failed`. A completed step needs no word: the presence of a result block is the
  completion signal and the absence of an error is the not-failed signal. This also
  removes console jargon from every tool call, not just held ones.
- **Sentence-case the two chips that remain** (`Running`, `Failed`) — uppercase mono
  status words are developer-console vocabulary.
- **Render a string result as prose** (`font-sans`, 13px) and an object result as data
  (mono, 11px). The held line is a sentence written for a person; 11px monospace under
  a label reading `result` fails the copy bar on its own.

Deliberately NOT done, per the same ruling: no `warning` token in the transcript (it
belongs to `ApprovalCard` and `StateDot state="held"`, and a second "something needs
you" affordance two feet from the card is worse than none), no third status state (it
would have to be detected by string-matching the runner's constant, putting two
packages in charge of one sentence — the exact failure `decision-copy.ts` was written
to prevent), and no attempt to make the transcript *communicate* the hold. This card
stops the transcript lying; TASK-261's card is what tells the user.

**Regression test** (the one the Bug Fix Policy asks for): a tool result with
`is_error` absent renders no destructive class and no `error` label — on the live
streaming path and on the `history-adapter` reload path both.

### Task 5 — memory
`.claude/memory/decisions.md` gets the audience-split decision and the
no-new-wire-field decision, committed on this branch.

## Boundary review

No service-hook signature changes and no new subscriber hooks. `holdNote` /
`decisionApprovedNote` / `decisionDismissedNote` are module-internal exports of
`@ax/decisions`, not hook payloads. The `tool.pre-call` wire response is unchanged —
`{verdict:'hold', decisionId, note}` still carries the id structurally, which is where
it belongs. No new IPC action. The patch is internal implementation on both sides of
an existing boundary, so no boundary-review block is required — but it is stated here
so a reviewer does not have to re-derive it.

## Security note

Nothing here widens reach. The one substitution is host-authored constant text
REPLACING model-adjacent prose on a user surface — strictly a narrowing. The held-id
registry is populated only from the host's own `hold` verdict arriving over IPC;
model output cannot reach it, so a genuinely failed call cannot be dressed up as a
hold. No new dependency, no new path, no new spawn, no new egress.
