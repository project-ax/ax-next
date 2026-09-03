# TASK-270 plan — persisted "held" flag + Waiting treatment

## Problem
A held tool call has no persisted state. TASK-260 fixed the publish-time copy
(`is_error` omitted + host-authored "Waiting for you to choose…" line), so a
fresh hold no longer renders red — but on reload the transcript reader
(`history-adapter.ts` `collectToolResults`) sees `is_error !== true` and maps
the step to `output-available`, i.e. an ordinary completed step. Pre-TASK-260
rows (`is_error: true` + model note) still render red on reload. ToolUse.tsx
says it outright: "A real hold state needs a persisted flag first, and that is
its own card." This is that card.

## Approach
Runner-published `held: true` (optional boolean, absent = not held) on the
`tool_result` content block (persisted) and the live `tool-result` chunk, read
by channel-web into a toolCallId-keyed display map (the TASK-271 pattern twin),
rendered by ToolFallback as a third `Waiting` state in `text-warning`.

Why runner-published: the runner already knows per-call at publish time
(claude-sdk `HeldCallRegistry`, aisdk hold branch) — honest source, no
inference. Host-side stamping at turn-end ingress was rejected: the host would
have to re-infer which result belongs to a hold verdict across a runner-defined
turn boundary (stateful, racy), and the live chunk can only be marked at emit
time anyway.

Field name `held`: matches HoldLatch / HeldCallRegistry / policy `hold`
verdict / workspace `held` state vocabulary. Transport- and storage-agnostic
(domain word, no backend leak — invariant 1).

## Tasks
1. **ipc-protocol**: `held: z.boolean().optional()` on `ToolResultBlockSchema`
   (content-blocks.ts) + tool-result variant of `EventStreamChunkSchema`
   (events.ts). Tests: round-trip with flag; without-flag parses as before
   (strip-vacuity: optional-field additions are invisible to round-trips, so
   also assert read-path preservation via the conversations re-validation —
   covered in task 6).
2. **runner-core**: new `held-calls.ts` — move `createHeldCallRegistry` /
   `HeldCallRegistry` here from agent-claude-sdk-runner (generic per-turn
   set, no SDK dependency; both runners need it and I2 forbids cross-plugin
   import). Re-export from index. `StreamChunk` tool-result variant gains
   `held?: boolean`.
3. **claude-sdk runner**: import registry from runner-core (keep
   `HELD_TOOL_RESULT_TEXT` + its comment local); when `wasHeld`, set
   `held: true` on the normalized block AND the emitted chunk. Tests in
   held-calls.test.ts / main.test.ts style.
4. **aisdk runner**: add optional `onHold?: (toolCallId) => void` to
   `WrapWithPolicyOptions` (mirrors pre-tool-use's `onHold`), thread through
   the tool builders; main.ts owns a runner-core registry per turn
   (reset with the latch); `toTurnBlocks(..., isHeld?)` marks blocks; live
   `tool-result` / `tool-error` chunks consult the registry. NO content
   change: `holdText(note)` stays — on this runner the transcript IS the
   model context, so replacing it would degrade the model. Tests:
   policy-wrap onHold fires with the call id; turn-blocks marks only held ids.
5. **channel-web server**: sse.ts tool-result fence allows optional boolean
   `held` (mirror `isError`: mistyped → drop chunk, same as sibling);
   server/types.ts SseFrame tool-result gains `held?: boolean`. Tests in
   sse.test.ts.
6. **channel-web client**: new `lib/tool-held.ts` (bounded toolCallId→held
   map + clear seam, twin of tool-phrase.ts); transport.ts stashes
   `frame.held === true` on tool-result frames; history-adapter.ts
   `ToolResultMap` gains `held`, `collectToolResults` reads
   `block.held === true`, `blocksToParts` stashes; ToolUse.tsx third
   `waiting` state — `Waiting` badge in `text-warning`, held wins over
   error, retire the "no third Waiting state" comment (the stale line that
   generated this card). Tests: tool-held unit; history-adapter reload test
   (held block → stashed; completed → not); tool-use Waiting render;
   transport stash. **Bug Fix Policy test**: held step renders Waiting from
   persisted state across a reload; completed step does not — with vacuity
   proven (fails pre-fix).
7. **Docs/decisions**: historical rows LEFT (no migration) — pre-260 red rows
   and post-260 completed-looking rows are unidentifiable without
   string-matching persisted copy (the failure decision-copy.ts prevents);
   the flag is write-once (resolved holds keep it — transcript is a record).
   Stated in ToolUse.tsx comment + PR body. Memory rows committed on branch.
8. **Gate + ship**: `pnpm build`, `pnpm -r --no-bail run test &&
   pnpm test:eslint-rules && pnpm test:scripts`, lint; two substitute peer
   review passes (ax-code-reviewer absent in this runtime — say so in PR);
   open PR `[TASK-270] …`, base main, boundary-review answers + security
   note in body; drive CI green (audit failures pre-existing); hand off
   WITHOUT merging.

## Non-goals
- Migrating or clearing historical rows (decided: left, documented).
- Changing aisdk held content (model context — out of scope by design).
- ChainOfThought header changes (held steps are not errors; nothing to fix).
- Decision-store join at render time (second source of truth — rejected).
