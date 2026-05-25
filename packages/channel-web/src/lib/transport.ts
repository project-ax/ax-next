/**
 * AxChatTransport — speaks the AX-native chat-flow producer / SSE wire.
 *
 * Two-phase exchange replacing the OpenAI-SSE stub used during early
 * prototyping (Tasks 9-13 froze the wire shapes in src/wire/chat.ts):
 *
 *   1. POST /api/chat/messages with `{ conversationId | null, agentId,
 *      contentBlocks }`. The handler validates + ACL-gates, mints a
 *      server-side `reqId` (J9 — never client-supplied), and replies
 *      202 with `{ conversationId, reqId }`.
 *
 *   2. Open `EventSource('/api/chat/stream/' + reqId)` (we use a
 *      fetch-based SSE reader so we keep the same protected
 *      `processResponseStream` hook the AI SDK gives us). Each
 *      `data:` line is a JSON-encoded `SseFrame`:
 *
 *        - `{ reqId, text, kind: 'text' | 'thinking' }` — content delta.
 *          We stream `kind === 'text'` chunks as `text-delta` UIMessage-
 *          Chunks under id `text-N`. `kind === 'thinking'` chunks are
 *          emitted under a separate id `thinking-N` so the per-message
 *          toggle (Task 21) can hide them.
 *
 *        - `{ reqId, done: true }` — terminator. We close the open part(s)
 *          and emit a `finish` UIMessageChunk (`finishReason: 'stop'`).
 *
 * Wire-shape source of truth: `src/server/types.ts` (`SseFrame`) +
 * `src/wire/chat.ts` (`PostMessageRequest` / `PostMessageResponse`).
 *
 * Boundary review (I1-I5):
 *   - I1: field names — conversationId / agentId / reqId / contentBlocks /
 *     text / kind / done — are LLM-API vocab, not transport/storage vocab.
 *   - I2: this file imports only from `ai` (the AI SDK transport base) and
 *     `@ax/ipc-protocol` (ContentBlock type). No cross-plugin reach.
 *   - I3: full chain (POST → SSE → UIMessageChunks → render) lands in
 *     this PR.
 *   - I4: conversationId returned by POST is captured in `conversationRef`
 *     so the next user turn re-uses it (the conversation row is the source
 *     of truth — Task 10's GET /api/chat/conversations/:id reads from it).
 *   - I5: `text` in incoming SSE frames is UNTRUSTED model output; it
 *     flows through the AI SDK text-delta pipeline and is rendered by
 *     <MarkdownText /> via react-markdown's safe defaults (no rehypeRaw,
 *     no raw-HTML escape hatches enabled).
 */

import type { ContentBlock } from '@ax/ipc-protocol';
import { HttpChatTransport, type UIMessage, type UIMessageChunk } from 'ai';
import { agentStatusActions } from './agent-status-store';

const DEFAULT_USER = 'guest';

/**
 * Map a wire phase value to the user-facing label. Centralized here so
 * future i18n is one switch (and adding a phase doesn't require changing
 * the parser). Returning `null` means "unknown phase" — we ignore it
 * rather than render a half-baked default; forward-compat with newer
 * server builds that emit a phase the client doesn't yet recognize.
 */
const PHASE_LABELS: Record<string, string> = {
  'sandbox-starting': 'Starting sandbox…',
};

/**
 * Default user-facing wording for an abnormal turn end (Fault A — the
 * runner died mid-turn or wedged past the chat timeout). Exported so the
 * runtime's `onError` can fall back to the same string when the AI-SDK
 * error carries no message. Kept here (client-side) so wording/i18n is one
 * place, mirroring PHASE_LABELS.
 */
export const DEFAULT_TURN_ERROR =
  'The agent stopped unexpectedly. Retry to continue.';

/**
 * Sentinel error text for a `done`-less stream close (Faults B/D — the host
 * bounced or the network dropped mid-turn, so the SSE connection died before
 * any terminal `done`/`error` frame arrived). This is an INTERNAL
 * @ax/channel-web contract (NOT a hook payload) shared between this file and
 * the runtime's onError — exactly like DEFAULT_TURN_ERROR. The runtime
 * matches `error.message === CONNECTION_LOST` to decide a SILENT retry (first
 * failure) vs surfacing the error banner (second failure); the wording also
 * doubles as the transient "retrying…" label and, if the silent retry is
 * exhausted, the banner text.
 */
export const CONNECTION_LOST = 'Connection lost. Retrying…';

/**
 * Map a wire turn-error reason code (backend-agnostic, from the orchestrator)
 * to a user-facing label. Unknown codes fall back to DEFAULT_TURN_ERROR —
 * forward-compat with newer server builds that emit a code the client
 * doesn't yet recognize.
 */
const ERROR_LABELS: Record<string, string> = {
  'chat-run-timeout': 'The agent timed out. Retry to continue.',
};

/** Shape of one SSE `data:` JSON payload. Matches `SseFrame` in src/server/types.ts. */
type SseFrame =
  | { reqId: string; kind: 'text'; text: string }
  | { reqId: string; kind: 'thinking'; text: string }
  | {
      reqId: string;
      kind: 'tool-use';
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      reqId: string;
      kind: 'tool-result';
      toolCallId: string;
      output: string;
      isError?: boolean;
    }
  | { reqId: string; phase: string }
  | { reqId: string; done: true }
  | { reqId: string; error: string };

interface AxChatTransportOptions {
  /**
   * Endpoint to POST user messages to. Defaults to `/api/chat/messages`
   * which the host plugin registers; tests can pin to a different mount.
   */
  api?: string;
  /**
   * Endpoint prefix for the SSE subscription. Suffixed with the minted
   * reqId. Defaults to `/api/chat/stream`; the chat-flow plugin mounts
   * `/api/chat/stream/:reqId` (with the trailing slash).
   */
  streamApi?: string;
  /**
   * Logical user id — purely for the legacy `user` body field, kept here
   * so the runtime hook contract doesn't break. The new wire doesn't
   * carry it (auth lives in the cookie); we accept + ignore it.
   */
  user?: string;
  /**
   * Optional resolver for the active conversationId. The transport will
   * read this BEFORE every send and write the server-returned id back via
   * `setConversationId`. If not provided, transport-internal state is the
   * source.
   */
  getConversationId?: () => string | null;
  setConversationId?: (id: string) => void;
  /**
   * Resolver for which agent the user is messaging. The wire requires it
   * (PostMessageRequest.agentId is non-empty). The runtime hook reads the
   * agent-store and provides this.
   */
  getAgentId?: () => string | null;
  /**
   * Custom fetch — primarily for tests so they can mock the POST without
   * a global override.
   */
  fetch?: typeof fetch;
}

const AX_ATTACHMENT_URL_PREFIX = 'ax://attachment/';

function isAxAttachmentPart(p: unknown): { attachmentId: string } | null {
  if (!p || typeof p !== 'object') return null;
  const obj = p as { type?: unknown; data?: unknown; url?: unknown };
  if (obj.type !== 'file') return null;
  const candidate =
    typeof obj.data === 'string' ? obj.data :
    typeof obj.url === 'string' ? obj.url : null;
  if (candidate === null) return null;
  if (!candidate.startsWith(AX_ATTACHMENT_URL_PREFIX)) return null;
  const id = candidate.slice(AX_ATTACHMENT_URL_PREFIX.length);
  if (id.length === 0) return null;
  return { attachmentId: id };
}

/** Convert one AI-SDK UIMessage's parts list to an AX ContentBlock array.
 *  Phase 3: ax://attachment/<id> file parts become attachment_ref blocks;
 *  other file parts fall back to text mentions (legacy behavior preserved
 *  for any non-ax adapter that might surface a file part in the future).
 */
function toContentBlocks(msg: UIMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (!msg.parts) return blocks;

  // Collect text first (chat-flow concatenates all text into one block).
  let collectedText = '';
  for (const p of msg.parts) {
    if (p.type === 'text') {
      collectedText += p.text;
    }
  }
  if (collectedText.length > 0) {
    blocks.push({ type: 'text', text: collectedText });
  }

  // Then file parts, preserving order.
  for (const p of msg.parts) {
    if (p.type !== 'file') continue;
    const ax = isAxAttachmentPart(p);
    if (ax !== null) {
      blocks.push({ type: 'attachment_ref', attachmentId: ax.attachmentId });
      continue;
    }
    // Non-ax file part — text-mention fallback (preserves the legacy
    // path so a future adapter that emits e.g. https:// file parts
    // doesn't drop the user's intent silently).
    const fp = p as { url?: string; mediaType?: string; filename?: string };
    const ref = fp.url ?? '';
    const filename = fp.filename ?? '';
    blocks.push({
      type: 'text',
      text: `[attachment: ${filename || ref}]`,
    });
  }
  return blocks;
}

/** Test-only export of toContentBlocks so unit tests can drive it
 *  without booting an entire transport instance. */
export const toContentBlocksForTesting = toContentBlocks;

/**
 * Body shape we POST. The server's `PostMessageRequest` zod schema is
 * the authority — we duck-type against it here to avoid importing the
 * server module from the React bundle (Invariant I2).
 */
interface PostBody {
  conversationId: string | null;
  agentId: string;
  contentBlocks: ContentBlock[];
}

interface PostResponse {
  conversationId: string;
  reqId: string;
}

export class AxChatTransport extends HttpChatTransport<UIMessage> {
  private readonly streamApi: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getConversationIdFn: (() => string | null) | undefined;
  private readonly setConversationIdFn: ((id: string) => void) | undefined;
  private readonly getAgentIdFn: (() => string | null) | undefined;

  /**
   * Local fallback for the conversation id when the caller hasn't wired
   * a `getConversationId` resolver. Persists across `sendMessages` calls
   * so a follow-up turn re-uses the conversation the server minted on
   * the first turn.
   */
  private localConversationId: string | null = null;

  constructor(opts: AxChatTransportOptions = {}) {
    super({
      api: opts.api ?? '/api/chat/messages',
      // We override sendMessages below, so prepareSendMessagesRequest is
      // unused on the happy path. Provide a no-op body so HttpChatTransport
      // can still construct itself if a subclass call slips through.
      prepareSendMessagesRequest: async () => ({ body: {} }),
    });
    this.streamApi = opts.streamApi ?? '/api/chat/stream';
    // Bind to globalThis so the stored reference doesn't lose its Window
    // receiver. Calling `this.fetchImpl(...)` with `this === transport`
    // would otherwise throw `TypeError: Illegal invocation` in the browser.
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.getConversationIdFn = opts.getConversationId;
    this.setConversationIdFn = opts.setConversationId;
    this.getAgentIdFn = opts.getAgentId;
    // user opt is accepted for backward-compat with runtime.tsx callers
    // but unused on the AX wire (auth lives in cookies, not the body).
    void opts.user;
    void DEFAULT_USER;
  }

  /**
   * Override the AI SDK's `sendMessages` to drive the two-phase flow:
   *  1. POST /api/chat/messages with the latest user turn → mint reqId.
   *  2. open the SSE stream at /api/chat/stream/:reqId and stream it,
   *     transparently RECONNECTING to the SAME reqId if the connection
   *     drops mid-turn (Faults B/D) — never a re-POST, so a live server
   *     turn is never duplicated.
   */
  override async sendMessages(
    options: Parameters<HttpChatTransport<UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const { messages, abortSignal } = options;

    // Pull the latest user message — that's the one we POST. Earlier
    // turns are already persisted in the conversation row (Task 9 appends
    // user turns BEFORE agent:invoke; Task 15's runner replays history at
    // boot). We don't re-send them.
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') {
      // Defensive — without a fresh user message there's nothing to send.
      // Return an empty stream that emits a finish so the runtime doesn't
      // hang waiting for a response.
      return makeEmptyFinishStream();
    }

    // When a resolver is wired, it owns the answer — `null` from the
    // resolver explicitly means "no active conversation, server should
    // mint a new one" and must NOT fall through to the stale
    // localConversationId backup. The `?? localConversationId`
    // short-circuit only kicks in when no resolver is configured at
    // all (transport used standalone, e.g. in unit tests).
    const conversationId = this.getConversationIdFn
      ? this.getConversationIdFn()
      : this.localConversationId;
    const agentId = this.getAgentIdFn?.() ?? '';
    if (!agentId) {
      throw new Error('AxChatTransport: agentId is required');
    }
    const contentBlocks = toContentBlocks(last);
    if (contentBlocks.length === 0) {
      // No text to send — likely an upload-only message that we don't yet
      // serialize through the wire. Surface as a no-op finish.
      return makeEmptyFinishStream();
    }

    const postBody: PostBody = { conversationId, agentId, contentBlocks };

    // Phase 1: POST. The body cap (1 MiB) is enforced by http-server; if
    // the user pasted something gigantic it'll come back as 413. We let
    // the AI SDK surface the error to the chat hook's onError callback.
    const postInit: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // CSRF: the host's CSRF subscriber accepts the literal value
        // `ax-admin` for X-Requested-With OR a same-Origin request. The
        // exact value is the contract (see @ax/http-server csrf.ts);
        // browsers can't set custom headers on cross-origin simple
        // requests without a CORS preflight, so any non-attacker caller
        // can supply it.
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify(postBody),
      credentials: 'include',
    };
    if (abortSignal) postInit.signal = abortSignal;
    const postResp = await this.fetchImpl(this.api, postInit);
    if (!postResp.ok) {
      throw new Error(
        `chat-flow POST failed: ${postResp.status} ${postResp.statusText}`,
      );
    }
    const postOut = (await postResp.json()) as PostResponse;
    if (!postOut.reqId || !postOut.conversationId) {
      throw new Error('chat-flow POST returned malformed response');
    }
    // Capture the conversationId so subsequent turns re-use it (and the
    // history adapter can hydrate from it on next mount).
    this.localConversationId = postOut.conversationId;
    this.setConversationIdFn?.(postOut.conversationId);

    // Phase 2: SSE. Open the stream for the minted reqId and stream it with
    // transparent same-reqId reconnect (see buildReconnectingStream). The
    // FIRST GET failing is a request-time error (the turn may or may not have
    // started) — surface it as a thrown rejection so the runtime shows the
    // banner rather than silently re-POSTing.
    const firstResp = await this.openSseStream(postOut.reqId, abortSignal);
    if (!firstResp.ok || !firstResp.body) {
      throw new Error(
        `chat-flow SSE open failed: ${firstResp.status} ${firstResp.statusText}`,
      );
    }
    return this.buildReconnectingStream(
      postOut.reqId,
      firstResp.body,
      abortSignal,
    );
  }

  /** GET the SSE stream for a reqId. Used for both the initial open and
   *  every transparent reconnect. */
  private openSseStream(
    reqId: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<Response> {
    const sseInit: RequestInit = {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      credentials: 'include',
    };
    if (abortSignal) sseInit.signal = abortSignal;
    return this.fetchImpl(
      `${this.streamApi}/${encodeURIComponent(reqId)}`,
      sseInit,
    );
  }

  /**
   * Single-attempt parse of one SSE body into UIMessageChunks. Kept as the
   * unit-test entry point and used (with no reconnect) when only chunk
   * parsing matters. Each `data:` line is a JSON `SseFrame`; lines split
   * across decoder chunks are stitched via a `carry` buffer.
   *
   * Emission policy:
   *   - text-kind chunk → text-delta under id `text-N`.
   *   - thinking-kind chunk → text-delta under id `thinking-N`.
   *   - phase frame → side-channel: drives `agentStatusActions.set(label)`.
   *   - done frame → close any open part, emit `finish`.
   *   - server `error` frame (Fault A) → close any open part, emit an `error`
   *     chunk with a mapped friendly label.
   *   - stream close / body error with no terminal frame (Faults B/D) → close
   *     any open part, emit an `error` chunk (CONNECTION_LOST). NOT a silent
   *     finish — that's the FAULTA-5 bug. (In the live path `sendMessages`
   *     RECONNECTS to the same reqId before this terminal is reached; see
   *     `buildReconnectingStream`.)
   */
  protected processResponseStream(
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<UIMessageChunk> {
    const ctx = createParseCtx();
    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        const reason = await consumeSseAttempt(stream, ctx, controller);
        if (reason === 'lost') {
          ctx.closeOpen(controller);
          controller.enqueue({ type: 'error', errorText: CONNECTION_LOST });
        }
        // 'done'/'server-error' already enqueued their terminal chunk.
        controller.close();
      },
    });
  }

  /**
   * Stream the SSE for `reqId`, transparently RECONNECTING to the SAME reqId
   * if the connection drops mid-turn (Faults B/D) — a graceful `done`-less
   * close (host bounce) or a hard body error (network drop). Reconnect is a
   * GET-only re-subscribe; it NEVER re-POSTs, so a still-running server turn
   * is never duplicated (the original P1: a re-POST mints a fresh reqId +
   * agent:invoke). The server replays its per-reqId buffer on reconnect
   * (sse.ts), so we SKIP the content chunks already emitted to avoid
   * double-rendering. Bounded at MAX_RECONNECTS; when the reconnect GET fails
   * (Fault B — the host bounced, reqId+buffer gone → 404), the cap is
   * exhausted, or the turn outgrew the server's replay window (so we can't
   * dedup cleanly — see SERVER_REPLAY_WINDOW), we emit CONNECTION_LOST so the
   * runtime surfaces the error banner with a manual-retry affordance.
   *
   * An ABORT (user pressed Stop / component teardown) is NOT connection loss:
   * we close the stream WITHOUT an error chunk so the SDK's normal abort
   * handling runs and no spurious retry banner appears.
   */
  private buildReconnectingStream(
    reqId: string,
    firstBody: ReadableStream<Uint8Array>,
    abortSignal: AbortSignal | undefined,
  ): ReadableStream<UIMessageChunk> {
    const open = (r: string, sig: AbortSignal | undefined): Promise<Response> =>
      this.openSseStream(r, sig);
    const ctx = createParseCtx();
    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        const endWithBanner = (): void => {
          ctx.closeOpen(controller);
          controller.enqueue({ type: 'error', errorText: CONNECTION_LOST });
          controller.close();
        };
        let body: ReadableStream<Uint8Array> | null = firstBody;
        for (let attempt = 0; ; attempt++) {
          // On a reconnect the server replays the buffer tail; skip the
          // content chunks we've already shown so the message doesn't
          // duplicate. Also clear any partial `data:` line stranded by the
          // drop — otherwise the stale fragment would corrupt the first
          // replayed frame's JSON parse (Codex round 5).
          if (attempt > 0) {
            ctx.skipContent = ctx.emittedContent;
            ctx.carry = '';
          }
          const reason = await consumeSseAttempt(body, ctx, controller);
          if (reason === 'done' || reason === 'server-error') {
            // Terminal chunk already enqueued by the attempt.
            controller.close();
            return;
          }
          // reason === 'lost' — the connection dropped (graceful or hard)
          // without a terminal frame.
          if (abortSignal?.aborted) {
            // Intentional cancellation — NOT an error. Close cleanly so the
            // SDK's abort path runs and no retry banner shows.
            ctx.closeOpen(controller);
            controller.close();
            return;
          }
          if (
            attempt + 1 >= MAX_RECONNECTS ||
            // The server ring buffer only retains its last
            // SERVER_REPLAY_WINDOW chunks; once we've emitted more than that,
            // a reconnect's partial replay can't be deduped by count without
            // silently dropping NEW content (Codex round 5). Give up the
            // silent reconnect and surface the banner instead.
            ctx.emittedContent > SERVER_REPLAY_WINDOW
          ) {
            endWithBanner();
            return;
          }
          let resp: Response;
          try {
            resp = await open(reqId, abortSignal);
          } catch {
            // The reconnect GET itself failed (host unreachable) → give up.
            endWithBanner();
            return;
          }
          if (!resp.ok || !resp.body) {
            // 404/410 etc. — the turn is gone (Fault B host bounce evicted
            // the reqId). Surface the banner; the user can re-POST manually.
            endWithBanner();
            return;
          }
          body = resp.body;
        }
      },
    });
  }
}

/** Maximum transparent same-reqId reconnect attempts before surfacing the
 *  error banner. Three GETs (initial + 2 reconnects) span a brief proxy/tab
 *  blip without looping forever on a real outage. */
const MAX_RECONNECTS = 3;

/**
 * Conservative bound on how many content chunks the server replays on
 * reconnect. The host's per-reqId ring buffer (chunk-buffer.ts) retains its
 * last 256 chunks; we stay safely under that. Once we've emitted more than
 * this, a reconnect's replay is a PARTIAL tail that count-based dedup can't
 * align — skipping `emittedContent` would eat live chunks (silent loss). So
 * beyond this window we stop silently reconnecting and surface the banner.
 * (We don't import the server constant — Invariant I2; we mirror it
 * conservatively. A server-side per-chunk sequence number would let us dedup
 * a partial replay exactly; that's a tracked follow-up.)
 */
const SERVER_REPLAY_WINDOW = 200;

/** End-reason of a single SSE attempt. */
type AttemptEnd = 'done' | 'server-error' | 'lost';

interface ParseCtx {
  textCounter: number;
  thinkingCounter: number;
  openText: string | null;
  openThinking: string | null;
  contentSeen: boolean;
  carry: string;
  /** Total content chunks (text/thinking deltas + tool frames) emitted so
   *  far across all attempts — the dedup cursor for reconnect replay. */
  emittedContent: number;
  /** On a reconnect attempt, skip this many replayed content chunks before
   *  forwarding (and re-counting) new ones. */
  skipContent: number;
  closeOpen(controller: { enqueue(c: UIMessageChunk): void }): void;
}

function createParseCtx(): ParseCtx {
  const ctx: ParseCtx = {
    textCounter: 0,
    thinkingCounter: 0,
    openText: null,
    openThinking: null,
    contentSeen: false,
    carry: '',
    emittedContent: 0,
    skipContent: 0,
    closeOpen(controller) {
      if (ctx.openText !== null) {
        controller.enqueue({ type: 'text-end', id: ctx.openText });
        ctx.openText = null;
      }
      if (ctx.openThinking !== null) {
        controller.enqueue({ type: 'text-end', id: ctx.openThinking });
        ctx.openThinking = null;
      }
    },
  };
  return ctx;
}

/**
 * Consume ONE SSE body, emitting UIMessageChunks to `controller`, and return
 * how it ended:
 *   - 'done'         — a `done` frame arrived; a `finish` was enqueued.
 *   - 'server-error' — a server `error` frame (Fault A); an `error` chunk
 *                      with a mapped label was enqueued.
 *   - 'lost'         — the body ended (gracefully OR with an error) WITHOUT a
 *                      terminal frame (Faults B/D). NO terminal chunk is
 *                      enqueued here — the caller decides reconnect vs. emit
 *                      CONNECTION_LOST.
 *
 * Cross-attempt dedup: `ctx.skipContent` content chunks are dropped (the
 * server replays the buffer tail on reconnect); each forwarded content chunk
 * bumps `ctx.emittedContent`.
 */
async function consumeSseAttempt(
  body: ReadableStream<Uint8Array>,
  ctx: ParseCtx,
  controller: { enqueue(c: UIMessageChunk): void },
): Promise<AttemptEnd> {
  const enqueueContent = (chunk: UIMessageChunk): void => {
    if (ctx.skipContent > 0) {
      ctx.skipContent -= 1;
      return; // replayed chunk we've already shown — drop it
    }
    controller.enqueue(chunk);
    ctx.emittedContent += 1;
  };

  const ensureOpenForKind = (kind: 'text' | 'thinking'): string => {
    if (kind === 'text') {
      if (ctx.openThinking !== null) {
        controller.enqueue({ type: 'text-end', id: ctx.openThinking });
        ctx.openThinking = null;
      }
      if (ctx.openText === null) {
        ctx.openText = `text-${ctx.textCounter}`;
        ctx.textCounter += 1;
        controller.enqueue({ type: 'text-start', id: ctx.openText });
      }
      return ctx.openText;
    }
    if (ctx.openText !== null) {
      controller.enqueue({ type: 'text-end', id: ctx.openText });
      ctx.openText = null;
    }
    if (ctx.openThinking === null) {
      ctx.openThinking = `thinking-${ctx.thinkingCounter}`;
      ctx.thinkingCounter += 1;
      controller.enqueue({
        type: 'text-start',
        id: ctx.openThinking,
        providerMetadata: { ax: { thinking: true } },
      });
    }
    return ctx.openThinking;
  };

  const reader = body
    .pipeThrough(
      new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>,
    )
    .getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        // Graceful close with no terminal frame → lost (Faults B/D).
        return 'lost';
      }
      const data = ctx.carry + value;
      const lines = data.split('\n');
      ctx.carry = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data: ')) continue;

        let frame: SseFrame;
        try {
          frame = JSON.parse(trimmed.slice(6)) as SseFrame;
        } catch {
          // Malformed JSON — skip. Server is the source of truth.
          continue;
        }

        if ('done' in frame && frame.done === true) {
          ctx.closeOpen(controller);
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          return 'done';
        }
        // Server `error` frame (Fault A) — orchestrator-terminated turn. NOT
        // a connection drop: a reconnect wouldn't help, so we surface it.
        if ('error' in frame && typeof frame.error === 'string') {
          ctx.closeOpen(controller);
          controller.enqueue({
            type: 'error',
            errorText: ERROR_LABELS[frame.error] ?? DEFAULT_TURN_ERROR,
          });
          return 'server-error';
        }
        // phase frame — out-of-band; drives the status row directly.
        if ('phase' in frame && typeof frame.phase === 'string') {
          if (ctx.contentSeen) continue; // pre-content only
          const label = PHASE_LABELS[frame.phase];
          if (label !== undefined) agentStatusActions.set(label);
          continue;
        }
        // text/thinking chunk
        if (
          'kind' in frame &&
          (frame.kind === 'text' || frame.kind === 'thinking')
        ) {
          if (!ctx.contentSeen) {
            ctx.contentSeen = true;
            agentStatusActions.set('Thinking…');
          }
          const id = ensureOpenForKind(frame.kind);
          enqueueContent({
            type: 'text-delta',
            id,
            delta: frame.text,
            ...(frame.kind === 'thinking'
              ? { providerMetadata: { ax: { thinking: true } } }
              : {}),
          });
          continue;
        }
        // tool-use frame
        if ('kind' in frame && frame.kind === 'tool-use') {
          if (!ctx.contentSeen) {
            ctx.contentSeen = true;
            agentStatusActions.set('Thinking…');
          }
          ctx.closeOpen(controller);
          enqueueContent({
            type: 'tool-input-available',
            toolCallId: frame.toolCallId,
            toolName: frame.toolName,
            input: frame.input,
            dynamic: true,
          });
          continue;
        }
        // tool-result frame
        if ('kind' in frame && frame.kind === 'tool-result') {
          if (!ctx.contentSeen) {
            ctx.contentSeen = true;
            agentStatusActions.set('Thinking…');
          }
          if (frame.isError === true) {
            enqueueContent({
              type: 'tool-output-error',
              toolCallId: frame.toolCallId,
              errorText: frame.output || 'tool failed',
              dynamic: true,
            });
          } else {
            enqueueContent({
              type: 'tool-output-available',
              toolCallId: frame.toolCallId,
              output: frame.output,
              dynamic: true,
            });
          }
          continue;
        }
      }
    }
  } catch {
    // Hard body error (network drop mid-consumption) with no terminal frame.
    return 'lost';
  } finally {
    reader.releaseLock();
  }
}

/**
 * Build a no-op stream that emits `finish` and closes immediately.
 * Used when sendMessages is called without a usable user-message
 * payload (e.g., empty composer flush). Returning a real ReadableStream
 * keeps the AI SDK's chat hook on the happy path.
 */
function makeEmptyFinishStream(): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: 'finish', finishReason: 'stop' });
      controller.close();
    },
  });
}
