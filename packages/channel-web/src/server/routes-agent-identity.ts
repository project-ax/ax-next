import {
  PluginError,
  isRejection,
  makeAgentContext,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { z } from 'zod';
import { readAgentIdentity, writeAgentIdentity } from './identity-write.js';
import type { RouteRequest, RouteResponse } from './routes-chat.js';

const PLUGIN_NAME = '@ax/channel-web';

// ---------------------------------------------------------------------------
// GET/PUT /admin/agents/:id/identity — the admin form's identity editor
// (TASK-142; moved onto @ax/agents by TASK-989).
//
// An agent's identity (who it is) and soul (its values and boundaries) are
// rows owned by `@ax/agents`. These routes are the BFF for the admin form's
// two fields:
//
//   GET  → `agents:identity:get` → `{ identity, soul }`. A read that fails, or
//          a deployment with no identity store, answers 503 — never two blank
//          fields, which a Save would write back over the real text.
//   PUT  → `agents:identity:set` with exactly `{ identity, soul }`, through
//          `identity-write.ts` (read the revision, write with it, retry a lost
//          compare-and-set). The Instructions are NOT this editor's: people
//          edit them on the agent's settings page, and an old client's
//          `operating` field is dropped.
//
// Boundary review: no new service-hook signature — HTTP routes over the
// `agents:identity:*` hooks (TASK-989's boundary review covers those).
//
// Security review (see PR body):
//   - The two bodies are UNTRUSTED browser strings. Each is capped at 32,768
//     characters here; `agents:identity:set` then runs every non-empty
//     section through `identity:scan` (prompt-injection, credential-exfiltration
//     and hidden-character checks, fail closed) before anything is saved. The
//     text reaches only the agent's own system prompt at its next spawn — never
//     a shell, SQL, path or HTML from this route. A refusal answers 400 with
//     the scanner's fixed reason; the text itself is never logged.
//   - ACL: the userId is server-forced from the auth cookie; `agents:resolve`
//     gates the agent (owner / team member → 403 otherwise), team agents are
//     refused below, and the identity hooks check access again on the ctx,
//     which carries the agent and the ACTING person — never a synthetic actor.
//     CSRF is enforced by @ax/http-server on PUT.
// ---------------------------------------------------------------------------

// Per-field cap, in characters (JS string length) — the legacy admin
// systemPrompt cap. A real identity is a few thousand; this bounds a runaway or
// hostile paste well under `identity:scan`'s 262,144-byte limit.
const MAX_FIELD_CHARS = 32 * 1024;

// Locally-declared hook payload shapes (Invariant #2 — the hook bus is the
// contract; each side names only the shape it needs).
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
interface AgentsResolveOutput {
  agent: { id: string; ownerType: 'user' | 'team' };
}

// PUT body: the editor's two fields, each length-bounded. Unknown fields
// (an old client's `operating`) are stripped.
const IdentityBody = z
  .object({
    identity: z.string().max(MAX_FIELD_CHARS, 'identity too large'),
    soul: z.string().max(MAX_FIELD_CHARS, 'soul too large'),
  })
  .strip();

/** An error's name and code — never its message, which may quote text. */
function errorFields(err: unknown): { name: string; code?: string } {
  const name = err instanceof Error ? err.name : typeof err;
  return err instanceof PluginError ? { name, code: err.code } : { name };
}

export interface AgentIdentityRoutesDeps {
  bus: HookBus;
  initCtx: AgentContext;
}

export function makeAgentIdentityHandlers(deps: AgentIdentityRoutesDeps) {
  const { bus, initCtx } = deps;

  /** Authenticate, then ACL-gate the agent via `agents:resolve` under the
   * authenticated user. Returns the agent and the acting user, or null (a
   * response was already written). */
  async function authorizeAgent(
    req: RouteRequest,
    res: RouteResponse,
    agentId: string | undefined,
  ): Promise<{ agentId: string; userId: string } | null> {
    if (agentId === undefined || agentId.length === 0) {
      res.status(400).json({ error: 'invalid-payload' });
      return null;
    }
    // 1) Auth — server-forced userId from the cookie.
    let userId: string;
    try {
      const out = await bus.call<AuthRequireUserInput, AuthRequireUserOutput>(
        'auth:require-user',
        initCtx,
        { req },
      );
      userId = out.user.id;
    } catch (err) {
      if (err instanceof PluginError || isRejection(err)) {
        res.status(401).json({ error: 'unauthenticated' });
        return null;
      }
      throw err;
    }
    // 2) ACL — agents:resolve(agentId, userId) succeeds only for the owner /
    //    team-member. A 'forbidden' (or any resolve failure) → 403/404 with no
    //    oracle distinguishing "no agent" from "not yours".
    try {
      const out = await bus.call<AgentsResolveInput, AgentsResolveOutput>(
        'agents:resolve',
        initCtx,
        { agentId, userId },
      );
      // Team agents are refused. A decision, not a technical limit
      // (TASK-465, 2026-09-28; kept by TASK-989): a shared agent's name and
      // persona are how every member recognises it, so changing them should
      // take a team owner or admin (or an explicit grant), NOT any member —
      // and agents:resolve answers only "is a member", with no role. Revisit
      // when a team ROLE model exists; then allow owners/admins and pass the
      // ACTING member as the ctx's userId, never the team id
      // (`agent.ownerId` is a teamId on a team agent). `returns 403 for a
      // team agent` in routes-agent-identity.test.ts pins this for GET and
      // PUT. See TASK-414, TASK-465.
      if (out.agent.ownerType !== 'user') {
        res.status(403).json({ error: 'forbidden' });
        return null;
      }
      return { agentId, userId };
    } catch (err) {
      if (err instanceof PluginError && err.code === 'forbidden') {
        res.status(403).json({ error: 'forbidden' });
        return null;
      }
      if (err instanceof PluginError && err.code === 'not-found') {
        res.status(404).json({ error: 'not-found' });
        return null;
      }
      if (isRejection(err)) {
        res.status(403).json({ error: 'forbidden' });
        return null;
      }
      throw err;
    }
  }

  /** The ctx the identity hooks authorize on: THIS agent, and the person
   * acting — who `agents:resolve` just admitted (on a personal agent, its
   * owner). Never `initCtx`, whose agent and user are channel-web's own. */
  function editorCtx(agentId: string, userId: string): AgentContext {
    return makeAgentContext({ sessionId: 'agent-identity-editor', agentId, userId });
  }

  return {
    /** GET /admin/agents/:id/identity */
    async show(req: RouteRequest, res: RouteResponse): Promise<void> {
      const auth = await authorizeAgent(req, res, req.params.id);
      if (auth === null) return;
      let view: Awaited<ReturnType<typeof readAgentIdentity>>;
      try {
        view = await readAgentIdentity(bus, editorCtx(auth.agentId, auth.userId), auth.agentId);
      } catch (err) {
        initCtx.logger.warn('agent_identity_read_failed', {
          plugin: PLUGIN_NAME,
          agentId: auth.agentId,
          ...errorFields(err),
        });
        view = 'unavailable';
      }
      if (view === 'unavailable') {
        res.status(503).json({ error: 'identity-unavailable' });
        return;
      }
      res.status(200).json({ identity: view.identity, soul: view.soul });
    },

    /** PUT /admin/agents/:id/identity */
    async save(req: RouteRequest, res: RouteResponse): Promise<void> {
      const auth = await authorizeAgent(req, res, req.params.id);
      if (auth === null) return;

      // Parse + validate (length-bounded). Unknown fields stripped.
      let body: { identity: string; soul: string };
      try {
        const raw =
          req.body.length === 0 ? {} : (JSON.parse(req.body.toString('utf8')) as unknown);
        const parsed = IdentityBody.safeParse(raw);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid-payload' });
          return;
        }
        body = parsed.data;
      } catch {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }

      let result: Awaited<ReturnType<typeof writeAgentIdentity>>;
      try {
        result = await writeAgentIdentity(bus, editorCtx(auth.agentId, auth.userId), auth.agentId, {
          identity: body.identity,
          soul: body.soul,
        });
      } catch (err) {
        initCtx.logger.warn('agent_identity_save_failed', {
          plugin: PLUGIN_NAME,
          agentId: auth.agentId,
          ...errorFields(err),
        });
        res.status(500).json({ error: 'save-failed' });
        return;
      }

      switch (result.kind) {
        case 'saved':
          res.status(200).json({ ok: true });
          return;
        case 'conflict':
          // Lost the compare-and-set three times running: nothing was saved.
          res.status(409).json({ error: 'conflict' });
          return;
        case 'unavailable':
          res.status(503).json({ error: 'identity-unavailable' });
          return;
        case 'refused':
          if (result.code === 'scan-unavailable') {
            // The safety check could not run, so nothing was saved (fail
            // closed). Not the person's text to fix.
            res.status(503).json({ error: 'identity-unavailable' });
            return;
          }
          if (result.code === 'content') {
            // The scanner's reason is a fixed, short sentence of its own —
            // never the text it refused.
            res.status(400).json({
              error: `That didn’t pass the safety check, so nothing was saved: ${result.reason}`,
            });
            return;
          }
          // `too-long` caps the Instructions, which this editor never sends;
          // the store's own sentence says what to fix.
          res.status(400).json({ error: result.reason });
          return;
      }
    },
  };
}
