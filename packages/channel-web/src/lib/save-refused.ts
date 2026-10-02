/**
 * The three ways a reply's files can fail to be saved (TASK-720), and the one
 * check both sides of the stream run on them.
 *
 * The runner reports an end-of-turn save the host refused on `event.turn-end`
 * as `saveRefused`, and by then it has already undone that turn's file changes.
 * The host's SSE handler forwards the code on the `done` frame
 * (`server/sse.ts`), and `streamReply` hands it to the view
 * (`lib/workspace-api.ts`), which shows one fixed sentence per code.
 *
 * Since TASK-731 the host also persists the code as a `save-refused` display
 * event, and the thread read (`server/routes-workspace.ts`) checks it here
 * again on the way out, so a reload still shows the notice.
 *
 * WHY BOTH SIDES CHECK. The `chat:turn-end` bus payload is typed loosely, and a
 * runner is untrusted: ipc-core validates the IPC event, but a subscriber that
 * forwards a field to a browser is the one that answers for what it forwards.
 * The browser checks again because the frame is JSON off a socket. Either way
 * only a closed code crosses — never a sentence someone else wrote — so the
 * worst a lying runner can do is pick the wrong one of three fixed lines.
 *
 * WHY THIS FILE. The host imports it (`server/sse.ts`,
 * `server/routes-workspace.ts`), so it has no relative
 * imports at all (see `__tests__/server-import-extensions.test.ts`). The type
 * comes from `@ax/ipc-protocol`, which is a type-only import and so costs the
 * browser bundle nothing; the `Record` below makes the compiler notice a fourth
 * code added there.
 */
import type { SaveRefusedCode } from '@ax/ipc-protocol';

export type { SaveRefusedCode };

const CODES: Record<SaveRefusedCode, true> = {
  'storage-full': true,
  'too-large': true,
  refused: true,
};

/** The code, when `value` is exactly one of the three; otherwise `undefined`. */
export function asSaveRefusedCode(value: unknown): SaveRefusedCode | undefined {
  if (typeof value !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(CODES, value)
    ? (value as SaveRefusedCode)
    : undefined;
}

/**
 * The thread-row id of a persisted refusal (TASK-731), from its display-event
 * `key`: the turn's reqId (or `''` when it had none), or `final:<uuid>` for a
 * refusal at the runner's last flush.
 *
 * THE ONE PLACE this id is built. The host's thread read (`buildThread` in
 * `server/routes-workspace.ts`) names the row with it, and `AgentView` looks
 * for that same id to know the durable row for the turn it just watched has
 * landed, so it stops drawing its live copy. Two spellings of one id would put
 * the notice on screen twice.
 */
export function saveRefusedRowId(key: string): string {
  return `save-refused:${key}`;
}
