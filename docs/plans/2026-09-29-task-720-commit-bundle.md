# TASK-720 — big workspace saves, and telling the person when a save is refused

Decisions and alternatives: `.claude/memory/decisions/2026-09-29-TASK-720.md`.

## Problem

1. The runner's end-of-turn save (`workspace.commit-notify`) is a JSON action carrying a
   base64 git bundle inside the 4 MiB IPC frame, so about 3 MiB of compressed objects is
   the most one save can carry. Over that the host answers 413 (or the socket resets and
   the client retries for up to two minutes), `commitNotifyWithResync` swallows it as
   `kept`, `refs/heads/baseline` never moves, and every later bundle (`baseline..main`)
   still carries the big blob. Nothing is saved for that agent again, and nobody is told.
2. When the host refuses the end-of-turn save (storage full, a validator veto), the runner
   resets the files and the person is never told. Only the mid-turn flush before a host
   tool relays the reason, and only to the model.

## Approach

- New binary IPC action `workspace.commit-bundle`: raw bundle bytes as the body,
  `parentVersion` (absent = null) and `reason` as query params, same JSON answer as
  `workspace.commit-notify`. Up to 100 MiB (the host's existing binary-body budget). The
  JSON action stays for sandboxes from the previous release; both share one handler core.
- The rejected answer carries an optional machine `code`, forwarded from the pre-apply
  veto (`storage-full`).
- Runner: send over the binary action. A bundle over the cap is not sent; it and a host
  413 both become a loud `rolled-back` (hard reset, model-facing reason,
  `rejectionCode: 'too-large'`), never `kept`.
- Runner reports an end-of-turn refusal on `event.turn-end` as
  `saveRefused: 'storage-full' | 'too-large' | 'refused'`; channel-web forwards it on the
  SSE `done` frame; the workspace view shows one fixed sentence under the reply.

## Tasks

- **T0 — repro test (red first).** In-process: real `createIpcClient` + real IPC
  listener + `dispatch` + real workspace backend, a runner repo writing a 5 MiB random
  file, `commitTurnAndBundle` + `commitNotifyWithResync`. Asserts the save is accepted and
  a second small save after it is accepted too. Red on `main` (kept, then kept again).
- **T1 — host: `workspace.commit-bundle` binary action** (ipc-protocol request/query
  shape + exported size cap; ipc-core handler core shared with the JSON action;
  dispatcher registration; forward veto `code` on the rejected answer). Tests: routing,
  content type, query parsing, empty body, >4 MiB body accepted, `code` forwarded and
  absent when the veto has none.
- **T2 — runner: send over the binary action; too-large fails loudly.** `commitTurnAndBundle`
  hands back bytes; `commitNotifyWithResync` uses `callBinaryUpload`; pre-send cap check
  and host 413 → `rolled-back` hard + `rejectionCode: 'too-large'` + reason; other errors
  unchanged. Update every fake client that answers `workspace.commit-notify`. T0 goes green.
- **T3 — runner reports `saveRefused` on turn-end.** Protocol field on
  `EventTurnEndSchema`; `run-runner.ts` end-of-turn commit maps the result to it (only a
  terminal refusal: `rejectionReason` present or `too-large`). Final/idle commit: log only.
- **T4 — channel-web shows it.** SSE turn-end subscriber forwards a validated
  `saveRefused` on the `done` frame; `streamReply` hands it to `onDone`; `AgentView`
  shows a fixed sentence per code under the reply (existing thread-notice pattern, shadcn,
  semantic tokens). Tests: server frame, client parse, render.
- **T5 — stale prose.** Comments claiming the ~3 MiB cap / "only channel" / chat:start
  front door being the only path; a memory shard row correcting the TASK-690 lines.

YAGNI: every task is load-bearing. Cut: persisting the notice, the final-commit channel,
telling the model next turn (follow-up cards).

Security: T1/T2 touch the IPC boundary (a larger untrusted body; query params are
untrusted input). Run security-checklist after T2.
