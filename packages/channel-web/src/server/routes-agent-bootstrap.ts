import {
  PluginError,
  isRejection,
  makeAgentContext,
  makeReqId,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { BOOTSTRAP_TEMPLATE } from '@ax/agent-identity-templates';
import { z } from 'zod';
import type { RouteRequest, RouteResponse } from './routes-chat.js';

const PLUGIN_NAME = '@ax/channel-web';

/** Hidden default — see plan decision #2. No persisted "default model" setting exists. */
const DEFAULT_PERSONAL_AGENT_MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// POST /api/agents/bootstrap — first-run personal-agent bootstrap (TASK-140,
// conversational-agent-identity Phase 2).
//
// The SPA first-run POSTs ONLY a `displayName` here (no form, no system
// prompt). The handler creates a BARE agent (no `systemPrompt`) and then seeds
// the canonical `BOOTSTRAP_TEMPLATE` into the new agent's
// `/agent/.ax/BOOTSTRAP.md` via `workspace:apply`. The new agent wakes up
// in bootstrap mode (the runner injects BOOTSTRAP.md verbatim) and discovers
// its identity through conversation, writing its own `.ax/IDENTITY.md` +
// `.ax/SOUL.md`.
//
// The handler FIXES the capability profile server-side — wildcard tool scope
// (allowedTools=[] AND mcpConfigIds=[]), `personal` visibility, owner = caller,
// and the default model — so a client cannot over-grant by spoofing
// tools/visibility/model. This is the same capability profile onboarding gives
// the "Default Agent" (completion-tx.ts). We can't reuse POST /admin/agents
// because that route deliberately rejects the wildcard (admin-routes.ts); the
// service hook `agents:create` allows it.
//
// Seeding owner (design open-question #1): HOST-AT-CREATE. The first
// `workspace:apply` against a brand-new agent's `/agent` (parent: null)
// lazy-creates `main` (the verified "first apply creates main" git path), so
// no runner-first-session fallback is needed.
//
// Boundary review: no new service-hook signature — this is an HTTP route
// calling the EXISTING `agents:create` + `workspace:apply` hooks. The plugin
// manifest's `calls` list gains `workspace:apply` (see plugin.ts); `agents:create`
// LOSES the required `systemPrompt` field (now optional).
//
// Security review (see PR body): `displayName` is an untrusted browser string —
// zod-validated (length-bounded) and passed to `agents:create` as DATA (stored,
// never interpolated into a shell command, SQL, or prompt by this route). The
// seeded `BOOTSTRAP_TEMPLATE` is a compile-time TRUSTED constant (no
// interpolation of caller input). `workspace:apply` is policy-filtered to
// `.ax/**` by the @ax/core facade. Everything that grants capability
// (tools/visibility/owner/model) is fixed here, not read from the body. CSRF is
// enforced by @ax/http-server's subscriber on state-changing methods; the
// handler does not re-implement it.
// ---------------------------------------------------------------------------

// Locally-declared hook payload shapes (Invariant #2 — no cross-plugin
// imports; the hook bus is the contract, each side names the shape it needs).
interface AuthRequireUserInput {
  req: RouteRequest;
}
interface AuthRequireUserOutput {
  user: { id: string; isAdmin: boolean };
}
interface AgentsCreateInput {
  actor: { userId: string; isAdmin: boolean };
  input: {
    displayName: string;
    // BARE agent: no systemPrompt. Identity comes from the seeded
    // `.ax/BOOTSTRAP.md` (then the agent's own `.ax/IDENTITY.md`/`SOUL.md`),
    // not this column. `agents:create` accepts an absent systemPrompt (→ '').
    allowedTools: string[];
    mcpConfigIds: string[];
    model: string;
    visibility: 'personal' | 'team';
  };
}

// Locally-declared workspace:apply payload (Invariant #2 — the hook bus is the
// contract; this route names only the shape it needs to seed one file).
interface WorkspaceApplyInput {
  changes: Array<{ path: string; kind: 'put'; content: Uint8Array }>;
  parent: null;
  reason?: string;
}
interface AgentsCreateAgent {
  id: string;
  displayName: string;
  visibility: 'personal' | 'team';
}
interface AgentsCreateOutput {
  agent: AgentsCreateAgent;
}

// Mirror the admin route's displayName contract (1-128, no surrounding
// whitespace). We accept ONLY `displayName`; everything else is fixed
// server-side (and a bare agent carries no system prompt at all). Unknown body
// fields (a client-spoofed systemPrompt/tools/model) are ignored by zod, never
// forwarded.
const BootstrapBody = z.object({
  displayName: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, 'displayName 1-128').max(128, 'displayName 1-128')),
});

export interface AgentBootstrapDeps {
  bus: HookBus;
  initCtx: AgentContext;
}

export function makeAgentBootstrapHandler(deps: AgentBootstrapDeps) {
  const { bus, initCtx } = deps;
  return {
    /** POST /api/agents/bootstrap */
    async bootstrap(req: RouteRequest, res: RouteResponse): Promise<void> {
      // 1) Auth.
      let actor: { id: string; isAdmin: boolean };
      try {
        const result = await bus.call<AuthRequireUserInput, AuthRequireUserOutput>(
          'auth:require-user',
          initCtx,
          { req },
        );
        actor = { id: result.user.id, isAdmin: result.user.isAdmin };
      } catch (err) {
        if (err instanceof PluginError || isRejection(err)) {
          res.status(401).json({ error: 'unauthenticated' });
          return;
        }
        throw err;
      }

      // 2) Parse + validate. Only displayName is honored (a bare agent carries
      //    no system prompt; any other body field is ignored by zod).
      let parsed: { displayName: string };
      try {
        const raw = req.body.length === 0 ? {} : (JSON.parse(req.body.toString('utf8')) as unknown);
        const r = BootstrapBody.safeParse(raw);
        if (!r.success) {
          res.status(400).json({ error: 'invalid-payload' });
          return;
        }
        parsed = r.data;
      } catch {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }

      // 3) Create a BARE agent — no systemPrompt; wildcard tool scope, personal
      //    visibility, owner = caller. Identical capability profile to the
      //    onboarding Default Agent (minus the prompt). The admin HTTP route
      //    rejects the wildcard; the service hook allows it.
      try {
        const out = await bus.call<AgentsCreateInput, AgentsCreateOutput>(
          'agents:create',
          initCtx,
          {
            actor: { userId: actor.id, isAdmin: actor.isAdmin },
            input: {
              displayName: parsed.displayName,
              allowedTools: [],
              mcpConfigIds: [],
              model: DEFAULT_PERSONAL_AGENT_MODEL,
              visibility: 'personal',
            },
          },
        );

        // 4) Seed `.ax/BOOTSTRAP.md` into the NEW agent's durable workspace.
        //    The ctx carries (userId, agentId) so `workspace:apply` routes to
        //    THIS agent's `/agent`; `parent: null` is the first apply,
        //    which lazy-creates `main` (the verified "first apply creates main"
        //    git path). BEST-EFFORT: the agent already exists and the SPA will
        //    open a chat regardless — a seed failure is logged, never a 500
        //    (the runner string-fallback covers the gap until a later apply
        //    lands). The template is a trusted compile-time constant.
        const newAgentId = out.agent.id;
        try {
          const seedCtx = makeAgentContext({
            reqId: makeReqId(),
            sessionId: 'agent-bootstrap-seed',
            agentId: newAgentId,
            userId: actor.id,
          });
          await bus.call<WorkspaceApplyInput, unknown>('workspace:apply', seedCtx, {
            changes: [
              {
                path: '.ax/BOOTSTRAP.md',
                kind: 'put',
                content: new TextEncoder().encode(BOOTSTRAP_TEMPLATE),
              },
            ],
            parent: null,
            reason: 'agent-bootstrap-seed',
          });
        } catch (seedErr) {
          initCtx.logger.warn('agent_bootstrap_seed_failed', {
            plugin: PLUGIN_NAME,
            agentId: newAgentId,
            err: seedErr instanceof Error ? { name: seedErr.name, message: seedErr.message } : String(seedErr),
          });
        }

        res.status(201).json({
          agent: {
            agentId: newAgentId,
            displayName: out.agent.displayName,
            visibility: out.agent.visibility,
          },
        });
      } catch (err) {
        if (err instanceof PluginError) {
          // Validation failures from the store surface as 'invalid-payload'.
          if (err.code === 'invalid-payload') {
            res.status(400).json({ error: 'invalid-payload' });
            return;
          }
        }
        initCtx.logger.warn('agent_bootstrap_create_failed', {
          plugin: PLUGIN_NAME,
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        });
        res.status(500).json({ error: 'create-failed' });
      }
    },
  };
}
