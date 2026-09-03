# TASK-271 — activityPhrase on the tool-call wire shape

## Problem
TASK-260 stripped the `mcp__<server>__` prefix at both display boundaries
(`history-adapter.ts`, `transport.ts`) — cosmetic. The host-authored
`activityPhrase` (TASK-229 contract, lives on `ToolDescriptor`) never reaches
the transcript, so the UI renders a transformed wire identifier instead of a
human-readable phrase.

## Verified facts (not card hypotheses)
- Bridge is lossy (verified in `node_modules`: `convertMessage.js` rebuilds
  tool-call parts with exactly `{type,toolName,toolCallId,argsText,args,
  result,isError,...}` — custom fields die; `tool-call` input parts are
  dropped as unsupported). So the phrase CANNOT ride as a side field on
  assistant-ui parts. Design uses a client-side toolCallId→phrase display map.
- `artifact_publish` HAS `activityPhrase: 'Publishing a file'`
  (`tool-artifact-publish/src/descriptor.ts:34`), so overloading `toolName`
  with the phrase would break its bespoke chip dispatch. `toolName` stays the
  stable stripped identifier everywhere.
- Storage round-trips through zod `safeParse` (`validateContentBlocks`
  returns `parsed.data`), so an additive schema field persists. No replay
  risk: stored blocks flow runner→host only; replay uses SDK jsonl.
- Transport parses SSE frames with `JSON.parse` + cast (no zod strip);
  `wire/chat.ts` reuses `ContentBlockSchema` — additive fields flow.
- Both runners receive the full `ToolDescriptor[]` catalog (with phrases) via
  `RunnerDeps.tools` and can attach the phrase at emission.

## Tasks
1. **Wire (`@ax/ipc-protocol`)**: optional `activityPhrase` on
   `ToolUseBlockSchema` + `EventStreamChunkSchema` tool-use variant, plus
   `sanitizeActivityPhrase()` (single-line, strip C0/ANSI, trim, cap 60,
   drop-if-empty). Unit tests incl. hostile inputs.
   Boundary review: alt impl = any runner may attach/omit; no leaky names
   (domain vocab); additive optional → no subscriber risk; schema lives in
   ipc-protocol (owns the wire).
2. **Fence (`@ax/ipc-core`)**: sanitize phrase in `validateEventStreamChunk`
   and the turn-end persist path — mangle, never drop the chunk/block.
   Tests: hostile phrase in → safe/missing phrase out, chunk intact.
3. **Attach (both runners)**: name→phrase map from catalog at loop build;
   attach on `emitChunk({kind:'tool-use'})` + `tool_use` blocks. claude-sdk
   maps via `classifySdkToolName` (mcp__ strip); aisdk uses bare names.
   Tests: phrase attached where present, absent otherwise, unknown names omit.
4. **Render (`channel-web`)**: `StreamChunk` + `SseFrame` tool-use +=
   optional phrase; `sse.ts` validation passes it through iff string;
   `transport.ts` + `history-adapter.ts` stash into a bounded
   toolCallId-keyed display map (toolName stays stable); `ToolFallback`
   renders phrase ?? toolName. Tests: phrase shown, strip fallback, artifact
   dispatch intact, map bounded.
5. **Gate + ship**: `pnpm build`, `pnpm -r --no-bail run test &&
   pnpm test:eslint-rules && pnpm test:scripts`, lint, two peer reviews,
   PR (base main, `[TASK-271] ` prefix) with boundary review + security note.
   DO NOT merge.

## Security (checklist output goes in PR)
- Sandbox: N/A — no new capability; display-only string, never interpolated
  into paths/commands/prompts.
- Injection: phrase is runner-round-tripped content → fenced server-side at
  ipc-core ingress (sanitize: 60 chars, single line, no C0/ANSI, drop-empty);
  rendered as plain text (React escaping) in ToolFallback.
- Supply chain: N/A — no package.json changes.
