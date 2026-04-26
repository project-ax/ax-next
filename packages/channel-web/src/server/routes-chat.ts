import {
  isRejection,
  makeChatContext,
  makeReqId,
  PluginError,
  type ChatContext,
  type ChatMessage,
  type HookBus,
} from '@ax/core';
import { extractText, PostMessageRequest } from '../wire/chat.js';

// ---------------------------------------------------------------------------
// POST /api/chat/messages — chat-flow producer.
//
// The browser POSTs a `{ conversationId | null, agentId, contentBlocks }`
// payload; the handler:
//
//   1. requires auth (auth:require-user) → 401 on rejection.
//   2. parses + validates the body (PostMessageRequest, 1 MiB cap from
//      http-server) → 400 on invalid-payload, 413 on oversize.
//   3. ACL-gates the agent via agents:resolve → 403 forbidden, 404 not-found.
//   4. get-or-creates the conversation:
//        - conversationId === null → conversations:create
//        - else → conversations:get; on agent-mismatch → 400 (I10)
//        - on conversations:get not-found OR forbidden → 404 (no leak)
//   5. appends the user turn FIRST so a fresh-session replay (Task 15) sees
//      the latest user input even if chat:run dispatch fires before the
//      runner's first turn loop.
//   6. server-mints `reqId` (J9 — never client-supplied). The browser uses
//      it to subscribe to `GET /api/chat/stream/:reqId` for streaming.
//   7. dispatches `chat:run` ASYNC (no `await`) — the orchestrator owns the
//      lifecycle from here, the response returns 202 quickly so the client
//      can race over to the SSE subscription before the first chunk lands.
//
// CSRF (J8): the http-server's CSRF subscriber gates this route
// automatically (it fires `http:request` BEFORE handler dispatch and
// rejects state-changing methods that lack same-Origin OR
// `X-Requested-With: ax-admin`). The handler does not re-implement CSRF;
// the test harness verifies the gate by issuing a foreign-Origin POST.
//
// Boundary review (I1-I5):
//   - I1: payload field names — conversationId, agentId, reqId,
//     contentBlocks — are LLM-API vocabulary.
//   - I2: this file imports only @ax/core (and the wire schema, which
//     itself imports @ax/ipc-protocol). All other plugins are reached via
//     bus.call.
//   - I3: full handler + tests in this PR (Task 9 of Week 10–12).
//   - I4: the conversation row is the source of truth for the user turn —
//     the route appends BEFORE chat:run dispatch.
//   - I5: zod-validates body, http-server enforces 1 MiB body cap, CSRF by
//     subscriber, auth by gate.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/channel-web';

// --- duck-typed request/response (mirrors @ax/http-server's HttpRequest /
// HttpResponse minus the import — Invariant I2) ----------------------------

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
}

// --- duck-typed hook payloads (I2 — no cross-plugin imports) --------------

interface AuthRequireUserInput {
  req: RouteRequest;
}
interface AuthRequireUserOutput {
  user: { id: string; isAdmin: boolean };
}

interface AgentsResolveInput {
  agentId: string;
  userId: string;
}
interface AgentsResolveAgent {
  id: string;
  workspaceRef?: string | null;
}
interface AgentsResolveOutput {
  agent: AgentsResolveAgent;
}

interface ConversationsCreateInput {
  userId: string;
  agentId: string;
}
interface ConversationsCreateOutput {
  conversationId: string;
  agentId: string;
}

interface ConversationsGetInput {
  conversationId: string;
  userId: string;
}
interface ConversationsGetOutput {
  conversation: { conversationId: string; agentId: string };
}

interface ConversationsAppendTurnInput {
  conversationId: string;
  userId: string;
  role: 'user' | 'assistant' | 'tool';
  contentBlocks: PostMessageRequest['contentBlocks'];
}

interface ChatRunInput {
  message: ChatMessage;
}

// --- handler factory ------------------------------------------------------

export interface ChatRouteDeps {
  bus: HookBus;
  initCtx: ChatContext;
}

export function createChatRouteHandlers(deps: ChatRouteDeps) {
  const { bus, initCtx } = deps;

  return {
    /** POST /api/chat/messages */
    async postMessage(req: RouteRequest, res: RouteResponse): Promise<void> {
      // 1) Auth.
      let userId: string;
      try {
        const result = await bus.call<
          AuthRequireUserInput,
          AuthRequireUserOutput
        >('auth:require-user', initCtx, { req });
        userId = result.user.id;
      } catch (err) {
        if (err instanceof PluginError || isRejection(err)) {
          res.status(401).json({ error: 'unauthenticated' });
          return;
        }
        throw err;
      }

      // 2) Parse + validate the body. The http-server already capped the
      // body at 1 MiB BEFORE we ran (returns 413 there); here we only
      // contend with malformed JSON / schema-invalid bodies.
      let body: PostMessageRequest;
      try {
        const raw =
          req.body.length === 0
            ? {}
            : (JSON.parse(req.body.toString('utf8')) as unknown);
        const parsed = PostMessageRequest.safeParse(raw);
        if (!parsed.success) {
          res.status(400).json({ error: 'invalid-payload' });
          return;
        }
        body = parsed.data;
      } catch {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }

      // 3) agents:resolve gate. forbidden → 403, not-found → 404.
      try {
        await bus.call<AgentsResolveInput, AgentsResolveOutput>(
          'agents:resolve',
          initCtx,
          { agentId: body.agentId, userId },
        );
      } catch (err) {
        if (err instanceof PluginError) {
          if (err.code === 'forbidden') {
            res.status(403).json({ error: 'forbidden' });
            return;
          }
          if (err.code === 'not-found') {
            res.status(404).json({ error: 'agent-not-found' });
            return;
          }
        }
        throw err;
      }

      // 4) Get-or-create the conversation.
      let conversationId: string;
      if (body.conversationId === null) {
        const created = await bus.call<
          ConversationsCreateInput,
          ConversationsCreateOutput
        >('conversations:create', initCtx, {
          userId,
          agentId: body.agentId,
        });
        conversationId = created.conversationId;
      } else {
        try {
          const got = await bus.call<
            ConversationsGetInput,
            ConversationsGetOutput
          >('conversations:get', initCtx, {
            conversationId: body.conversationId,
            userId,
          });
          if (got.conversation.agentId !== body.agentId) {
            // I10 — session-agent immutability. The conversation's agent
            // was frozen at create; sending a different agentId on a
            // follow-up turn is a client bug or a tampered request.
            res.status(400).json({ error: 'agent-mismatch' });
            return;
          }
          conversationId = got.conversation.conversationId;
        } catch (err) {
          if (err instanceof PluginError) {
            // not-found OR forbidden BOTH collapse to 404 — we never tell
            // a foreign caller "this conversation exists but isn't yours."
            // (J9 — same posture as the SSE handler.)
            if (err.code === 'not-found' || err.code === 'forbidden') {
              res.status(404).json({ error: 'conversation-not-found' });
              return;
            }
          }
          throw err;
        }
      }

      // 5) Append the user turn FIRST. A fresh-session replay (Task 15)
      // sees the latest user input even if chat:run dispatch fires before
      // the runner's first turn loop. The append is awaited so a storage
      // failure surfaces as a 500 instead of a silent drop.
      await bus.call<ConversationsAppendTurnInput, unknown>(
        'conversations:append-turn',
        initCtx,
        {
          conversationId,
          userId,
          role: 'user',
          contentBlocks: body.contentBlocks,
        },
      );

      // 6) Mint reqId (J9 — server-side only). The schema doesn't carry a
      // reqId field on the request body; even if a client tried to inject
      // one, zod's strict shape would refuse it (and we'd ignore it here
      // regardless because we never read from the body to source reqId).
      const reqId = makeReqId();

      // 7) Dispatch chat:run async. The orchestrator opens its own
      // session and drives the runner; this handler returns 202 so the
      // browser races to GET /api/chat/stream/:reqId. We do NOT await
      // chat:run — that would block until the entire chat completes.
      //
      // The runChatCtx mints a fresh sessionId — chat-orchestrator
      // currently opens a new sandbox session per chat:run. Task 16
      // changes that (route-by-conversationId reuses the existing
      // session); for Task 9 we mirror the existing pattern.
      //
      // Workspace: the orchestrator currently consumes ctx.workspace.rootPath
      // and ignores agent.workspaceRef. We pass through whatever default
      // makeChatContext provides (process.cwd) — the orchestrator's
      // resolution is not our concern, and overriding here would extend
      // the contract this PR is explicitly leaving alone for Task 16.
      const runChatCtx = makeChatContext({
        sessionId: makeReqId(),
        agentId: body.agentId,
        userId,
        conversationId,
        reqId,
      });

      const message: ChatMessage = {
        role: 'user',
        content: extractText(body.contentBlocks),
      };

      // Fire-and-forget. A failure inside chat:run still emits a
      // chat:end via the orchestrator (audit-log invariant); the SSE
      // stream surfaces the terminated outcome to the client.
      void bus
        .call<ChatRunInput, unknown>('chat:run', runChatCtx, { message })
        .catch((err: unknown) => {
          initCtx.logger.warn('chat_run_dispatch_failed', {
            plugin: PLUGIN_NAME,
            reqId,
            conversationId,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        });

      // 8) 202 Accepted — the browser uses { conversationId, reqId } to
      // subscribe to the SSE endpoint.
      res.status(202).json({ conversationId, reqId });
    },
  };
}

/**
 * Register POST /api/chat/messages against @ax/http-server. Returns the
 * unregister callback the plugin tracks for shutdown.
 */
export async function registerChatRoutes(
  bus: HookBus,
  initCtx: ChatContext,
): Promise<Array<() => void>> {
  const handlers = createChatRouteHandlers({ bus, initCtx });
  const result = await bus.call<unknown, { unregister: () => void }>(
    'http:register-route',
    initCtx,
    {
      method: 'POST',
      path: '/api/chat/messages',
      // Same duck-typed cast as sse.ts — http-server's HttpRequest /
      // HttpResponse are a structural superset of our adapter; the
      // exactOptionalPropertyTypes lint forces us through `unknown` to
      // line up the narrower-optional-fields surface.
      handler: handlers.postMessage as unknown as (
        req: RouteRequest,
        res: RouteResponse,
      ) => Promise<void>,
    },
  );
  return [result.unregister];
}
