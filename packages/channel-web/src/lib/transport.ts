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
 *          Chunks under id `text-N`. `kind === 'thinking'` chunks stream as
 *          native AI-SDK `reasoning` parts (reasoning-start/-delta/-end) under
 *          id `thinking-N`, so assistant-ui renders them through its Reasoning
 *          component and folds them into the collapsed chain-of-thought.
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
import { attachmentRefBlock, AX_ATTACHMENT_URL_PREFIX } from './attachment-upload';
import { agentStatusActions } from './agent-status-store';
import { permissionCardActions } from './permission-card-store';
import { stripMcpToolPrefix } from './tool-name';
import { rememberToolHeld } from './tool-held';
import { rememberToolPhrase } from './tool-phrase';
import { decisionRaisedActions } from './decision-raised-store';
import { continuationActions } from './continuation-actions';
import { HttpError, httpFetch } from './http';
import { readSseFrames } from './sse-frames';
import { turnErrorText } from './turn-error-labels';
import type { SseFrame } from '../server/types';

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
 * SSE-open retry policy (TASK-84, budget extended in TASK-88). The browser opens
 * GET /api/chat/stream/:reqId microseconds after the POST's 202. On a cold-respawn
 * gated turn the per-reqId binding / host route can lag that GET — the early-bind
 * is best-effort, so when it doesn't hold the binding only lands AFTER the
 * orchestrator's `sandbox:open-session`, which is SECONDS later for a fresh
 * runner pod. The GET is idempotent (it only REPLAYS a bounded per-reqId buffer;
 * it never starts or duplicates a turn — that's POST's job), so re-opening it is
 * safe to retry far longer than the cold-boot window, unlike a regenerate()
 * re-POST.
 *
 * TASK-84 shipped a fixed 4-attempt / [150,400,900]ms budget (~1.45s total) —
 * too small for a genuine cold pod spawn, so the user still saw the manual
 * CONNECTION_LOST banner on cold/gated turns. TASK-88 replaces it with a
 * wall-clock budget (~30s) of capped exponential backoff (250ms doubling, capped
 * at 2s): plenty for a cold spawn, while still bounded so a turn that died before
 * ANY bind (the GET can never open) eventually surfaces the banner. We retry only
 * on TRANSIENT open failures; a real client error (401/403/400/413) is not a boot
 * race and throws on the first attempt.
 */
/** Base backoff before the first retry; doubles each attempt, capped below. */
const SSE_OPEN_BACKOFF_BASE_MS = 250;
/** Per-wait ceiling so the backoff doesn't balloon past a couple seconds. */
const SSE_OPEN_BACKOFF_CAP_MS = 2_000;
/**
 * Total wall-clock budget for the whole open-retry loop. Sized for a cold runner
 * pod spawn + per-reqId bind (seconds), with margin; once it's spent we throw →
 * the existing CONNECTION_LOST banner for the genuine terminal case.
 */
const SSE_OPEN_TOTAL_BUDGET_MS = 30_000;
/** HTTP statuses that signal "not ready yet / try again", not "you're wrong". */
const SSE_OPEN_RETRYABLE_STATUS = new Set([404, 425, 429, 502, 503, 504]);

// The wire shape used to be restated here — a third copy of `SseFrame`, already
// drifting from `src/server/types.ts` (it had no `service` / `slotTag` on a
// permission slot, and typed `phase` as a bare `string`). TASK-349 moved the
// parsing itself into `./sse-frames`, so the type now comes from the one file
// that defines the wire. What stays in this module is everything that turns a
// frame into a `UIMessageChunk`.

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
      blocks.push(attachmentRefBlock(ax.attachmentId));
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
    // Through `httpFetch` so a 401 ends the session before this throw reaches
    // anyone. The thrown `HttpError` carries authored copy — the old message
    // interpolated `status` and `statusText`, and both went straight onto the
    // banner above the composer (`turn-error.ts` → `AgentStatus`).
    const postResp = await httpFetch(this.api, postInit, this.fetchImpl);
    if (!postResp.ok) {
      throw new HttpError(this.api, postResp.status);
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
   * Attach to a post-approval continuation turn (TASK-278).
   *
   * The SDK calls this only from `chat.resumeStream()`, which the runtime
   * kicks after an approve answers a `streamReqId` on the open thread. The
   * staged id is consumed ONCE — a later, unrelated resume must never pick
   * up a stale one — and `null` (nothing staged) means "no active stream",
   * which the SDK treats as a quiet no-op.
   *
   * Single GET attempt, deliberately NOT the cold-boot retry loop: the bind
   * landed before the approve response, so a 404 here is terminal (turn
   * already ended, bind lost), not a race. A throw would surface the retry
   * banner — whose regenerate re-POSTs and could DUPLICATE the already
   * running turn — so every failure mode here returns null instead. The
   * turn still completes server-side and renders on the next read.
   */
  override async reconnectToStream(
    _options: Parameters<HttpChatTransport<UIMessage>['reconnectToStream']>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const reqId = continuationActions.takePendingContinuation();
    if (reqId === null) return null;
    const url = `${this.streamApi}/${encodeURIComponent(reqId)}`;
    let resp: Response;
    try {
      resp = await httpFetch(
        url,
        {
          method: 'GET',
          headers: { accept: 'text/event-stream' },
          credentials: 'include',
        },
        this.fetchImpl,
      );
    } catch {
      return null;
    }
    if (!resp.ok || !resp.body) {
      if (resp.status !== 404) {
        console.warn(`[chat] the continuation stream would not open: ${url} → ${resp.status}`);
      }
      return null;
    }
    return this.buildTurnStream(resp.body, undefined);
  }

  /**
   * Open GET /api/chat/stream/:reqId, retrying on a transient open failure with
   * capped exponential backoff under a wall-clock budget (TASK-84 / TASK-88).
   * Returns the SSE response body on success; throws once the time budget is
   * spent OR on a non-retryable status. Retrying the GET is safe because it only
   * replays the server's bounded per-reqId buffer — it never starts a turn (only
   * POST does). Honors abortSignal: an abort during a fetch or a backoff wait
   * stops the loop immediately.
   *
   * While we're committed to waiting out a (possibly multi-second) cold boot, we
   * surface the "Starting sandbox…" status so the wait isn't a silent hang. We
   * set it lazily — only after the first retryable failure, so the happy-path
   * first-open success never flashes it. The label transitions naturally once the
   * stream opens (the phase/content handlers overwrite it) or on the terminal
   * throw (the runtime's onError swaps to the CONNECTION_LOST banner).
   */
  private async openSseStream(
    reqId: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<ReadableStream<Uint8Array>> {
    const url = `${this.streamApi}/${encodeURIComponent(reqId)}`;
    const deadline = Date.now() + SSE_OPEN_TOTAL_BUDGET_MS;
    let lastStatus = 0;
    let lastStatusText = '';
    let statusShown = false;
    // True once we break out of the loop on a NON-retryable status (401/403/etc.)
    // — a real client error, surfaced verbatim. A break on a spent budget leaves
    // this false: that's the genuine terminal cold-boot case, which falls back to
    // the user-facing CONNECTION_LOST banner instead of a raw status string.
    let failFast = false;
    // Backoff before the NEXT retry: capped exponential growth from BASE.
    let backoffMs = SSE_OPEN_BACKOFF_BASE_MS;

    /**
     * After a retryable failure, wait `backoffMs` (clamped so we never overshoot
     * the deadline) and grow the backoff for next time, surfacing the cold-boot
     * status on the way. Returns false when the budget is spent (caller throws).
     */
    const waitForRetry = async (): Promise<boolean> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      if (!statusShown) {
        // Lazily reveal the cold-boot label now that we're actually waiting.
        const label = PHASE_LABELS['sandbox-starting'];
        if (label !== undefined) agentStatusActions.show(label);
        statusShown = true;
      }
      const ms = Math.min(backoffMs, remaining);
      await this.sseBackoffWait(ms, abortSignal);
      backoffMs = Math.min(backoffMs * 2, SSE_OPEN_BACKOFF_CAP_MS);
      return true;
    };

    for (;;) {
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
        resp = await httpFetch(url, sseInit, this.fetchImpl);
      } catch (err) {
        // A network-level throw (connection refused / reset while the host is
        // still coming up) is transient — retry it like a retryable status.
        // But a caller-driven abort is NOT: re-throw so the SDK's normal
        // cancellation runs (no spurious retry).
        if (abortSignal?.aborted) throw err;
        lastStatus = 0;
        lastStatusText = err instanceof Error ? err.message : 'network error';
        if (await waitForRetry()) continue;
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
        failFast = true;
        break;
      }
      if (await waitForRetry()) continue;
      break;
    }
    // Budget spent on a retryable failure → the genuine terminal cold-boot case
    // (the turn died before ANY bind, so the GET can never open). Surface the
    // user-facing CONNECTION_LOST banner — same wording + manual-retry affordance
    // as a mid-turn drop — rather than a raw status string. A fail-fast client
    // error keeps its verbatim message (it's a real bug, not a connection loss).
    if (!failFast) {
      throw new Error(CONNECTION_LOST);
    }
    // A fail-fast status is a real client error, and it used to keep its
    // verbatim `401 Unauthorized` / `403 Forbidden` text — which the banner
    // then showed a reader. `lastStatusText` is logged, not rendered: it is the
    // HTTP/1.1 reason-phrase and HTTP/2 has none, so half the time it was an
    // empty string glued onto a number.
    console.warn(
      `[chat] the reply stream would not open: ${url} → ${lastStatus} ${lastStatusText}`,
    );
    throw new HttpError(url, lastStatus);
  }

  /**
   * Sleep for `ms`, resolving early (and leaving the abort to be observed by the
   * next loop guard) if the signal fires. Pure timer wait — no fetch — so an
   * abort never leaks a pending connection.
   */
  private sseBackoffWait(
    ms: number,
    abortSignal: AbortSignal | undefined,
  ): Promise<void> {
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
   * Single-attempt render of one SSE body into UIMessageChunks. The unit-test
   * entry point, and the core of `buildTurnStream`. The wire underneath it —
   * `data:` framing, lines split across reads, the TASK-23 seq cursor — is
   * `./sse-frames`, shared with the agent workspace's reader (TASK-349).
   *
   * Emission policy:
   *   - text-kind chunk → text-delta under id `text-N`.
   *   - thinking-kind chunk → reasoning-delta under id `thinking-N`, so
   *     assistant-ui folds it into the collapsed chain-of-thought (TASK-307;
   *     this line said `text-delta` for three months after it stopped being
   *     true).
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
   *     the shared reader (`./sse-frames`) dedups a replayed partial buffer
   *     EXACTLY (skips frames at/below the last-seen seq) and DETECTS a gap (a seq that
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
  /** Count of content chunks (text/thinking deltas + tool frames) emitted so
   *  far across attempts. Drives the "have we shown anything yet?" gate that
   *  decides whether a drop is silently reconnectable (pre-content) or must
   *  surface the banner (content already streamed — a partial replay can't be
   *  safely deduped). */
  emittedContent: number;
  closeOpen(controller: { enqueue(c: UIMessageChunk): void }): void;
}

function createParseCtx(): ParseCtx {
  const ctx: ParseCtx = {
    textCounter: 0,
    thinkingCounter: 0,
    openText: null,
    openThinking: null,
    contentSeen: false,
    emittedContent: 0,
    closeOpen(controller) {
      if (ctx.openText !== null) {
        controller.enqueue({ type: 'text-end', id: ctx.openText });
        ctx.openText = null;
      }
      if (ctx.openThinking !== null) {
        controller.enqueue({ type: 'reasoning-end', id: ctx.openThinking });
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
 *                      terminal frame (Faults B/D), or the shared reader
 *                      detected a TASK-23 sequence gap. NO terminal chunk is
 *                      enqueued here — the caller (`buildTurnStream`) emits
 *                      CONNECTION_LOST (or closes cleanly on abort).
 *
 * The wire itself — `data: ` framing, the carry buffer across reads, malformed
 * JSON, `:` keepalive comments, and the TASK-23 seq dedup + gap detection —
 * belongs to `./sse-frames` and is shared with the agent workspace's reader.
 * What is left here is the half that is genuinely chat's: turning a frame into
 * an AI-SDK `UIMessageChunk`, and driving the stores that assistant-ui reads.
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
        controller.enqueue({ type: 'reasoning-end', id: ctx.openThinking });
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
      // Thinking streams as a native AI-SDK `reasoning` part (reasoning-start
      // /-delta /-end) so assistant-ui renders it via its Reasoning component
      // and MessagePrimitive.GroupedParts can fold it into the collapsed
      // chain-of-thought. (It used to ride as a `text` part tagged with
      // providerMetadata.ax.thinking, which rendered as plain visible prose.)
      controller.enqueue({ type: 'reasoning-start', id: ctx.openThinking });
    }
    return ctx.openThinking;
  };

  /**
   * Set by the two terminal branches before they stop the read, so the reader's
   * `stopped` reason can be resolved back to WHICH terminator it was — the
   * caller behaves differently for the two (a `done` closes cleanly; a
   * `server-error` has already enqueued its own error chunk).
   */
  let terminal: AttemptEnd | null = null;

  const end = await readSseFrames(body, (frame: SseFrame) => {
    if ('done' in frame && frame.done === true) {
      ctx.closeOpen(controller);
      controller.enqueue({ type: 'finish', finishReason: 'stop' });
      terminal = 'done';
      return 'stop';
    }
    // Server `error` frame (Fault A) — orchestrator-terminated turn. NOT
    // a connection drop: a reconnect wouldn't help, so we surface it.
    if ('error' in frame && typeof frame.error === 'string') {
      ctx.closeOpen(controller);
      /*
        THE LAST HAND-COPY OF THE LABEL RULE, now gone (TASK-498).

        This was `ERROR_LABELS[frame.error] ?? DEFAULT_TURN_ERROR` plus its own
        clamp-and-join of the TASK-160 `detail` line — the same four lines as
        the workspace reader, kept in step by hand. `turnErrorText` was
        extracted for the workspace's live and reloaded paths; a reviewer
        pointed out this file was still copying it, which made the claim that
        the rule lives in one place simply untrue, and left THIS reader with
        its own copy of a defect the other copies had just been fixed for: the
        label table is an object literal, so a reason code of `toString` (or
        `constructor`) resolves up the prototype chain to a FUNCTION, the `??`
        never fires, and the template stringifies it into the chunk a person
        reads. Latent — reason codes are host vocabulary — but this is the
        surface real users are on today.

        Yes, TASK-360 deletes this file with the rest of the chat tree. That
        argues against BUILDING here; it does not argue for keeping a duplicate
        of a rule we just centralised, and this change is net fewer lines in
        the doomed tree, not more.

        `detail` is UNTRUSTED text — bounded and control-char-stripped
        server-side, clamped again inside `turnErrorText`, and rendered as
        plain text (never markup: the AgentStatus error row shows the string
        verbatim).
      */
      const errorText = turnErrorText(
        frame.error,
        'detail' in frame && typeof frame.detail === 'string' ? frame.detail : null,
      );
      controller.enqueue({ type: 'error', errorText });
      terminal = 'server-error';
      return 'stop';
    }
    // phase frame — out-of-band; drives the status row directly.
    if ('phase' in frame && typeof frame.phase === 'string') {
      if (ctx.contentSeen) return 'continue'; // pre-content only
      const label = PHASE_LABELS[frame.phase];
      if (label !== undefined) agentStatusActions.set(label);
      return 'continue';
    }
    // permissionRequest frame — out-of-band JIT bundled approval card
    // (§11.3). Drives the card store; the stream keeps flowing
    // (NON-terminal, like phase). Carries only public manifest data — no
    // secret rides this frame.
    if ('permissionRequest' in frame && frame.permissionRequest) {
      permissionCardActions.show(frame.permissionRequest);
      return 'continue';
    }
    // decisionRaised frame (TASK-261) — out-of-band, same posture as
    // permissionRequest: the stream keeps flowing (NON-terminal), and
    // nothing here touches `controller` or enqueues a UIMessageChunk.
    // A held call is not part of the transcript; the card that renders
    // it (T4) is fed by the decisions route, not by this frame. All this
    // branch does is bump a counter so `useConversationDecisions` knows
    // to re-read that route. A frame without a decisionId describes
    // nothing actionable, so it's dropped rather than triggering a read.
    if ('decisionRaised' in frame && frame.decisionRaised) {
      if (
        typeof frame.decisionRaised.decisionId === 'string' &&
        frame.decisionRaised.decisionId.length > 0
      ) {
        decisionRaisedActions.raise();
      }
      return 'continue';
    }
    // Everything below is a content frame. Anything the reader handed us at
    // this point has already cleared the TASK-23 seq cursor: a replayed
    // duplicate never arrives, and a contiguity gap ends the read instead
    // (see `./sse-frames`), which surfaces as the CONNECTION_LOST banner.
    //
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
      enqueueContent(
        frame.kind === 'thinking'
          ? { type: 'reasoning-delta', id, delta: frame.text }
          : { type: 'text-delta', id, delta: frame.text },
      );
      return 'continue';
    }
    // tool-use frame
    if ('kind' in frame && frame.kind === 'tool-use') {
      if (!ctx.contentSeen) {
        ctx.contentSeen = true;
        agentStatusActions.set('Thinking…');
      }
      ctx.closeOpen(controller);
      // TASK-271: stash the host-authored phrase for the ToolFallback
      // label. toolName stays the STABLE stripped identifier — renderer
      // dispatch (Thread.tsx) and artifact pairing (MarkdownText.tsx)
      // key on it, and the mcp__ strip remains the fallback for calls
      // with no phrase.
      rememberToolPhrase(frame.toolCallId, frame.activityPhrase);
      enqueueContent({
        type: 'tool-input-available',
        toolCallId: frame.toolCallId,
        // TASK-260: the SDK renames an MCP-hosted tool to
        // `mcp__<server>__<tool>` — that's an internal wire identifier,
        // not something a person should see. Strip it so the transcript
        // renders the bare ax-native name the renderers already key on.
        toolName: stripMcpToolPrefix(frame.toolName),
        input: frame.input,
        dynamic: true,
      });
      return 'continue';
    }
    // tool-result frame
    if ('kind' in frame && frame.kind === 'tool-result') {
      if (!ctx.contentSeen) {
        ctx.contentSeen = true;
        agentStatusActions.set('Thinking…');
      }
      // TASK-270: stash the held mark before enqueueing — the enqueued
      // part cannot carry it (lossy bridge), and the reader side
      // (history-adapter) stashes the same way, so live and reload agree.
      rememberToolHeld(frame.toolCallId, frame.held);
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
      return 'continue';
    }
    return 'continue';
  });

  // 'stopped' is the only end that carries a terminal chunk. Everything else —
  // a graceful close with no terminator, a seq gap, a body error, or a
  // consumer that threw — is a drop the caller turns into CONNECTION_LOST.
  if (end.reason === 'stopped' && terminal !== null) return terminal;
  if (end.reason === 'body-error' && !isAbortError(end.error)) {
    // The reader sees CONNECTION_LOST either way; this is the CAUSE behind it.
    // Before TASK-349 there was nothing to log — the old handler was a bare
    // `catch { return 'lost'; }` that never bound the error, so a TCP reset, a
    // decode failure and a renderer that threw were indistinguishable in the
    // console. Extracting the reader made the cause available, and dropping it
    // on the floor after deliberately plumbing it out is the swallowed-error
    // shape this repo keeps finding. The workspace reader logs the same thing.
    console.warn('[chat] reply stream ended badly', end.error);
  }
  return 'lost';
}

/**
 * A fetch/stream abort — the user pressed Stop, or the component unmounted.
 * Nothing went wrong, so it must not be logged as a failure. Chat's reader has
 * no `AbortSignal` of its own to consult (the workspace's does, and checks it
 * instead), so this reads the rejection the abort actually produces: a
 * `DOMException` named `AbortError`.
 */
function isAbortError(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
  );
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
