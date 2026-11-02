import type * as http from 'node:http';
import { MAX_FRAME, type AgentContext, type HookBus } from '@ax/core';
import {
  internalError,
  logInternalError,
  notFound,
} from './errors.js';
import {
  BadJsonError,
  readJsonBody,
  readRawBody,
  TooLargeError,
} from './body.js';
import { writeBinaryOk, writeJsonError, writeJsonOk } from './response.js';
import type {
  ActionHandler,
  HandlerResult,
  HandlerBinary,
  HandlerErr,
  HandlerOk,
} from './handlers/types.js';
import {
  blobGetHandler,
  blobPutHandler,
  type BinaryActionHandler,
} from './handlers/blob.js';
import { artifactPublishHandler } from './handlers/artifact-publish.js';
import { attachmentsListHandler } from './handlers/attachments-list.js';
import { skillProposeHandler } from './handlers/skill-propose.js';
import { proxyDrainEgressBlocksHandler } from './handlers/proxy-drain-egress-blocks.js';
import { toolPreCallHandler } from './handlers/tool-pre-call.js';
import { toolExecuteHostHandler } from './handlers/tool-execute-host.js';
import { toolListHandler } from './handlers/tool-list.js';
import { sessionNextMessageHandler } from './handlers/session-next-message.js';
import { sessionGetConfigHandler } from './handlers/session-get-config.js';
import { conversationStoreRunnerSessionHandler } from './handlers/conversation-store-runner-session.js';
import {
  sessionAppendTranscriptHandler,
  sessionGetTranscriptHandler,
  sessionReplaceTranscriptHandler,
} from './handlers/session-transcript.js';
import { sessionGetDisplayHistoryHandler } from './handlers/session-display-history.js';
import {
  validateEventToolPostCall,
  fireEventToolPostCall,
} from './handlers/event-tool-post-call.js';
import {
  validateEventTurnEnd,
  fireEventTurnEnd,
  persistEventTurnEnd,
} from './handlers/event-turn-end.js';
import {
  validateEventChatEnd,
  fireEventChatEnd,
} from './handlers/event-chat-end.js';
import {
  validateEventStreamChunk,
  fireEventStreamChunk,
} from './handlers/event-stream-chunk.js';
import {
  validateEventConnectorAuthFailure,
  fireEventConnectorAuthFailure,
} from './handlers/event-connector-auth-failure.js';

// ---------------------------------------------------------------------------
// Dispatcher
//
// Routes authenticated+authorized inbound requests to per-action handlers.
// The listener already ran all five inbound gates (method, content-type,
// auth, cross-session, body-size fail-fast) before we're invoked. The
// dispatcher's job is strictly: pick a handler by (method, path), read the
// body, run the handler, write the response.
//
// Two handler shapes:
//   - ACTIONS (POST/GET with synchronous response): readJsonBody → handler
//     → write response. Handler returns {status, body}.
//   - EVENTS (POST, fire-and-forget 202): readJsonBody → validator →
//     write 202 → fire subscriber asynchronously. Subscriber failures are
//     logged but NEVER reach the client (D4: events are fire-and-forget).
//
// Unknown path → 404 NOT_FOUND, without reading the body. That includes the
// git workspace tier's actions and the save-refused drain, removed in
// TASK-995: a runner from the previous release that still calls one gets
// this clean 404. Body-read errors are answered by the body readers below,
// never thrown out of `dispatch`: over the cap → 413, bad JSON → 400, and a
// stream error (the client hung up mid-body) → a structured
// `ipc_body_read_failed` log line on ctx.logger plus a 500 (TASK-1018). The
// fail-fast Content-Length check runs first; mid-stream overflow is still
// possible if the client streams a body with a lying Content-Length.
// ---------------------------------------------------------------------------

const ACTIONS = new Map<string, {
  method: 'POST';
  handler: ActionHandler;
}>();
ACTIONS.set('/tool.pre-call', { method: 'POST', handler: toolPreCallHandler });
ACTIONS.set('/tool.execute-host', { method: 'POST', handler: toolExecuteHostHandler });
ACTIONS.set('/tool.list', { method: 'POST', handler: toolListHandler });
ACTIONS.set('/session.get-config', { method: 'POST', handler: sessionGetConfigHandler });
ACTIONS.set('/conversation.store-runner-session', {
  method: 'POST',
  handler: conversationStoreRunnerSessionHandler,
});
// TASK-68 (out-of-git Part C): JSON actions. blob.get takes a JSON request and
// returns a BINARY response (HandlerBinary), so it's an ordinary ACTION (the
// REQUEST body is JSON); only blob.put needs the raw-body path below.
ACTIONS.set('/blob.get', { method: 'POST', handler: blobGetHandler });
ACTIONS.set('/artifact.publish', { method: 'POST', handler: artifactPublishHandler });
ACTIONS.set('/attachments.list', { method: 'POST', handler: attachmentsListHandler });
// TASK-74 (out-of-git Part D): the skill authoring chokepoint. Small JSON
// request (the validated bundle), small JSON response (the gate verdict).
ACTIONS.set('/skill.propose', { method: 'POST', handler: skillProposeHandler });
// Agent-visible egress-block note: the runner drains its session's allowlist-
// blocked hosts at PostToolUse. Empty JSON request, `{ hosts: string[] }` back.
ACTIONS.set('/proxy.drain-egress-blocks', { method: 'POST', handler: proxyDrainEgressBlocksHandler });
// TASK-67 (out-of-git Part B / B2): resume-transcript actions. get-transcript
// takes a JSON request and returns a BINARY response (HandlerBinary) — still an
// ordinary ACTION (the REQUEST body is JSON). append-transcript and
// replace-transcript both stream their delta/whole jsonl as a raw octet-stream
// REQUEST body → they're BINARY_ACTIONS below (a single turn that Reads a large
// attachment can push even the per-turn delta past the 4 MiB JSON cap).
ACTIONS.set('/session.get-transcript', { method: 'POST', handler: sessionGetTranscriptHandler });
// Cross-runner history reconstruction — reached only when a runner was handed a
// transcript another runner wrote. JSON both ways (bounded, text-only), so it is
// an ordinary ACTION rather than one of the binary transcript channels above.
ACTIONS.set('/session.get-display-history', {
  method: 'POST',
  handler: sessionGetDisplayHistoryHandler,
});

// Maximum inbound body for the raw-body REQUEST-direction channel (every
// BINARY_ACTIONS entry). Matches the artifact_publish executor's 100 MiB size
// cap so the host never admits a body larger than the runner would ever
// legitimately send. This is the inbound mirror of the runner's outbound size
// checks — defense in depth at the host boundary, far above the 4 MiB JSON
// MAX_FRAME (the whole point of the binary channel). Over it → 413.
export const MAX_BLOB_BODY_BYTES = 100 * 1024 * 1024;

// BINARY_ACTIONS — POST actions whose REQUEST body is a raw octet-stream (NOT
// JSON), read via `readRawBody` under MAX_BLOB_BODY_BYTES instead of the 4 MiB
// JSON cap. `blob.put` streams artifact bytes inbound; the two transcript-ship
// actions stream jsonl bytes inbound (their `fromSeq`/`prefixHash` integrity
// metadata travels as query params — see `sessionAppendTranscriptHandler`).
const BINARY_ACTIONS = new Map<string, {
  method: 'POST';
  handler: BinaryActionHandler;
}>();
BINARY_ACTIONS.set('/blob.put', { method: 'POST', handler: blobPutHandler });
// TASK-67: append ships the per-turn delta; replace ships the WHOLE jsonl on the
// resync path. Both ride the raw octet-stream channel so a turn that Reads a
// large attachment (its jsonl line carries base64 image/document blocks) can't
// overflow the 4 MiB JSON cap and terminate the runner.
BINARY_ACTIONS.set('/session.append-transcript', { method: 'POST', handler: sessionAppendTranscriptHandler });
BINARY_ACTIONS.set('/session.replace-transcript', { method: 'POST', handler: sessionReplaceTranscriptHandler });

type EventSpec = {
  method: 'POST';
  validate: (payload: unknown) =>
    | { ok: true; payload: unknown }
    | HandlerErr;
  fire: (ctx: AgentContext, bus: HookBus, payload: unknown) => Promise<void>;
  /**
   * TASK-66 (out-of-git Part B / B3 — persist-before-ack). When present, the
   * dispatcher AWAITS this BEFORE writing the 202 ack, then runs `fire`
   * fire-and-forget AFTER. Used for `event.turn-end`: `persist` is the
   * ISOLATED display-log append (the turn's frames are durable before the
   * runner sees the turn acked), while `fire` (the broadcast: bump /
   * clear-reqId / titles / evictor) stays OFF the ack path so a slow observer
   * can't delay the runner's ack or its downstream done-frame. A `persist`
   * THROW propagates → the dispatcher returns a non-2xx (no false ack of an
   * unpersisted turn — B3 no-omission) + logs loudly. Absent for every other
   * event (those keep the prompt-202 fire-and-forget shape; stream chunks /
   * tool-post-call are high-frequency and NOT gated by no-omission).
   */
  persist?: (ctx: AgentContext, bus: HookBus, payload: unknown) => Promise<void>;
};

const EVENTS = new Map<string, EventSpec>();
EVENTS.set('/event.tool-post-call', {
  method: 'POST',
  validate: validateEventToolPostCall,
  fire: fireEventToolPostCall,
});
EVENTS.set('/event.turn-end', {
  method: 'POST',
  validate: validateEventTurnEnd,
  fire: fireEventTurnEnd,
  // Persist-before-ack (B3): the ISOLATED display-log append, awaited before
  // the 202. The broadcast (fire) runs fire-and-forget after, so it never
  // blocks the ack.
  persist: persistEventTurnEnd,
});
EVENTS.set('/event.chat-end', {
  method: 'POST',
  validate: validateEventChatEnd,
  fire: fireEventChatEnd,
});
EVENTS.set('/event.stream-chunk', {
  method: 'POST',
  validate: validateEventStreamChunk,
  fire: fireEventStreamChunk,
});
// TASK-842: the runner saw a connector's MCP server refuse it. A hint only —
// the subscriber re-checks host-side; see the handler.
EVENTS.set('/event.connector-auth-failure', {
  method: 'POST',
  validate: validateEventConnectorAuthFailure,
  fire: fireEventConnectorAuthFailure,
});

// The complete set of request paths the dispatcher routes: the GET-only
// session.next-message, every POST action, and every fire-and-forget event.
// Exported so the dependency-sync test can assert the routing table is
// non-empty and matches the handler set whose service calls feed
// DISPATCHER_DEPENDENCIES — without re-hardcoding the path list in the test.
export const DISPATCHER_PATHS: {
  readonly get: readonly string[];
  readonly actions: readonly string[];
  readonly binaryActions: readonly string[];
  readonly events: readonly string[];
} = {
  get: ['/session.next-message'],
  actions: [...ACTIONS.keys()],
  binaryActions: [...BINARY_ACTIONS.keys()],
  events: [...EVENTS.keys()],
};

function isRoutedPath(pathname: string): boolean {
  return (
    DISPATCHER_PATHS.get.includes(pathname) ||
    ACTIONS.has(pathname) ||
    BINARY_ACTIONS.has(pathname) ||
    EVENTS.has(pathname)
  );
}

/**
 * Pre-dispatch Content-Type gate (TASK-68). The two transports (ipc-server unix,
 * ipc-http TCP) share this so the rule lives in ONE place alongside the routing
 * table. A POST to a routed path must carry `application/json` — EXCEPT a
 * binary action (`/blob.put`, the transcript ships), whose REQUEST body is a raw
 * `application/octet-stream` stream (the REQUEST-direction binary channel). GET
 * carries no body. Returns `{ ok: true }` to proceed or `{ ok: false }` with the
 * 415 message.
 *
 * A path the dispatcher does not route has no body type to enforce, so it is
 * let through: auth still runs first, and the dispatcher answers it with its
 * 404 without reading the body (TASK-995). Without this, a runner from the
 * previous release that streams its old end-of-turn save as octet-stream would
 * be told its content type is wrong (415) instead of that the action is gone.
 */
export function checkContentType(
  method: string | undefined,
  pathname: string,
  contentType: string,
): { ok: true } | { ok: false; message: string } {
  if (method !== 'POST') return { ok: true };
  if (!isRoutedPath(pathname)) return { ok: true };
  const ct = contentType.toLowerCase();
  if (BINARY_ACTIONS.has(pathname)) {
    if (ct.startsWith('application/octet-stream')) return { ok: true };
    return { ok: false, message: 'content-type must be application/octet-stream' };
  }
  if (ct.startsWith('application/json')) return { ok: true };
  return { ok: false, message: 'content-type must be application/json' };
}

function isBinary(r: HandlerResult): r is HandlerBinary {
  // The binary variant is the only result carrying a `binary` Buffer (no
  // `body`). Checked first so it's never misread as a JSON ok/err.
  return Buffer.isBuffer((r as HandlerBinary).binary);
}

function isErr(r: HandlerResult): r is HandlerErr {
  // An OK body is whatever the handler returned; the error body has the
  // { error: { code, message } } envelope. We treat any result with that
  // envelope as an error so the dispatcher writes via writeJsonError and
  // the logger stays at the right level.
  const body = (r as HandlerOk).body as { error?: unknown } | undefined;
  return (
    body !== undefined &&
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'object'
  );
}

/**
 * A body read that failed for a reason other than size or JSON — the stream
 * itself errored, almost always the client hanging up mid-body. This used to
 * rethrow out of `dispatch` to the listener's per-connection catch, which has
 * no ctx and so wrote one unstructured stderr line with no reqId (TASK-1018).
 * The dispatcher holds the per-request ctx, so it logs here: one structured
 * line carrying the reqId, then the same 500 the listener used to write.
 */
function writeBodyReadFailure(
  res: http.ServerResponse,
  ctx: AgentContext,
  action: string,
  err: unknown,
): void {
  ctx.logger.error('ipc_body_read_failed', {
    action,
    err: err instanceof Error ? err : new Error(String(err)),
  });
  if (res.headersSent) return;
  try {
    const fallback = internalError();
    writeJsonError(res, fallback.status, fallback.body.error.code, fallback.body.error.message);
  } catch {
    // Best-effort — the socket is usually already gone.
  }
}

async function readBodyOrWriteError(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentContext,
  action: string,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const { value } = await readJsonBody(req, MAX_FRAME);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof TooLargeError) {
      if (!res.headersSent) {
        try {
          res.setHeader('Connection', 'close');
        } catch {
          // Response already closed.
        }
      }
      writeJsonError(res, 413, 'VALIDATION', 'body too large');
      return { ok: false };
    }
    if (err instanceof BadJsonError) {
      writeJsonError(res, 400, 'VALIDATION', `invalid json: ${err.message}`);
      return { ok: false };
    }
    writeBodyReadFailure(res, ctx, action, err);
    return { ok: false };
  }
}

async function readRawBodyOrWriteError(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes: number,
  ctx: AgentContext,
  action: string,
): Promise<{ ok: true; value: Buffer } | { ok: false }> {
  try {
    const value = await readRawBody(req, maxBytes);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof TooLargeError) {
      if (!res.headersSent) {
        try {
          res.setHeader('Connection', 'close');
        } catch {
          // Response already closed.
        }
      }
      writeJsonError(res, 413, 'VALIDATION', 'body too large');
      return { ok: false };
    }
    writeBodyReadFailure(res, ctx, action, err);
    return { ok: false };
  }
}

function writeResult(res: http.ServerResponse, result: HandlerResult): void {
  if (isBinary(result)) {
    writeBinaryOk(res, result.status, result.binary, result.contentType);
    return;
  }
  if (isErr(result)) {
    writeJsonError(res, result.status, result.body.error.code, result.body.error.message);
    return;
  }
  writeJsonOk(res, result.status, result.body);
}

export async function dispatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentContext,
  bus: HookBus,
): Promise<void> {
  // Parse path off the URL. Node gives us `req.url` as a path+query string;
  // we join it onto a dummy origin so URL() can split searchParams safely.
  const rawUrl = req.url ?? '/';
  const url = new URL(rawUrl, 'http://ipc.local');
  const pathname = url.pathname;
  const method = req.method;

  // ----- GET /session.next-message (only GET in the protocol) -----
  if (pathname === '/session.next-message') {
    if (method !== 'GET') {
      writeJsonError(res, 405, 'VALIDATION', 'method not allowed');
      return;
    }
    try {
      const result = await sessionNextMessageHandler(url, ctx, bus);
      writeResult(res, result);
    } catch (err) {
      logInternalError(ctx.logger, 'session.next-message', err);
      if (!res.headersSent) {
        const fallback = internalError();
        writeJsonError(res, fallback.status, fallback.body.error.code, fallback.body.error.message);
      }
    }
    return;
  }

  // ----- POST binary actions (raw octet-stream REQUEST body) -----
  // Checked BEFORE the JSON actions so blob.put reads its body via readRawBody
  // (capped at MAX_BLOB_BODY_BYTES) instead of the 4 MiB JSON reader — the whole
  // point of the REQUEST-direction binary channel (TASK-68).
  const binaryAction = BINARY_ACTIONS.get(pathname);
  if (binaryAction !== undefined) {
    if (method !== binaryAction.method) {
      writeJsonError(res, 405, 'VALIDATION', 'method not allowed');
      return;
    }
    const bodyRead = await readRawBodyOrWriteError(req, res, MAX_BLOB_BODY_BYTES, ctx, pathname);
    if (!bodyRead.ok) return;
    try {
      const result = await binaryAction.handler(bodyRead.value, ctx, bus, url);
      writeResult(res, result);
    } catch (err) {
      logInternalError(ctx.logger, pathname, err);
      if (!res.headersSent) {
        const fallback = internalError();
        writeJsonError(res, fallback.status, fallback.body.error.code, fallback.body.error.message);
      }
    }
    return;
  }

  // ----- POST actions -----
  const action = ACTIONS.get(pathname);
  if (action !== undefined) {
    if (method !== action.method) {
      writeJsonError(res, 405, 'VALIDATION', 'method not allowed');
      return;
    }
    const bodyRead = await readBodyOrWriteError(req, res, ctx, pathname);
    if (!bodyRead.ok) return;
    try {
      const result = await action.handler(bodyRead.value, ctx, bus);
      writeResult(res, result);
    } catch (err) {
      logInternalError(ctx.logger, pathname, err);
      if (!res.headersSent) {
        const fallback = internalError();
        writeJsonError(res, fallback.status, fallback.body.error.code, fallback.body.error.message);
      }
    }
    return;
  }

  // ----- POST events (202) -----
  const evt = EVENTS.get(pathname);
  if (evt !== undefined) {
    if (method !== evt.method) {
      writeJsonError(res, 405, 'VALIDATION', 'method not allowed');
      return;
    }
    const bodyRead = await readBodyOrWriteError(req, res, ctx, pathname);
    if (!bodyRead.ok) return;

    const validated = evt.validate(bodyRead.value);
    if ('ok' in validated && validated.ok === true) {
      if (evt.persist !== undefined) {
        // Persist-before-ack (TASK-66 / B3): AWAIT only the ISOLATED persist
        // before the 202 so the turn's frames are durable in the display event
        // log before the runner sees the turn acked. `event.turn-end` and
        // `event.chat-end` (TASK-731, refused-final-save notice) opt in; each
        // is once per turn / per run, so one DB write of added latency is
        // fine. The broadcast `fire` runs fire-and-forget AFTER, so a slow
        // observer (e.g. the title-LLM subscriber) never delays the ack.
        //
        // No-omission (B3): if the awaited persist THROWS (a real DB outage
        // — the store retries the seq-allocation race internally), do NOT
        // falsely ack — write a 500 + log loudly so the missing display row is
        // never silent.
        try {
          await evt.persist(ctx, bus, validated.payload);
        } catch (err) {
          ctx.logger.error('event_persist_failed', {
            hook: pathname,
            err: err instanceof Error ? err : new Error(String(err)),
          });
          writeJsonError(
            res,
            500,
            'INTERNAL',
            'event persist failed before ack',
          );
          return;
        }
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
        // Broadcast AFTER the ack — fire-and-forget, off the latency path.
        void evt.fire(ctx, bus, validated.payload).catch((err) => {
          ctx.logger.error('event_fire_failed', {
            hook: pathname,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        });
        return;
      }
      // Default: write 202 BEFORE firing the subscriber — a slow subscriber
      // must not block the client. We don't await the fire; failures logged.
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));
      void evt.fire(ctx, bus, validated.payload).catch((err) => {
        ctx.logger.error('event_fire_failed', {
          hook: pathname,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      });
      return;
    }
    // validation error — already a HandlerErr envelope
    const e = validated as HandlerErr;
    writeJsonError(res, e.status, e.body.error.code, e.body.error.message);
    return;
  }

  // ----- unknown path -----
  const nf = notFound(`unknown path: ${pathname}`);
  writeJsonError(res, nf.status, nf.body.error.code, nf.body.error.message);
}
