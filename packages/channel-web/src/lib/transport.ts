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
import { permissionCardActions } from './permission-card-store';

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
 * User-facing banner text for a `done`-less stream close (Faults B/D — the
 * host bounced or the network dropped mid-turn, so the SSE connection died
 * before any terminal `done`/`error` frame arrived). The transport emits this
 * as an AI-SDK `error` chunk; the runtime's onError renders it on the
 * AgentStatus error row, which shows a "retry" button alongside.
 *
 * Wording is MANUAL-retry copy ("Retry to continue.", mirroring
 * DEFAULT_TURN_ERROR) — there is NO automatic retry/reconnect on this path yet.
 * TASK-23 shipped the loss-free primitive (the host-minted per-chunk `seq` the
 * client dedups on; see the transport's buildTurnStream doc), but the automatic
 * same-reqId re-open that would consume it is a tracked follow-up — until that
 * lands this stays manual-retry copy. Saying "Retrying…" would be a lie that
 * leaves the user waiting instead of clicking retry.
 */
export const CONNECTION_LOST = 'Connection lost. Retry to continue.';

/**
 * SSE-open retry policy (TASK-84). The browser opens GET /api/chat/stream/:reqId
 * microseconds after the POST's 202. On a cold-respawn gated turn the per-reqId
 * binding / host route can lag that GET by a beat, so the FIRST open 404s and —
 * before this — the user had to retry by hand. The GET is idempotent (it only
 * REPLAYS a bounded per-reqId buffer; it never starts or duplicates a turn —
 * that's POST's job), so re-opening it is safe, unlike a regenerate() re-POST.
 * We retry a SMALL number of times with short backoff on TRANSIENT open
 * failures only; a real client error (401/403/400/413) is not a boot race and
 * throws on the first attempt.
 */
const SSE_OPEN_MAX_ATTEMPTS = 4;
const SSE_OPEN_BACKOFF_MS = [150, 400, 900];
/** HTTP statuses that signal "not ready yet / try again", not "you're wrong". */
const SSE_OPEN_RETRYABLE_STATUS = new Set([404, 425, 429, 502, 503, 504]);

/**
 * Map a wire turn-error reason code (backend-agnostic, from the orchestrator)
 * to a user-facing label. Unknown codes fall back to DEFAULT_TURN_ERROR —
 * forward-compat with newer server builds that emit a code the client
 * doesn't yet recognize.
 */
const ERROR_LABELS: Record<string, string> = {
  'chat-run-timeout': 'The agent timed out. Retry to continue.',
};

/** Shape of one SSE `data:` JSON payload. Matches `SseFrame` in src/server/types.ts.
 *  `seq` (TASK-23) is the host-minted monotonic per-reqId cursor on content
 *  frames; the client dedups replayed frames at/below its last-seen seq and
 *  falls back to the CONNECTION_LOST banner on a contiguity gap. Optional —
 *  an older server build that never stamps seq parses (and behaves) as before. */
type SseFrame =
  | { reqId: string; kind: 'text'; text: string; seq?: number }
  | { reqId: string; kind: 'thinking'; text: string; seq?: number }
  | {
      reqId: string;
      kind: 'tool-use';
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      seq?: number;
    }
  | {
      reqId: string;
      kind: 'tool-result';
      toolCallId: string;
      output: string;
      isError?: boolean;
      seq?: number;
    }
  | { reqId: string; phase: string }
  | { reqId: string; done: true }
  | { reqId: string; error: string }
  | {
      reqId: string;
      permissionRequest:
        | {
            kind: 'skill';
            skillId: string;
            description: string;
            hosts: string[];
            slots: { slot: string; kind: 'api-key' }[];
            // TASK-39: open-mode banner flag — rides the SSE frame verbatim and
            // is forwarded to the card store (drives the "new skill" warning).
            authored?: boolean;
            // npm/pypi packages declared by the skill — forwarded verbatim to
            // the card store (drives the informational registry line).
            packages?: { npm: string[]; pypi: string[] };
          }
        | { kind: 'host'; host: string; sessionId: string };
    };

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
   *  2. open the SSE stream at /api/chat/stream/:reqId and stream it via
   *     buildTurnStream, which on a mid-turn drop (Faults B/D) surfaces the
   *     CONNECTION_LOST error chunk (→ runtime banner + manual retry) instead
   *     of a silent finish (the FAULTA-5 bug).
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

    // Phase 2: SSE. Open the stream for the minted reqId with bounded backoff/
    // retry on a transient open failure (TASK-84 — the cold-respawn 404 race),
    // then feed its body to buildTurnStream. A FAILED open after the retry
    // budget is a request-time error (the turn may or may not have started) —
    // surface it as a thrown rejection so the runtime shows the banner rather
    // than auto-RE-POSTING (which could duplicate a started turn).
    const sseBody = await this.openSseStream(postOut.reqId, abortSignal);
    return this.buildTurnStream(sseBody, abortSignal);
  }

  /**
   * Open GET /api/chat/stream/:reqId, retrying on a transient open failure with
   * bounded backoff (TASK-84). Returns the SSE response body on success; throws
   * once the attempt budget is spent OR on a non-retryable status. Retrying the
   * GET is safe because it only replays the server's bounded per-reqId buffer —
   * it never starts a turn (only POST does). Honors abortSignal: an abort during
   * a fetch or a backoff wait stops the loop immediately.
   */
  private async openSseStream(
    reqId: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<ReadableStream<Uint8Array>> {
    const url = `${this.streamApi}/${encodeURIComponent(reqId)}`;
    let lastStatus = 0;
    let lastStatusText = '';
    for (let attempt = 0; attempt < SSE_OPEN_MAX_ATTEMPTS; attempt += 1) {
      if (abortSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const sseInit: RequestInit = {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        credentials: 'include',
      };
      if (abortSignal) sseInit.signal = abortSignal;

      let resp: Response;
      try {
        resp = await this.fetchImpl(url, sseInit);
      } catch (err) {
        // A network-level throw (connection refused / reset while the host is
        // still coming up) is transient — retry it like a retryable status.
        // But a caller-driven abort is NOT: re-throw so the SDK's normal
        // cancellation runs (no spurious retry).
        if (abortSignal?.aborted) throw err;
        lastStatus = 0;
        lastStatusText = err instanceof Error ? err.message : 'network error';
        if (attempt < SSE_OPEN_MAX_ATTEMPTS - 1) {
          await this.sseBackoffWait(attempt, abortSignal);
          continue;
        }
        break;
      }

      if (resp.ok && resp.body) {
        return resp.body;
      }
      lastStatus = resp.status;
      lastStatusText = resp.statusText;
      // A non-retryable status (e.g. 401/403/400/413) is a real error, not a
      // boot race — fail fast without burning the budget.
      if (!SSE_OPEN_RETRYABLE_STATUS.has(resp.status)) {
        break;
      }
      if (attempt < SSE_OPEN_MAX_ATTEMPTS - 1) {
        await this.sseBackoffWait(attempt, abortSignal);
      }
    }
    throw new Error(`chat-flow SSE open failed: ${lastStatus} ${lastStatusText}`);
  }

  /**
   * Sleep for the configured backoff for `attempt`, resolving early (and
   * leaving the abort to be observed by the next loop guard) if the signal
   * fires. Pure timer wait — no fetch — so an abort never leaks a pending
   * connection.
   */
  private sseBackoffWait(
    attempt: number,
    abortSignal: AbortSignal | undefined,
  ): Promise<void> {
    const ms =
      SSE_OPEN_BACKOFF_MS[attempt] ??
      SSE_OPEN_BACKOFF_MS[SSE_OPEN_BACKOFF_MS.length - 1]!;
    return new Promise<void>((resolve) => {
      if (abortSignal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        abortSignal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Single-attempt parse of one SSE body into UIMessageChunks. The unit-test
   * entry point, and the core of `buildTurnStream`. Each `data:` line is a
   * JSON `SseFrame`; lines split across decoder chunks are stitched via a
   * `carry` buffer.
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
   *     finish — that's the FAULTA-5 bug. The runtime turns the CONNECTION_LOST
   *     chunk into the error banner with a manual-retry affordance.
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
   * Stream one turn's SSE body to the AI SDK. On a non-terminal drop (Faults
   * B/D — graceful `done`-less close or a hard body error) emit the
   * CONNECTION_LOST `error` chunk so the runtime surfaces the error banner
   * with a manual-retry (`regenerate`) affordance — NOT a silent finish
   * (the FAULTA-5 bug).
   *
   * Why NOT an automatic silent reconnect/regenerate:
   *   - A client-side `regenerate()` re-POSTs → mints a fresh reqId +
   *     `agent:invoke` and can DUPLICATE a still-running server turn (a client
   *     SSE disconnect doesn't terminate the runner). Never do that
   *     automatically.
   *   - A GET-only same-reqId reconnect replays the server's per-reqId ring
   *     buffer (sse.ts), which is BOUNDED (chunk-buffer.ts: last 256 chunks).
   *     TASK-23 added a host-minted monotonic per-chunk `seq` to the wire, so
   *     `consumeSseAttempt` can now dedup a replayed partial buffer EXACTLY
   *     (skip frames at/below the last-seen seq) and DETECT a gap (a seq that
   *     jumps past last-seen + 1 after content already streamed = the buffer
   *     dropped frames the client never saw). On such a gap it falls back to
   *     this same CONNECTION_LOST banner — silent loss is worse than a banner.
   *
   * So a drop deterministically surfaces the banner; the user's explicit retry
   * (a deliberate action) re-runs the turn. The seq dedup/gap infra (TASK-23)
   * is the ENABLING half of FAULTA-5's envisioned "silent retry first": the
   * client can now resume a same-reqId reconnect loss-free. FOLLOW-UP (still
   * open): actually wiring the automatic same-reqId re-open of
   * /api/chat/stream/:reqId mid-turn (the consuming UX) on top of this infra —
   * deferred so this PR ships the loss-free primitive without changing the
   * drop-handling UX in the same change.
   *
   * An ABORT (user pressed Stop / component teardown) is NOT connection loss:
   * close the stream WITHOUT an error chunk so the SDK's normal abort handling
   * runs and no spurious retry banner appears.
   */
  private buildTurnStream(
    body: ReadableStream<Uint8Array>,
    abortSignal: AbortSignal | undefined,
  ): ReadableStream<UIMessageChunk> {
    const ctx = createParseCtx();
    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        const reason = await consumeSseAttempt(body, ctx, controller);
        if (reason === 'done' || reason === 'server-error') {
          // Terminal chunk already enqueued by the attempt.
          controller.close();
          return;
        }
        // reason === 'lost' — dropped without a terminal frame.
        if (abortSignal?.aborted) {
          // Intentional cancellation — close cleanly, no banner.
          ctx.closeOpen(controller);
          controller.close();
          return;
        }
        ctx.closeOpen(controller);
        controller.enqueue({ type: 'error', errorText: CONNECTION_LOST });
        controller.close();
      },
    });
  }
}

/** End-reason of a single SSE attempt. */
type AttemptEnd = 'done' | 'server-error' | 'lost';

interface ParseCtx {
  textCounter: number;
  thinkingCounter: number;
  openText: string | null;
  openThinking: string | null;
  contentSeen: boolean;
  carry: string;
  /** Count of content chunks (text/thinking deltas + tool frames) emitted so
   *  far across attempts. Drives the "have we shown anything yet?" gate that
   *  decides whether a drop is silently reconnectable (pre-content) or must
   *  surface the banner (content already streamed — a partial replay can't be
   *  safely deduped). */
  emittedContent: number;
  /** Highest host-minted content `seq` seen so far across attempts (TASK-23).
   *  0 = no seq-bearing content frame yet. A frame with `seq <= lastSeq` is a
   *  replay duplicate (skip it — exact dedup). A frame with `seq > lastSeq + 1`
   *  AFTER lastSeq > 0 is a contiguity gap: the bounded buffer dropped frames
   *  the client never saw, so we surface the CONNECTION_LOST banner rather than
   *  silently rendering a truncated reply. The FIRST content frame (lastSeq 0)
   *  may start at any seq — connect-time buffer truncation is not a mid-stream
   *  loss. Frames with no seq (older server) never touch this and always pass. */
  lastSeq: number;
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
    lastSeq: 0,
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
 *                      enqueued here — the caller (`buildTurnStream`) emits
 *                      CONNECTION_LOST (or closes cleanly on abort).
 *
 * Each forwarded content chunk bumps `ctx.emittedContent` (the "have we shown
 * anything yet?" counter).
 */
async function consumeSseAttempt(
  body: ReadableStream<Uint8Array>,
  ctx: ParseCtx,
  controller: { enqueue(c: UIMessageChunk): void },
): Promise<AttemptEnd> {
  // Emit one content chunk and advance the content counter (the
  // "have we shown anything yet?" gate the reconnect logic reads).
  const enqueueContent = (chunk: UIMessageChunk): void => {
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

  // True once we've actively cancelled the reader (a LOCALLY-detected seq gap;
  // TASK-23 / Codex P2). `reader.cancel()` already releases the lock, so the
  // finally must NOT also `releaseLock()` or it throws. Cancelling here
  // propagates upstream through the pipe to the underlying HTTP body, so the
  // SSE request actually closes — otherwise the browser would leave it open and
  // the server would keep its per-connection subscribers/writes alive until the
  // turn ends or times out, even though the client already showed the banner.
  let cancelledForGap = false;
  const cancelForGap = async (): Promise<'lost'> => {
    cancelledForGap = true;
    try {
      await reader.cancel();
    } catch {
      // Body already closed/errored — nothing to cancel.
    }
    return 'lost';
  };

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
        // permissionRequest frame — out-of-band JIT bundled approval card
        // (§11.3). Drives the card store; the stream keeps flowing
        // (NON-terminal, like phase). Carries only public manifest data — no
        // secret rides this frame.
        if ('permissionRequest' in frame && frame.permissionRequest) {
          permissionCardActions.show(frame.permissionRequest);
          continue;
        }
        // TASK-23 — per-chunk seq dedup + gap detection (content frames only).
        // The host stamps a monotonic per-reqId `seq` (minted from 1) on every
        // content frame.
        //   - seq <= lastSeq  → a replayed duplicate; SKIP it (exact dedup of a
        //     partial buffer replay — this is what makes a same-reqId reconnect
        //     loss-free instead of double-rendering the replayed tail).
        //   - the FIRST seq-bearing content frame with seq > 1 → the bounded
        //     256-frame buffer already dropped the head (seq 1..seq-1) before
        //     THIS client ever saw it. Servers always mint from 1, so a first
        //     frame above 1 is proof of a truncated head → surface the
        //     CONNECTION_LOST banner (return 'lost') rather than rendering the
        //     tail as a complete answer and silently omitting the head (Codex
        //     P2). A first frame at exactly seq 1 is the clean start.
        //   - lastSeq > 0 && seq > lastSeq + 1 → a mid-stream contiguity GAP:
        //     the buffer dropped frames the client never saw. Same banner.
        //   - otherwise → accept and advance lastSeq.
        // Frames WITHOUT a numeric seq (older server build) bypass this entirely
        // and stream as before (forward-compat — no dedup, no gap detection).
        if ('kind' in frame && typeof (frame as { seq?: unknown }).seq === 'number') {
          const seq = (frame as { seq: number }).seq;
          if (seq <= ctx.lastSeq) {
            continue; // duplicate replayed frame — already shown
          }
          if (ctx.lastSeq === 0) {
            // First seq-bearing content frame for this stream. A clean start is
            // seq 1; anything higher means the buffer head was dropped before
            // this client connected → loss, not a valid baseline. The body is
            // still open, so cancel it (we won't read any more of it).
            if (seq > 1) {
              return await cancelForGap();
            }
          } else if (seq > ctx.lastSeq + 1) {
            // Hole in the sequence after content already streamed → loss.
            return await cancelForGap();
          }
          ctx.lastSeq = seq;
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
    // `reader.cancel()` (the locally-detected gap path) already released the
    // lock — calling releaseLock() again would throw. Only release on the
    // non-cancel exits (done / terminal frame / body error).
    if (!cancelledForGap) {
      reader.releaseLock();
    }
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
