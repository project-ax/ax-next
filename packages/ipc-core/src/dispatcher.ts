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
import { writeJsonError, writeJsonOk } from './response.js';
import type { HandlerResult, HandlerErr, HandlerOk } from './handlers/types.js';
import { llmCallHandler } from './handlers/llm-call.js';
import { toolPreCallHandler } from './handlers/tool-pre-call.js';
import { toolExecuteHostHandler } from './handlers/tool-execute-host.js';
import { toolListHandler } from './handlers/tool-list.js';
import { workspaceCommitNotifyHandler } from './handlers/workspace-commit-notify.js';
import { sessionNextMessageHandler } from './handlers/session-next-message.js';
import { sessionGetConfigHandler } from './handlers/session-get-config.js';
import { conversationFetchHistoryHandler } from './handlers/conversation-fetch-history.js';
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
  handler: typeof llmCallHandler;
}>();
ACTIONS.set('/llm.call', { method: 'POST', handler: llmCallHandler });
ACTIONS.set('/tool.pre-call', { method: 'POST', handler: toolPreCallHandler });
ACTIONS.set('/tool.execute-host', { method: 'POST', handler: toolExecuteHostHandler });
ACTIONS.set('/tool.list', { method: 'POST', handler: toolListHandler });
ACTIONS.set('/workspace.commit-notify', { method: 'POST', handler: workspaceCommitNotifyHandler });
ACTIONS.set('/session.get-config', { method: 'POST', handler: sessionGetConfigHandler });
ACTIONS.set('/conversation.fetch-history', {
  method: 'POST',
  handler: conversationFetchHistoryHandler,
});

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
