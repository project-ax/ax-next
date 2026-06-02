import { PluginError, isRejection, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import type { RouteRequest, RouteResponse } from './routes-chat.js';

const PLUGIN_NAME = '@ax/channel-web';

/** Hidden default — see plan decision #2. No persisted "default model" setting exists. */
const DEFAULT_PERSONAL_AGENT_MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// POST /api/agents/bootstrap — first-run personal-agent bootstrap.
//
// The SPA's <AgentBootstrap> walk (name → soul → purpose) POSTs the two
// user-authored fields here. The handler FIXES the capability profile
// server-side — wildcard tool scope (allowedTools=[] AND mcpConfigIds=[]),
// `personal` visibility, owner = caller, and the default model — so a
// client cannot over-grant by spoofing tools/visibility/model. This is the
// same capability profile onboarding gives the "Default Agent"
// (completion-tx.ts). We can't reuse POST /admin/agents because that route
// deliberately rejects the wildcard (admin-routes.ts); the service hook
// `agents:create` allows it.
//
// Boundary review: no new service-hook signature — this is an HTTP route
// calling the EXISTING `agents:create` hook. Only the plugin manifest's
// `calls` list gains `agents:create` (see plugin.ts).
//
// Security review (see PR body): displayName + systemPrompt are untrusted
// browser strings. They are zod-validated (length-bounded) and passed to
// `agents:create` as DATA (stored, never interpolated into a shell command,
// SQL, or prompt by this route). Everything that grants capability
// (tools/visibility/owner/model) is fixed here, not read from the body.
// CSRF is enforced by @ax/http-server's subscriber on state-changing
// methods; the handler does not re-implement it.
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
    systemPrompt: string;
    allowedTools: string[];
    mcpConfigIds: string[];
    model: string;
    visibility: 'personal' | 'team';
  };
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
// whitespace) and the store's 32 KiB systemPrompt cap. We only accept the
// two user-authored fields; everything else is fixed server-side.
const BootstrapBody = z.object({
  displayName: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, 'displayName 1-128').max(128, 'displayName 1-128')),
  systemPrompt: z.string().max(32 * 1024, 'systemPrompt too large').default(''),
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

      // 2) Parse + validate. Only displayName + systemPrompt are honored.
      let parsed: { displayName: string; systemPrompt: string };
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

      // 3) Create — wildcard tool scope, personal visibility, owner = caller.
      //    Identical capability profile to the onboarding Default Agent. The
      //    admin HTTP route rejects the wildcard; the service hook allows it.
      try {
        const out = await bus.call<AgentsCreateInput, AgentsCreateOutput>(
          'agents:create',
          initCtx,
          {
            actor: { userId: actor.id, isAdmin: actor.isAdmin },
            input: {
              displayName: parsed.displayName,
              systemPrompt: parsed.systemPrompt,
              allowedTools: [],
              mcpConfigIds: [],
              model: DEFAULT_PERSONAL_AGENT_MODEL,
              visibility: 'personal',
            },
          },
        );
        res.status(201).json({
          agent: {
            agentId: out.agent.id,
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
