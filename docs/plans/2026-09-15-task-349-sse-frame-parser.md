# TASK-349 — one parser for the SSE wire

**Epic:** workspace-as-sole-interface (`docs/plans/2026-09-12-workspace-as-sole-interface.md`, Tier 2 option (a)).
**Shape:** behaviour-preserving extraction on the chat side; a real capability gain on the workspace side.

---

## The problem, stated from the code

Two readers parse the same `text/event-stream`:

| | `lib/transport.ts` (`consumeSseAttempt`) | `lib/workspace-api.ts` (`streamReply`) |
|---|---|---|
| framing | `TextDecoderStream` + `carry` + `data: ` | same, re-written |
| malformed JSON | skip | skip |
| `:` keepalive comment | skip | falls out of the `data: ` test |
| seq dedup / gap (TASK-23) | **yes** | **no** |
| frames handled | all nine | `text`, `done`, `error`, `decisionRaised` |
| emits | AI-SDK `UIMessageChunk`s | `onText` / `onDone` / `onError` callbacks |

The parser is module-private and inseparable from chunk emission, which is
exactly why the second one was written — `streamReply`'s own docblock says so.

The cost is not only duplication. The workspace reader has **no seq handling at
all**, so a replayed buffer double-renders text and a bounded-buffer gap renders
a truncated answer as if it were complete. That is the silent-loss failure
TASK-23 exists to prevent, and it is live on the surface that is about to become
the only one.

## What ships

**`packages/channel-web/src/lib/sse-frames.ts`** — bytes in, typed frames out.
Nothing else. No `UIMessageChunk`, no React, no store, no label table.

```ts
export type FrameVerdict = 'continue' | 'stop';

export type SseReadEnd =
  | { reason: 'stopped' }                                   // caller saw a terminal frame
  | { reason: 'closed' }                                    // body ended, no terminator
  | { reason: 'gap'; kind: 'truncated-head' | 'mid-stream' } // seq discontinuity; body cancelled
  | { reason: 'body-error'; error: unknown };               // read threw

export async function readSseFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => FrameVerdict,
): Promise<SseReadEnd>;
```

`SseFrame` is **imported** from `src/server/types.ts`, not restated. That file is
types-only (no runtime export), so the import erases at build time.

### Why a callback and not an async generator

`for await…of` discards a generator's return value, and the terminal reason *is*
the product here — `gap` and `closed` are different outcomes that both mean
"lost" to one caller and need different logging to the other. A generator would
force both call sites into a manual `.next()` loop to read it. The callback shape
also maps 1:1 onto what both readers already do (a `switch` that sometimes
`return`s), which is what keeps the chat side behaviour-preserving.

### State lives inside, because it is per-body

`carry` and `lastSeq` are **per-body**, owned by `readSseFrames`. Confirmed
against the call sites, not assumed: `createParseCtx()` is called once each in
`processResponseStream` and `buildTurnStream`, and each feeds exactly one body to
`consumeSseAttempt`. `openSseStream` retries the **open**; a body that has been
read from is never retried. The "across attempts" language in `ParseCtx`'s
comments describes the *unbuilt* auto-reconnect consumer (TASK-27 / TASK-30), not
today's flow. When that lands it can lift the cursor out; inventing a
caller-owned cursor now would be a parameter no caller varies.

### Frame ordering is preserved exactly

`consumeSseAttempt` dispatches `done` → `error` → `phase` → `permissionRequest` →
`decisionRaised` **before** the seq check, and the seq check is guarded by
`'kind' in frame`. Only content frames carry a top-level `kind`
(a `permissionRequest`'s `kind` is nested one level down), so applying seq
filtering inside the parser before yielding is indistinguishable from the
current order. A duplicate is dropped and never yielded — the same as today's
`continue`.

## Tasks

1. **`sse-frames.ts` + `lib/__tests__/sse-frames.test.ts`.** Test-first. Drives
   the module at frame level with a hand-built `ReadableStream`.
2. **Rewire `transport.ts`.** `consumeSseAttempt` keeps its signature and its
   `AttemptEnd` contract; its body becomes a `readSseFrames` call whose `onFrame`
   is the existing dispatch, minus the framing and the seq block.
   `ensureOpenForKind`, the counters, `stripMcpToolPrefix`,
   `rememberToolPhrase` / `rememberToolHeld`, `ERROR_LABELS` / `PHASE_LABELS`,
   `agentStatusActions`, and the open/reconnect loop all stay.
3. **Rewire `workspace-api.ts` `streamReply`.** Same shape. It gains seq dedup
   and gap → `WORKSPACE_STREAM_LOST`, which is a behaviour *change* on that
   surface and is the point of the card.
4. **Pin the boundary in lint.** A `no-restricted-imports` block scoped to
   `sse-frames.ts` forbidding `@assistant-ui/*` and `ai`. A source-text test
   would also work; a lint rule is checked on every file that ever moves here.
5. **Prove the fork is gone.** Grep for `data: ` and wire-line `JSON.parse` in
   both files; paste the empty result in the PR body.

## YAGNI pass

| Task | Load-bearing at MVP? |
|---|---|
| 1 | Yes — the module is the card. |
| 2 | Yes — otherwise the new module is half-wired infrastructure. |
| 3 | Yes — same, and it is the reason the card exists. |
| 4 | Yes, cheap — the whole point of the module is that it cannot grow a renderer dependency. One rule beats a convention nobody enforces. |
| 5 | Yes — it is the card's own acceptance criterion. |

Cut: a caller-owned seq cursor (no caller varies it — see above), a
`FrameDecoder` class separate from the stream driver (one consumer shape, no
second driver to write), and moving `ERROR_LABELS` (see below).

## Deliberately NOT in this PR

**`ERROR_LABELS` / `DEFAULT_TURN_ERROR` / `MAX_DETAIL_CHARS` stay in
`transport.ts`** — the card says so explicitly, and TASK-296 put the workspace's
import there on purpose (invariant 4: read the existing table rather than grow a
second one).

But that leaves a live hazard worth naming: `workspace-api.ts` imports those
three from `transport.ts`, and **TASK-360 deletes `transport.ts` wholesale**.
This is the same failure the card guards the parser against, one module over. It
predates this PR and this PR does not worsen it, and it fails **loudly** — a
missing export is a compile error, not a silent drift — so it is a follow-up
card, not scope creep here.

## Gate

`pnpm build`, then
`pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`,
then `pnpm lint`.

Chat's existing transport tests are the regression net and are **not edited**.
Baseline for comparison, taken on this branch before any change:
`@ax/channel-web` 180 files / 1922 tests passing.
