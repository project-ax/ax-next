# Root cause — slow `conversations:get` reply surfacing

**Date:** 2026-05-22
**Status:** RESOLVED — root cause proven (code + live cluster timeline), fix implemented with regression tests.
**Brief:** `2026-05-22-conversations-get-latency-investigation.md`

---

## Verdict

It is **(b)**: the reply is *generated* in seconds but takes minutes to become
*readable* via `conversations:get`. The latency is owned by the **runner's
per-turn workspace commit**, and the multi-minute lag is **caused by
idle-keepalive (PR #124)** — not orthogonal to it, as the brief assumed.

## The mechanism (code-grounded)

1. The Anthropic Agent SDK writes the assistant turn's jsonl line **after** it
   yields `result` to the runner. The runner's own comment says it
   (`agent-claude-sdk-runner/src/main.ts:1019-1027`): *"the per-turn commit in
   the result handler fires before those writes land, so the assistant response
   is always missing from the committed state."*
2. The **per-turn commit** (`main.ts:903`, `commitTurnAndBundle` → `git add -A`
   → `workspace.commit-notify`) therefore never contains the just-finished
   reply. The host applies a bundle at turn-end, but that bundle lacks the
   assistant turn.
3. The **only** commit that captures the reply is the **final commit**
   (`main.ts:1028`), which runs **after the `for await (queryIter)` loop
   drains**. The loop drains only when `userMessages()` returns
   (`main.ts:398-410`) — i.e. on `cancel` (host idle-reap) or `idle-timeout`.
4. **Keepalive keeps that loop open across turns** (`presets/k8s/src/index.ts:644`
   sets `keepAlive: true`, 300s idle window). So the final commit doesn't run at
   turn-end. The reply only becomes durable when (a) the **next turn's** per-turn
   `git add -A` sweeps up the now-flushed jsonl, or (b) the session is
   **idle-reaped** (~300s + grace) and the final commit runs.
5. `conversations:get` reads turns straight from the committed jsonl
   (`conversations/src/plugin.ts:725-856`). No cache of its own — it returns
   whatever git holds, which excludes the latest reply until step 4.

The reply **SSE** stream (`/api/chat/stream/:reqId`, fed by `chat:stream-chunk`)
is a fully independent live path — that's why tokens reach the browser in
seconds while `conversations:get` lags. Two clocks, two sources. The
`chat:turn-end → conversations` subscriber only bumps `last_activity_at`
(`conversations/src/plugin.ts:313-337`); it does **not** write the transcript.

**Signature:** under keepalive, `conversations:get` is **always exactly one
assistant-turn behind** until the session is reaped.

## Live cluster timeline (kind `ax-next-dev`, headless)

Two-turn conversation `cnv_JToTQIXtrbt8lgW9BfcIYA`:

| Event | Time | Δ |
|---|---|---|
| Turn 1 "ping" sent | 23:07:13 | |
| Turn 1 reply "pong" streamed (SSE done) | 23:07:18 | **+4.5s** (incl. cold pod start) |
| `conversations:get` → `turns=1 [user]` (reply ABSENT) | 23:07:17 → 23:08:06 | reply missing for ~49s |
| Turn 2 "pong" sent (warm pod reuse) | 23:08:03 | |
| Turn 2 reply "ping! 🏓" streamed (SSE done) | 23:08:05 | **+1.6s** |
| Turn 1 reply surfaces (swept up by turn-2 commit) → `turns=3 [user,assistant,user]` | 23:08:06 | **turn 1 reply readable +53s** |
| Pod `ax-sandbox-efc37c21` idle-reaped → `pod_exited` (code 0) → final commit | 23:13:07 | |
| Turn 2 reply surfaces → `turns=4 [...,assistant]` | 23:13:07 | **turn 2 reply readable +302s** (= 300s idle window + grace) |

The same warm pod served both turns (turn 2 had no `creating_pod`), confirming
keepalive reuse; the reply's durability tracked the per-turn/idle-reap commit,
not generation. This reproduces the brief's 75s/115s/2.5min variability exactly.

## Fix

Make every per-turn commit contain its own reply by **waiting for the SDK's
delayed assistant-jsonl write before committing**, instead of relying on the
session-close final commit (which keepalive defers).

- New helper `waitForTurnTranscript(root, sessionId, sinceUuid, {timeoutMs,
  intervalMs})` in `agent-claude-sdk-runner/src/turn-end-uuid.ts` — polls the
  jsonl until a **new** assistant uuid appears, bounded by a timeout.
- `main.ts`: track the SDK `session_id` (from the first `system/init`) in a
  dedicated `transcriptSessionId`, and the last committed assistant uuid in
  `lastTranscriptUuid` (seeded from the existing transcript on a resumed
  session). In the `result` handler, **before** `commitTurnAndBundle`, when the
  turn produced assistant content, await the flush. Timeout/interval are
  env-tunable (`AX_TURN_FLUSH_TIMEOUT_MS`/`_INTERVAL_MS`; defaults 5000/50 ms).
- **Strict improvement / bounded fallback:** on timeout the code falls through
  to the prior behavior (next-turn / final commit still captures the line), so
  it can never be worse than today. Keepalive code is untouched. The existing
  `turnId`-on-event behavior (lines 966/992, gated on the resume-only local
  `runnerSessionId`) is deliberately left unchanged.

PR #125's title-pipeline workaround (fall back to `chat:turn-end` payload
blocks) becomes unnecessary but stays harmless.

## Regression tests (fail before the fix)

- `turn-end-uuid.test.ts` — `waitForTurnTranscript` resolves with the new
  assistant uuid once a delayed write lands; resolves the first uuid when there
  is no baseline; resolves `undefined` (bounded) when nothing lands.
- `main.test.ts` — *"per-turn commit waits for the assistant transcript to land
  before committing"*: asserts `main()` invokes the flush wait **before**
  `commitTurnAndBundle`. Verified RED with the wait disabled.

Runner suite: 208/208. tsc + lint clean.

## Cluster verification of the fix

Rebuilt the agent image (`make image`), confirmed `waitForTurnTranscript` is in
the compiled `dist/turn-end-uuid.js` + `main.js` inside the image (docker cache
did not hide it), rolled out, and re-walked a single-turn fresh conversation:

| Event | Time | Δ |
|---|---|---|
| "marco" sent | 23:29:04.9 | |
| `conversations:get` → `turns=2 [user,assistant]` last=`["polo"]` | 23:29:09.7 | **readable +4.7s** |

Before the fix the same single-turn reply was absent until idle-reap (+302s).
After the fix it's readable as soon as it's generated — no longer one-behind, no
longer gated on the idle window.
