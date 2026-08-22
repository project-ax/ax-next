/**
 * Agent-workspace — HTTP client.
 *
 * This layer used to talk to a mock backend that lived in `mock/workspace.ts`.
 * That mock is gone and `/api/workspace/*` is now served by the real host, so
 * what is left here is exactly the set of calls something actually answers:
 * `board()`, `agent(id)`, `route()`, plus the two shipped chat calls.
 *
 * WHAT WAS DELETED, AND WHY IT IS NOT COMING BACK AS A STUB
 *
 * `approve` / `dismiss` / `undo` / `pause` / `restart` / `saveMemory` /
 * `stopAll` / `setScenario` / `createAgent` (and the `ApproveResponse` shape,
 * and `DemoScenario` with `BoardState.scenario` / `BoardState.stoppedAll`) all
 * pointed at mock routes that no longer exist. A client method calling a route
 * nobody serves is the half-wired trap the repo's Half-Wired Code Policy
 * forbids: it reads as a working feature and fails at runtime. They come back
 * with the substrate that serves them:
 *
 *   - AW-11 — the decisions queue: `approve`, `dismiss`, `undo`.
 *   - AW-12 — the halted/paused agent state and its files: `pause`, `restart`.
 *   - AW-13 — writable memory: `saveMemory`.
 *
 * `stopAll` / `setScenario` / `createAgent` were demo-strip and prototype
 * plumbing. They are not planned; the create flow already ships elsewhere.
 *
 * SENDING A MESSAGE IS NOT A WORKSPACE ROUTE. It goes to the shipped
 * `POST /api/chat/messages` + `GET /api/chat/stream/:reqId`, because a second
 * route in front of the chat POST would be a second source of truth for
 * starting a turn (invariant 4).
 */
import type { PostMessageResponse } from '@/wire/chat';
import type {
  ActivityEvent,
  Decision,
  MemoryDoc,
  PastConversation,
  PermissionRow,
  ThreadMessage,
  WorkspaceAgent,
  WorkspaceFile,
} from '@/lib/workspace-types';

export type {
  ActivityEvent,
  Decision,
  MemoryDoc,
  PastConversation,
  PermissionRow,
  ThreadMessage,
  WorkspaceAgent,
  WorkspaceFile,
};

export interface BoardState {
  agents: WorkspaceAgent[];
  /** Always `[]` until `@ax/decisions` lands (AW-11). */
  decisions: Decision[];
  /** Always `[]` until anything records what agents do (AW-14). */
  activity: ActivityEvent[];
}

export interface AgentDetail {
  agent: WorkspaceAgent;
  /** Always `[]` in this task — the generated policy rows land in AW-14. */
  permissions: PermissionRow[];
  /**
   * The conversation `thread` was read from — the agent's current one, or the
   * past one asked for by `agent(id, conversationId)`. `null` when the agent
   * has never had a conversation, or when the current one was deleted between
   * the list and the read.
   */
  conversationId: string | null;
  /** Reconstructed from the real turns of that conversation. */
  thread: ThreadMessage[];
  /** Older conversations, newest first. Pointers only — see `PastConversation`. */
  past: PastConversation[];
  /** Always `[]` in this task — AW-12. */
  files: WorkspaceFile[];
  /** Always `[]` in this task — AW-13. */
  memory: MemoryDoc[];
}

/** CSRF: the host's guard accepts the literal `ax-admin` (see @ax/http-server). */
const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
};

async function req<T>(path: string, init?: { method: string }): Promise<T> {
  const res = await fetch(`/api/workspace${path}`, {
    method: init?.method ?? 'GET',
    credentials: 'include',
    ...(init?.method !== undefined && init.method !== 'GET'
      ? { headers: writeHeaders }
      : {}),
  });
  if (!res.ok) {
    throw new Error(`workspace ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface RouteProposal {
  agentId: string;
  agentName: string;
  why: string;
  confident: boolean;
}

export interface SendMessageInput {
  agentId: string;
  /** `null` starts a new conversation — the server mints the row and the id. */
  conversationId: string | null;
  text: string;
}

export interface StreamHandlers {
  /** One text delta. Called many times; concatenate in order. */
  onText: (chunk: string) => void;
  /** The turn ended normally. */
  onDone: () => void;
  /** The turn ended badly, or the stream dropped without a terminator. */
  onError: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * Shown when the stream ends with no `done` and no `error` — the host bounced
 * or the network dropped mid-turn. Saying nothing would leave a spinner up
 * forever, which is the one outcome worse than an error line.
 *
 * Phrased as a DETAIL, not as a sentence. The surface writes its own one-line
 * prose ("That reply didn't finish…") and renders this underneath it. It used
 * to be a full instruction — "Send it again to pick up where we left off" —
 * which the caller then concatenated into its own instruction, producing three
 * sentences about one event that told the reader twice to do a thing the UI
 * now does with a Resend button.
 */
export const WORKSPACE_STREAM_LOST =
  'the reply stream ended without finishing';

export const workspaceApi = {
  board: () => req<BoardState>('/state'),

  /**
   * One agent's panel. `conversationId` reads one of the agent's PAST
   * conversations instead of its current one — the rail's read-only excerpt.
   * The server re-checks ownership of that id and 404s a conversation that is
   * not this agent's, so a stale id in the rail can never render someone
   * else's transcript.
   */
  agent: (id: string, conversationId?: string) =>
    req<AgentDetail>(
      `/agents/${encodeURIComponent(id)}` +
        (conversationId === undefined
          ? ''
          : `?conversationId=${encodeURIComponent(conversationId)}`),
    ),

  /**
   * Auto-routing: proposes an agent for a free-text request. Never dispatches.
   *
   * The pick is made from STRUCTURE — how many agents there are, which one was
   * used last — so this request carries no body at all: `req()` sends none for
   * `POST /route`, and `_text` is dropped on the floor. It stays in the
   * signature to keep the call site honest about what is being asked about;
   * putting the user's words on the wire for a route that would ignore them
   * buys nothing.
   */
  route: (_text: string) => req<RouteProposal>('/route', { method: 'POST' }),

  /**
   * Start a turn on the SHIPPED chat wire. Returns the conversation the turn
   * landed in (the server mints one when `conversationId` is null) and the
   * `reqId` to stream from.
   */
  async sendMessage({
    agentId,
    conversationId,
    text,
  }: SendMessageInput): Promise<PostMessageResponse> {
    const res = await fetch('/api/chat/messages', {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify({
        conversationId,
        agentId,
        contentBlocks: [{ type: 'text', text }],
      }),
    });
    if (!res.ok) {
      throw new Error(`send message → ${res.status}`);
    }
    const body = (await res.json()) as PostMessageResponse;
    if (!body.reqId || !body.conversationId) {
      throw new Error('send message returned a reply we could not read');
    }
    return body;
  },

  streamReply,
};

/**
 * Read one turn's SSE stream and hand the caller plain text.
 *
 * WHY A SECOND READER EXISTS. `lib/transport.ts` already parses this exact
 * wire, but every path through it emits AI-SDK `UIMessageChunk`s into a
 * `ReadableStream` controller, and the parser itself (`consumeSseAttempt`) is
 * module-private and inseparable from that emission. There is nothing to reuse
 * without either exporting a chunk-shaped API the workspace cannot consume, or
 * pulling the whole assistant-ui runtime into a surface that deliberately does
 * not mount it. So this is a small, deliberately dumb reader over the same
 * frames: text chunks, a `done` terminator, an `error` terminator, and it
 * ignores every other frame kind (thinking, tool-use, tool-result, phase,
 * permissionRequest) because this surface renders none of them yet.
 *
 * Frame shapes: `src/server/types.ts` (`SseFrame`).
 */
async function streamReply(
  reqId: string,
  { onText, onDone, onError, signal }: StreamHandlers,
): Promise<void> {
  let res: Response;
  try {
    const init: RequestInit = {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      credentials: 'include',
    };
    if (signal) init.signal = signal;
    res = await fetch(`/api/chat/stream/${encodeURIComponent(reqId)}`, init);
  } catch (e) {
    if (signal?.aborted) return;
    onError(e instanceof Error ? e.message : WORKSPACE_STREAM_LOST);
    return;
  }
  if (!res.ok || !res.body) {
    onError(`the reply stream would not open (${res.status})`);
    return;
  }

  const reader = res.body
    .pipeThrough(
      new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>,
    )
    .getReader();
  let carry = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        // No terminator arrived — the stream dropped. Never silently finish.
        onError(WORKSPACE_STREAM_LOST);
        return;
      }
      const lines = (carry + value).split('\n');
      carry = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
        } catch {
          continue; // Malformed line — the server is the source of truth.
        }
        if (frame.done === true) {
          onDone();
          return;
        }
        if (typeof frame.error === 'string') {
          const detail =
            typeof frame.detail === 'string' ? ` ${frame.detail}` : '';
          onError(`${frame.error}${detail}`.trim());
          return;
        }
        if (frame.kind === 'text' && typeof frame.text === 'string') {
          onText(frame.text);
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    onError(e instanceof Error ? e.message : WORKSPACE_STREAM_LOST);
  } finally {
    reader.releaseLock();
  }
}
