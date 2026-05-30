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
import { toolPreCallHandler } from './handlers/tool-pre-call.js';
import { toolExecuteHostHandler } from './handlers/tool-execute-host.js';
import { toolListHandler } from './handlers/tool-list.js';
import { workspaceCommitNotifyHandler } from './handlers/workspace-commit-notify.js';
import { workspaceMaterializeHandler } from './handlers/workspace-materialize.js';
import { workspaceExportBaselineBundleHandler } from './handlers/workspace-export-baseline-bundle.js';
import { workspaceReadHandler } from './handlers/workspace-read.js';
import { sessionNextMessageHandler } from './handlers/session-next-message.js';
import { sessionGetConfigHandler } from './handlers/session-get-config.js';
import { conversationStoreRunnerSessionHandler } from './handlers/conversation-store-runner-session.js';
import {
  validateEventToolPostCall,
  fireEventToolPostCall,
} from './handlers/event-tool-post-call.js';
import {
  validateEventTurnEnd,
  fireEventTurnEnd,
} from './handlers/event-turn-end.js';
import {
  validateEventChatEnd,
  fireEventChatEnd,
} from './handlers/event-chat-end.js';
import {
  validateEventStreamChunk,
  fireEventStreamChunk,
} from './handlers/event-stream-chunk.js';

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
// Unknown path → 404 VALIDATION. Body-parsing errors bubble up to this
// function's try/catch and become 4xx/5xx per the readJsonBody contract
// (the listener's gate already covered the fail-fast Content-Length case;
// mid-stream overflow still possible here if the client streams a body
// with a lying Content-Length).
// ---------------------------------------------------------------------------

const ACTIONS = new Map<string, {
  method: 'POST';
  handler: ActionHandler;
}>();
ACTIONS.set('/tool.pre-call', { method: 'POST', handler: toolPreCallHandler });
ACTIONS.set('/tool.execute-host', { method: 'POST', handler: toolExecuteHostHandler });
ACTIONS.set('/tool.list', { method: 'POST', handler: toolListHandler });
ACTIONS.set('/workspace.commit-notify', { method: 'POST', handler: workspaceCommitNotifyHandler });
ACTIONS.set('/workspace.materialize', { method: 'POST', handler: workspaceMaterializeHandler });
ACTIONS.set('/workspace.export-baseline-bundle', {
  method: 'POST',
  handler: workspaceExportBaselineBundleHandler,
});
ACTIONS.set('/workspace.read', { method: 'POST', handler: workspaceReadHandler });
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

// Maximum inbound blob body for the raw-body REQUEST-direction channel
// (blob.put). Matches the artifact_publish executor's 100 MiB size cap so the
// host never admits a body larger than the runner would ever legitimately send.
// This is the inbound mirror of the runner's outbound size check — defense in
// depth at the host boundary, far above the 4 MiB JSON MAX_FRAME (the whole
// point of the binary channel).
const MAX_BLOB_BODY_BYTES = 100 * 1024 * 1024;

// BINARY_ACTIONS — POST actions whose REQUEST body is a raw octet-stream (NOT
// JSON), read via `readRawBody` under MAX_BLOB_BODY_BYTES instead of the 4 MiB
// JSON cap. Today only `blob.put` (the runner streams artifact bytes inbound).
const BINARY_ACTIONS = new Map<string, {
  method: 'POST';
  handler: BinaryActionHandler;
}>();
BINARY_ACTIONS.set('/blob.put', { method: 'POST', handler: blobPutHandler });

type EventSpec = {
  method: 'POST';
  validate: (payload: unknown) =>
    | { ok: true; payload: unknown }
    | HandlerErr;
  fire: (ctx: AgentContext, bus: HookBus, payload: unknown) => Promise<void>;
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

/**
 * Pre-dispatch Content-Type gate (TASK-68). The two transports (ipc-server unix,
 * ipc-http TCP) share this so the rule lives in ONE place alongside the routing
 * table. A POST must carry `application/json` — EXCEPT a binary action
 * (`/blob.put`), whose REQUEST body is a raw `application/octet-stream` stream
 * (the REQUEST-direction binary channel). GET carries no body. Returns
 * `{ ok: true }` to proceed or `{ ok: false }` with the 415 message.
 */
export function checkContentType(
  method: string | undefined,
  pathname: string,
  contentType: string,
): { ok: true } | { ok: false; message: string } {
  if (method !== 'POST') return { ok: true };
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

async function readBodyOrWriteError(
  req: http.IncomingMessage,
  res: http.ServerResponse,
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
    throw err;
  }
}

async function readRawBodyOrWriteError(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes: number,
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
    throw err;
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
    const bodyRead = await readRawBodyOrWriteError(req, res, MAX_BLOB_BODY_BYTES);
    if (!bodyRead.ok) return;
    try {
      const result = await binaryAction.handler(bodyRead.value, ctx, bus);
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
    const bodyRead = await readBodyOrWriteError(req, res);
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

  // ----- POST events (fire-and-forget 202) -----
  const evt = EVENTS.get(pathname);
  if (evt !== undefined) {
    if (method !== evt.method) {
      writeJsonError(res, 405, 'VALIDATION', 'method not allowed');
      return;
    }
    const bodyRead = await readBodyOrWriteError(req, res);
    if (!bodyRead.ok) return;

    const validated = evt.validate(bodyRead.value);
    if ('ok' in validated && validated.ok === true) {
      // Write 202 BEFORE firing the subscriber — a slow subscriber must not
      // block the client. We don't await the fire; failures are logged.
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
