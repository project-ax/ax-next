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

// The complete set of request paths the dispatcher routes: the GET-only
// session.next-message, every POST action, and every fire-and-forget event.
// Exported so the dependency-sync test can assert the routing table is
// non-empty and matches the handler set whose service calls feed
// DISPATCHER_DEPENDENCIES — without re-hardcoding the path list in the test.
export const DISPATCHER_PATHS: {
  readonly get: readonly string[];
  readonly actions: readonly string[];
  readonly events: readonly string[];
} = {
  get: ['/session.next-message'],
  actions: [...ACTIONS.keys()],
  events: [...EVENTS.keys()],
};

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

  // ----- POST events (202) -----
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
      if (evt.persist !== undefined) {
        // Persist-before-ack (TASK-66 / B3): AWAIT only the ISOLATED persist
        // before the 202 so the turn's frames are durable in the display event
        // log before the runner sees the turn acked. Only `event.turn-end`
        // opts in; it's once-per-turn, so the one DB write of added latency is
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
