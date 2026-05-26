# Investigation prompt — slow `conversations:get` reply surfacing

**Date:** 2026-05-22
**Status:** Investigation brief (debug task, not a feature). Spun out of the PR #124 keepalive walk.
**Hand to:** a fresh session in this repo (it has the project memory + skills referenced below).

---

Investigate why assistant replies take ~1–2.5 minutes to surface via `GET
/api/chat/conversations/:id` on the kind `ax-next-dev` cluster, even for a
trivial one-word prompt. Root-cause it before proposing any fix.

## Use systematic-debugging
This is a debugging task, not a feature. Form hypotheses, instrument, prove the
cause with a timeline, THEN propose a fix. Per CLAUDE.md's bug-fix policy, any
fix needs a regression test that fails before it.

## What was already observed (during the PR #124 keepalive walk, 2026-05-22)
There are TWO clocks in a turn that are far apart on this cluster:
  (1) `chat:turn-end` fires — resolves the orchestrator deferred + arms the idle
      reaper. This is FAST: on turn 1, user-message hit the session inbox at
      14:04:34 (cursor 0) and the idle reaper's graceful `cancel` landed at
      14:09:36 (cursor 1). The reaper arms on chat:turn-end and the window is
      exactly 300s, so turn-end fired ~14:04:36 — ~2s after the message.
  (2) the assistant text becomes READABLE via conversations:get — this is SLOW:
      polls at ~14:06:30–14:07:05 still showed turns=1 (user only); the assistant
      turn ("hello from turn one") only appeared by ~14:13.
  Second conversation: turn A reply "noted" surfaced in ~75s; turn B "42" in
  ~115s. So the lag is real and variable (~75s to ~2.5min+).

## Already ruled out / known
- The raw Anthropic API key is fast: a direct `curl` to api.anthropic.com from
  the host returned in <1s. So the model *API* is not the bottleneck.
- Keepalive (PR #124) is architecturally orthogonal: agent:invoke is dispatched
  fire-and-forget, the reply renders via SSE, and the durable copy is written by
  the `chat:turn-end → conversations` subscriber. Keepalive only changes pod
  teardown timing + the (caller-ignored) deferred resolution. VERIFY this
  independently — confirm the lag also reproduces with the orchestrator in
  one-shot mode / on `main`, so we know it predates and is independent of keepalive.

## The core question to answer first
Split these two, because the fix is completely different for each:
  (a) the model/SDK genuinely takes minutes to GENERATE the reply (slow somewhere
      in runner → credential-proxy → Anthropic), vs.
  (b) the reply is generated quickly but takes minutes to become READABLE via
      conversations:get (persistence / read-path lag).
Decide (a) vs (b) by watching the SSE chat stream during a turn (find the reply
SSE endpoint in channel-web — sse.ts / routes-chat.ts; note /api/chat/title-events
is the TITLE stream, not the reply stream). If tokens stream out within seconds
but conversations:get lags → it's (b). If SSE itself dribbles for minutes → it's (a).

## Leading hypothesis to test early (architecture-driven)
Per the runner-owned-sessions design (see memory: project_runner_owned_sessions_*),
transcripts live in the runner's workspace as jsonl, and conversations:get reads
turns that depend on the runner committing + git-bundling /permanent at the turn
boundary and the host materializing/syncing that bundle back. If so, the lag is
the workspace bundle/sync round-trip at turn-end, NOT the model. Check this:
  - Where does conversations:get actually source `turns` from — a Postgres table,
    or the workspace jsonl/bundle? (Trace the conversations:get handler.)
  - Time the bundle/commit-notify/materialize hop in the host + runner_stderr logs
    for the turn's reqId.

## How to drive it (headless, no browser)
Use the recipe in memory: reference_headless_authed_chat_kind (mint the
`ax_auth_session` cookie from a live auth_better_v1_sessions token signed with
http-server signCookieValue + AX_HTTP_COOKIE_KEY; POST /api/chat/messages;
X-Requested-With: ax-admin). Port-forward svc/ax-next-host 9090:9090.
Cluster is `kind-ax-next-dev`; host is `deploy/ax-next-host` in ns `ax-next`;
runner pods in ns `ax-next-runners`; Postgres in pod `ax-next-postgresql-0`
(password in secret ax-next-postgresql). The runner forwards its stderr to the
host as `runner_stderr` log events — the runner pod's own `kubectl logs` are empty.

## Build a single end-to-end timeline for ONE turn, with timestamps at each hop
  - user message enqueued (inbox cursor 0 created_at)
  - runner consumes it (inbox cursor advance / runner long-poll)
  - model call start/end (runner SDK; runner_stderr)
  - first + last SSE stream chunk to the client
  - chat:turn-end fires (host log; cross-check against reaper arm = cancel time − 300s)
  - assistant turn written to its store of record (DB row created_at, or jsonl/bundle synced)
  - assistant turn first readable via conversations:get (poll timestamp)
The gap between two adjacent hops is the culprit.

## Deliverable
A short root-cause writeup: the annotated timeline, which hop owns the latency,
and whether it's (a) or (b). THEN — and only then — a proposed fix with a
regression test that fails before it. If the cause is the bundle/sync round-trip,
consider whether conversations:get should read a faster source for the just-
completed turn. Do NOT change keepalive code. If you find this is actually one of
the TODO.md chat bugs (title stays "New Chat" / no history / resume spawns new
session), say so explicitly — but note the keepalive walk showed session routing
+ context continuity working when conversationId is passed correctly.
