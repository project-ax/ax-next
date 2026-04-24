import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_FRAME, makeChatContext, type ChatContext, type HookBus, type Logger } from '@ax/core';
import type { LlmCallRequest, LlmCallResponse } from '@ax/ipc-protocol';
import {
  AnthropicRequestSchema,
  type AnthropicRequest,
  type AnthropicResponse,
} from './anthropic-schemas.js';
import { synthesizeSseFrames } from './sse-frames.js';
import { translateAnthropicRequest, TranslationError } from './translate-request.js';
import { translateLlmResponse } from './translate-response.js';

// ---------------------------------------------------------------------------
// Proxy listener
//
// Speaks the Anthropic Messages API on 127.0.0.1:<ephemeral> so that
// claude-sdk's `query()` can be pointed at it via ANTHROPIC_BASE_URL. The
// proxy forwards into the host via two hooks — `session:resolve-token` for
// auth and `llm:call` for the actual model turn — then translates the
// LlmCallResponse back into Anthropic's response or SSE shape.
//
// Five gates run per request, in order:
//   1. Method + path — POST /v1/messages only (GET /_healthz is a liveness
//      hatch); everything else is 404 or 405.
//   2. Auth — Authorization: Bearer <token> resolves via session:resolve-token.
//      Missing / malformed / unknown → 401. Token is NEVER echoed in a
//      response body (I5).
//   3. Body size — fails fast on Content-Length > MAX_FRAME; otherwise a
//      mid-stream cap throws TooLargeError.
//   4. JSON + schema — JSON.parse failure → 400 (invalid_request_error);
//      AnthropicRequestSchema failure → 400 likewise.
//   5. Translation → llm:call. TranslationError → 400; llm:call throwing
//      propagates as 502 (api_error).
// ---------------------------------------------------------------------------

const BEARER_PREFIX = 'bearer ';
const SHUTDOWN_GRACE_MS = 5_000;
const IDLE_TIMEOUT_MS = 60_000;

export interface ProxyListener {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export interface CreateProxyListenerOptions {
  bus: HookBus;
  sessionId: string;
  logger?: Logger;
}

interface SessionResolveTokenInput {
  token: string;
}
type SessionResolveTokenOutput =
  | { sessionId: string; workspaceRoot?: string }
  | null;

export async function createProxyListener(
  opts: CreateProxyListenerOptions,
): Promise<ProxyListener> {
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      try {
        if (!res.headersSent) {
          writeError(res, 500, 'api_error', 'internal server error');
        } else {
          res.end();
        }
      } catch {
        // best-effort
      }
      process.stderr.write(
        `llm-proxy-anthropic-format: unhandled handler error: ${(err as Error).message}\n`,
      );
    });
  });

  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.once('close', () => sockets.delete(sock));
  });

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    // Healthz: liveness hatch, no auth required. Useful for runner startup
    // probing; the sandbox subprocess can hit it to confirm the proxy bound.
    if (req.method === 'GET' && req.url === '/_healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok\n');
      return;
    }

    if (req.url !== '/v1/messages') {
      writeError(res, 404, 'not_found_error', 'unknown path');
      return;
    }

    if (req.method !== 'POST') {
      writeError(res, 405, 'invalid_request_error', 'method not allowed');
      return;
    }

    // Auth gate.
    const authHeader = req.headers.authorization ?? '';
    if (authHeader.length === 0) {
      writeError(res, 401, 'authentication_error', 'missing bearer token');
      return;
    }
    if (
      authHeader.length <= BEARER_PREFIX.length ||
      authHeader.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX
    ) {
      writeError(res, 401, 'authentication_error', 'invalid authorization scheme');
      return;
    }
    const token = authHeader.slice(BEARER_PREFIX.length).trim();
    if (token.length === 0) {
      writeError(res, 401, 'authentication_error', 'invalid authorization scheme');
      return;
    }

    const preAuthCtx = buildCtx('pre-auth', process.cwd());
    let resolved: SessionResolveTokenOutput;
    try {
      resolved = await opts.bus.call<SessionResolveTokenInput, SessionResolveTokenOutput>(
        'session:resolve-token',
        preAuthCtx,
        { token },
      );
    } catch {
      // Resolver throws on unknown tokens in some backends; treat either
      // shape as 401 without echoing the token.
      writeError(res, 401, 'authentication_error', 'unknown token');
      return;
    }
    if (resolved === null) {
      writeError(res, 401, 'authentication_error', 'unknown token');
      return;
    }
    if (resolved.sessionId !== opts.sessionId) {
      // Proxy listener is per-session (owned by sandbox:open-session); a
      // valid token for a different session must not reach llm:call here.
      writeError(res, 403, 'authentication_error', 'token bound to a different session');
      return;
    }

    // Body read with a 4 MiB cap. Content-Length fail-fast; otherwise a
    // mid-stream overflow destroys the socket.
    let rawBody: Buffer;
    try {
      rawBody = await readBody(req, MAX_FRAME);
    } catch (err) {
      if ((err as Error).name === 'TooLargeError') {
        writeError(res, 413, 'invalid_request_error', 'body too large');
        return;
      }
      writeError(res, 400, 'invalid_request_error', 'could not read body');
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      writeError(
        res,
        400,
        'invalid_request_error',
        `invalid json: ${(err as Error).message}`,
      );
      return;
    }

    const parsedSchema = AnthropicRequestSchema.safeParse(parsedJson);
    if (!parsedSchema.success) {
      // Do not interpolate the raw error message (could contain prompt
      // fragments). Only surface the shape of the failure.
      writeError(
        res,
        400,
        'invalid_request_error',
        `request did not match Anthropic messages schema (${parsedSchema.error.issues.length} issue${parsedSchema.error.issues.length === 1 ? '' : 's'})`,
      );
      return;
    }
    const anthropicReq: AnthropicRequest = parsedSchema.data;

    let llmReq: LlmCallRequest;
    try {
      llmReq = translateAnthropicRequest(anthropicReq);
    } catch (err) {
      if (err instanceof TranslationError) {
        writeError(res, 400, 'invalid_request_error', err.message);
        return;
      }
      throw err;
    }

    const workspaceRoot = resolved.workspaceRoot ?? process.cwd();
    const callCtx = buildCtx(resolved.sessionId, workspaceRoot);

    let llmResp: LlmCallResponse;
    try {
      llmResp = await opts.bus.call<LlmCallRequest, LlmCallResponse>(
        'llm:call',
        callCtx,
        llmReq,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'upstream llm call failed';
      writeError(res, 502, 'api_error', message);
      return;
    }

    const anthropicResp: AnthropicResponse = translateLlmResponse(llmResp, anthropicReq.model);

    if (anthropicReq.stream === true) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.end(synthesizeSseFrames(anthropicResp));
      return;
    }

    const body = Buffer.from(JSON.stringify(anthropicResp), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
    });
    res.end(body);
  };

  server.setTimeout(IDLE_TIMEOUT_MS);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo | null;
  if (addr === null || typeof addr === 'string') {
    throw new Error('proxy listener: unexpected address shape after listen');
  }
  const port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(() => {
        for (const sock of sockets) {
          try {
            sock.destroy();
          } catch {
            // best-effort
          }
        }
        done();
      }, SHUTDOWN_GRACE_MS);
      timer.unref();
      server.close(() => {
        clearTimeout(timer);
        done();
      });
    });
  };

  return {
    get port() {
      return port;
    },
    get url() {
      return url;
    },
    close,
  };
}

function buildCtx(sessionId: string, rootPath: string): ChatContext {
  // The proxy is a wire adapter; it has no first-class agent/user identity.
  // Week 9.5 (@ax/agents) will ship a richer `session:get-context` hook that
  // fills these fields from the session record; until then, sane placeholders.
  return makeChatContext({
    sessionId,
    agentId: 'proxy',
    userId: 'proxy',
    workspace: { rootPath },
  });
}

class TooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooLargeError';
  }
}

async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const contentLengthHeader = req.headers['content-length'];
  if (typeof contentLengthHeader === 'string' && contentLengthHeader.length > 0) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new TooLargeError(`content-length ${declared} exceeds cap ${maxBytes}`);
    }
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        settle(() =>
          reject(new TooLargeError(`body exceeded cap ${maxBytes} bytes`)),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => {
      settle(() => reject(err));
    });
    req.on('end', () => {
      settle(() => resolve(Buffer.concat(chunks, total)));
    });
  });
}

interface AnthropicErrorEnvelope {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

function writeError(
  res: http.ServerResponse,
  status: number,
  type: string,
  message: string,
): void {
  const env: AnthropicErrorEnvelope = { type: 'error', error: { type, message } };
  const body = Buffer.from(JSON.stringify(env), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
  });
  res.end(body);
}
