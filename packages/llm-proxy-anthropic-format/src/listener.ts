import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  MAX_FRAME,
  makeChatContext,
  PluginError,
  type ChatContext,
  type HookBus,
  type Logger,
} from '@ax/core';
import type { LlmCallRequest, LlmCallResponse } from '@ax/ipc-protocol';
import {
  AnthropicRequestSchema,
  type AnthropicRequest,
  type AnthropicResponse,
} from './anthropic-schemas.js';
import { synthesizeSseFrames } from './sse-frames.js';
import { translateAnthropicRequest, TranslationError } from './translate-request.js';
import { translateLlmResponse } from './translate-response.js';

// I5: tokens and raw request bodies never appear in response envelopes; all
// 4xx/5xx bodies go through writeError with a fixed message.

const BEARER_PREFIX = 'bearer ';
const SHUTDOWN_GRACE_MS = 5_000;
// A /v1/messages request waits on an upstream `llm:call` that can legitimately
// run for minutes. The socket idle timeout must match that upper bound so it
// does not tear down an in-flight request; 10 minutes mirrors the host-side
// IPC `llm.call` ceiling in @ax/ipc-protocol.
const IDLE_TIMEOUT_MS = 10 * 60_000;

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

    // The `claude` CLI binary appends `?beta=true` (and possibly other query
    // flags) to every /v1/messages request. Compare the path only, ignoring
    // the query string — the proxy doesn't use those flags anyway; they're
    // Anthropic-API hints that no longer apply once we've translated into
    // LlmCallRequest.
    const pathOnly =
      req.url === undefined ? '' : req.url.split('?', 1)[0] ?? '';
    if (pathOnly !== '/v1/messages') {
      writeError(res, 404, 'not_found_error', 'unknown path');
      return;
    }

    if (req.method !== 'POST') {
      writeError(res, 405, 'invalid_request_error', 'method not allowed');
      return;
    }

    // Auth gate. Accept either `Authorization: Bearer <token>` (the shape
    // most clients default to when given an API key) OR `X-Api-Key: <token>`
    // (the shape `@anthropic-ai/sdk` — and therefore the `claude` CLI that
    // the agent-claude-sdk runner spawns — uses when it sees
    // ANTHROPIC_API_KEY in the environment). Both resolve to the same
    // session-token lookup; rejecting one form silently blocks the whole
    // claude-sdk runner topology.
    const token = extractBearerOrApiKey(req.headers);
    if (token === undefined) {
      writeError(res, 401, 'authentication_error', 'missing bearer token');
      return;
    }
    if (token === null) {
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
    } catch {
      // V8's SyntaxError.message echoes a substring of the body at the
      // failure position — keep the response generic (matches the schema-
      // validation branch below).
      writeError(res, 400, 'invalid_request_error', 'invalid JSON body');
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
      // Only forward messages from PluginError with a domain-specific code —
      // those are under our control. HookBus wraps bare thrown Errors into a
      // PluginError with code 'unknown' whose message inlines the upstream
      // text (may contain prompt fragments or internal details), so mask
      // that case behind a generic message.
      const message =
        err instanceof PluginError && err.code !== 'unknown'
          ? err.message
          : 'upstream llm call failed';
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

/**
 * Resolve the request auth token from either `Authorization: Bearer <token>`
 * or `X-Api-Key: <token>`.
 *
 *   - Returns the token string on success.
 *   - Returns `undefined` if neither header is present (→ 401 "missing").
 *   - Returns `null` if a header is present but malformed (→ 401 "invalid
 *     scheme"); this distinguishes "you forgot auth" from "you tried but
 *     sent the wrong shape" so the failing client gets a pointer at the
 *     actual problem.
 */
function extractBearerOrApiKey(
  headers: http.IncomingHttpHeaders,
): string | null | undefined {
  // `X-Api-Key` is the @anthropic-ai/sdk default (driven by
  // `ANTHROPIC_API_KEY`). Node lowercases header names for us. A whitespace-
  // only value is treated as missing so an ill-formed x-api-key doesn't
  // shadow a valid `Authorization: Bearer` fallback.
  const apiKeyRaw = headers['x-api-key'];
  const apiKey = Array.isArray(apiKeyRaw) ? apiKeyRaw[0] : apiKeyRaw;
  if (typeof apiKey === 'string') {
    const trimmed = apiKey.trim();
    if (trimmed.length > 0) return trimmed;
  }

  // `Authorization: Bearer <token>` is the canonical HTTP form and what the
  // v1 proxy docs advertise.
  const authHeader = headers.authorization;
  if (typeof authHeader !== 'string' || authHeader.length === 0) {
    return undefined;
  }
  if (
    authHeader.length <= BEARER_PREFIX.length ||
    authHeader.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX
  ) {
    return null;
  }
  const tok = authHeader.slice(BEARER_PREFIX.length).trim();
  if (tok.length === 0) return null;
  return tok;
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
