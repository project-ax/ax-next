/**
 * POST /api/chat/allow-host — the reactive egress wall's grant route (TASK-37).
 *
 * The workspace's grant row (`GrantRow`, "Allow access to <host>?") POSTs
 * `{ sessionId, host, persist?, agentId? }` here when the person grants. This
 * route is one of two callers of the host-internal `proxy:add-host` service
 * hook, and each proves a person's own action:
 *  - this route: an authenticated, CSRF-gated request from the owner's
 *    browser;
 *  - channel-slack's permission-prompts.ts: a Slack-signed click on a host
 *    prompt by the prompt's asker (re-proved by its click gate), called as
 *    the prompt's AX user for exactly the prompt's live { sessionId, host }.
 * The untrusted runner can never reach `proxy:add-host` (it's not an IPC
 * action; fork #1), so widening a session's live egress allowlist always
 * takes a person's action, and the proxy re-checks ownership either way.
 *
 * "Always for this agent" (`persist`; TASK-44, TASK-1212) also KEEPS the site
 * on the agent (`host-grants:grant`), so the agent's later sessions load it.
 * Which agent it is kept on:
 *  - The session is live (`added: true`): the one the proxy's own
 *    SessionConfig names. The body's `agentId` is ignored.
 *  - The session has ended (`added: false`): the body's `agentId`.
 * Either way the site is kept only once `agents:resolve` admits the
 * AUTHENTICATED person to that agent NOW, AND its answer says the agent is a
 * team agent or a personal agent the person OWNS (TASK-1246). A live session
 * can outlive its owner's access (removed from the team mid-session), and the
 * ended case's id is the browser's word. A refusal (forbidden / not-found), a
 * missing id and a fault all answer the same `kept: false`, so the answer says
 * nothing about which agents exist. On a team agent the reach equals a live
 * Allow's: anyone who may use the agent could open a session and Allow any
 * host there.
 *
 * Since sharing (TASK-1246), agents:resolve also admits the people a personal
 * agent is shared with. Their "Always" widens their own live session only and
 * answers `kept: false`: a site kept on a personal agent widens every run of
 * it, the owner's included, and that is the owner's call (the same rule as
 * Settings › Sites). The same gate stops an ended-session "Always" whose body
 * names a personal agent the person doesn't own. Phase 1A on purpose; card C
 * applies the design's shared-agent website rule.
 * The answer is `{ added }` for "Just this once" and `{ added, kept }` for
 * "Always", plus `full: true` when the agent's list of allowed sites is at its
 * cap. The keep is best-effort: it never turns the answer into a 500, and its
 * log line carries only the error code — never the host (model-chosen text),
 * a session, a person or an agent.
 *
 * Security posture:
 *  - Auth: `auth:require-user` → 401 when unauthenticated (any other failure
 *    is a logged 500). The per-request ctx is built
 *    from the AUTHENTICATED user id, never the browser-supplied sessionId.
 *  - CSRF: the http-server's subscriber requires `X-Requested-With: ax-admin`
 *    on state-changing methods (the same gate as POST /api/chat/messages); the
 *    client `grantHost()` sends it.
 *  - Ownership: the browser supplies `sessionId` only so the proxy knows WHICH
 *    session to widen; the proxy re-validates `SessionConfig.userId ===
 *    ctx.userId`, so a forged/guessed sessionId for another user's session is
 *    rejected (`forbidden` → 403) and nothing is kept. The proxy also
 *    re-validates `host` (defense-in-depth, I2; `invalid-host` → 400), and
 *    `@ax/host-grants` validates it again before keeping it.
 *
 * I2 — no `@ax/credential-proxy` / `@ax/http-server` import; the RouteRequest/
 * RouteResponse shapes are reused from routes-chat.ts (the same duck-typed
 * subset), and the proxy hook is a duck-typed bus call.
 */
import {
  answerRequireUserFailure,
  makeAgentContext,
  makeReqId,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { z } from 'zod';
import { ownsPersonalAgent } from './agent-ownership.js';
import type { RouteRequest, RouteResponse } from './routes-chat.js';

const BodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  host: z.string().min(1).max(253),
  // "Always for this agent" → keep the site on the agent as well as widening
  // the live session. Default false = TASK-37 "just this once".
  persist: z.boolean().optional().default(false),
  // The agent the card was raised for (TASK-1212). Read only for an "Always"
  // whose session has ended, and only once agents:resolve admits the person.
  agentId: z.string().min(1).max(128).optional(),
});

interface AuthRequireUserInput {
  req: RouteRequest;
}
interface AuthRequireUserOutput {
  user: { id: string; isAdmin: boolean };
}

interface AddHostInput {
  sessionId: string;
  host: string;
}
interface AddHostOutput {
  added: boolean;
  /** The session's agentId — present iff added (and the session has an agent).
   * The server-authoritative half of a live keep's key (TASK-44). Derived by
   * the proxy from its own SessionConfig, never supplied by the browser. */
  agentId?: string;
}

interface AgentsResolveInput {
  agentId: string;
  userId: string;
}

interface HostGrantsGrantInput {
  ownerUserId: string;
  agentId: string;
  host: string;
}

/** What an "Always" answer says about the keep. */
type KeepAnswer = { kept: true } | { kept: false; full?: true };

interface Deps {
  bus: HookBus;
  initCtx: AgentContext;
}

export function makeAllowHostHandler(deps: Deps) {
  return async function handle(req: RouteRequest, res: RouteResponse): Promise<void> {
    // 1) Auth — host-side identity. Never trust the browser's sessionId for
    //    authorization; the proxy re-checks ownership below.
    let userId: string;
    try {
      const r = await deps.bus.call<AuthRequireUserInput, AuthRequireUserOutput>(
        'auth:require-user',
        deps.initCtx,
        { req },
      );
      userId = r.user.id;
    } catch (err) {
      // Only 'unauthenticated' is a 401; any other failure is a logged 500.
      answerRequireUserFailure(deps.initCtx, res, err, 'host_grant_require_user_failed');
      return;
    }

    // 2) Parse + validate the body. The http-server already capped the body
    //    size before we ran; here we only contend with malformed/invalid JSON.
    let body: z.infer<typeof BodySchema>;
    try {
      const raw = req.body.length === 0 ? {} : (JSON.parse(req.body.toString('utf-8')) as unknown);
      const parsed = BodySchema.safeParse(raw);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid-body' });
        return;
      }
      body = parsed.data;
    } catch {
      res.status(400).json({ error: 'invalid-body' });
      return;
    }

    // 3) Per-request ctx carries the AUTHENTICATED identity. The proxy
    //    re-validates ownership against SessionConfig.userId — a forged
    //    sessionId can't widen someone else's session.
    const ctx = makeAgentContext({
      sessionId: body.sessionId,
      agentId: '',
      userId,
      reqId: makeReqId(),
    });
    let out: AddHostOutput;
    try {
      out = await deps.bus.call<AddHostInput, AddHostOutput>('proxy:add-host', ctx, {
        sessionId: body.sessionId,
        host: body.host,
      });
    } catch (err) {
      // A refused widen keeps nothing either: the keep below never runs.
      if (err instanceof PluginError && err.code === 'forbidden') {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (err instanceof PluginError && err.code === 'invalid-host') {
        res.status(400).json({ error: 'invalid-host' });
        return;
      }
      throw err;
    }

    // 4) "Just this once": the live widen is the whole answer (TASK-37).
    //    agentId never reaches the browser (fork #2).
    if (!body.persist) {
      res.status(200).json({ added: out.added });
      return;
    }
    const keep = await keepSite(deps, ctx, {
      userId,
      host: body.host,
      live: out,
      bodyAgentId: body.agentId,
    });
    res.status(200).json({ added: out.added, ...keep });
  };
}

/**
 * "Always for this agent": keep the site on the agent, keyed by who added it
 * (`ownerUserId`, from auth) and the agent.
 *
 * NEVER THROWS. When the session was live, the widen has already happened and
 * the site works for this session whatever happens here; when it had ended,
 * nothing happened at all. Either way a failed keep is said in the answer
 * (`kept: false`) rather than turned into a 500, and a person who re-hits the
 * wall later gets asked again — it can never widen egress by failing.
 */
async function keepSite(
  deps: Deps,
  ctx: AgentContext,
  args: { userId: string; host: string; live: AddHostOutput; bodyAgentId: string | undefined },
): Promise<KeepAnswer> {
  // A preset without @ax/host-grants keeps nothing; the live widen is all there is.
  if (!deps.bus.hasService('host-grants:grant')) return { kept: false };
  try {
    // Which agent: while the session is live, the one the proxy's own
    // SessionConfig names (the body's id is ignored); once it has ended, only
    // the browser can say. A live session with no agent (an owner-less one),
    // or an ended one with no id, has nowhere to keep it.
    const agentId = args.live.added ? args.live.agentId : args.bodyAgentId;
    if (agentId === undefined) return { kept: false };
    // Either way, kept only on an agent the person may use NOW: agents:resolve
    // admits the authenticated person or throws, and the catch below answers
    // the same `kept: false` for a refusal and a fault alike. A live session
    // can outlive its owner's access; the ended case's id is the browser's word.
    const resolved = await deps.bus.call<AgentsResolveInput, unknown>(
      'agents:resolve',
      deps.initCtx,
      { agentId, userId: args.userId },
    );
    // …and only on a team agent or a personal agent the person OWNS
    // (TASK-1246). Someone a personal agent is only shared with keeps the
    // widen to their live session: the agent's sites are its owners' to change.
    // An answer that doesn't say which (no agent, no visibility, no explicit
    // isOwner, or an agent that isn't the one being kept) keeps nothing —
    // never assumed. Said in the log by code only: never the host, never a name.
    const verdict = keepVerdict(resolved, agentId);
    if (verdict !== 'ok') {
      deps.initCtx.logger.warn('host_grant_persist_failed', { code: verdict });
      return { kept: false };
    }
    // `created: false` means the agent already had it — kept either way. The
    // store re-validates the host and enforces the per-agent cap.
    await deps.bus.call<HostGrantsGrantInput, { created: boolean }>('host-grants:grant', ctx, {
      ownerUserId: args.userId,
      agentId,
      host: args.host,
    });
    return { kept: true };
  } catch (err) {
    const code = err instanceof PluginError ? err.code : 'unknown';
    deps.initCtx.logger.warn('host_grant_persist_failed', { code });
    return code === 'grant-limit' ? { kept: false, full: true } : { kept: false };
  }
}

/**
 * May the person keep a site on `agentId`, going by this `agents:resolve`
 * answer? A team agent: yes (agents:resolve already admitted them). A personal
 * agent: only one of its owners ({@link ownsPersonalAgent}). Read structurally:
 * the answer crossed the bus (I2), so its shape is checked, not trusted.
 *
 * - `'ok'`: keep it.
 * - `'not-owner'`: a well-formed personal agent the person doesn't own (one
 *   shared with them): the refusal this guard exists for.
 * - `'bad-response'`: anything else, including an answer that names a
 *   different agent than the one being kept (defence in depth: the grant
 *   goes to `agentId`, so the answer must be about it).
 */
function keepVerdict(resolved: unknown, agentId: string): 'ok' | 'not-owner' | 'bad-response' {
  if (typeof resolved !== 'object' || resolved === null) return 'bad-response';
  const agent = (resolved as { agent?: unknown }).agent;
  if (typeof agent !== 'object' || agent === null) return 'bad-response';
  const fields = agent as { id?: unknown; visibility?: unknown; isOwner?: unknown };
  if (fields.id !== agentId) return 'bad-response';
  if (fields.visibility === 'team') return 'ok';
  if (fields.visibility !== 'personal') return 'bad-response';
  // Only an explicit boolean says which; anything else is a malformed answer.
  if (typeof fields.isOwner !== 'boolean') return 'bad-response';
  return ownsPersonalAgent(fields) ? 'ok' : 'not-owner';
}
