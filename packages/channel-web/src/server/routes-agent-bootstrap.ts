import {
  PluginError,
  isModelRef,
  isRejection,
  makeAgentContext,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { z } from 'zod';
import type { RouteRequest, RouteResponse } from './routes-chat.js';

const PLUGIN_NAME = '@ax/channel-web';

/** Legacy fallback for presets without the model-policy plugin. */
const DEFAULT_PERSONAL_AGENT_MODEL = 'anthropic/claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// POST /api/agents/bootstrap — first-run personal-agent bootstrap (TASK-140,
// conversational-agent-identity Phase 2; TASK-989).
//
// The SPA first-run POSTs ONLY a `displayName` here (no form, no system
// prompt). The handler creates a BARE agent with `agents:create` and asks for
// it to start in first-run setup: `bootstrap: 'pending'`, which @ax/agents
// records in the same transaction as the agent row. While an agent is pending
// and a person is present, the host runs its sessions in bootstrap mode — the
// runner composes the bootstrap script, and the agent discovers its identity
// through conversation, saves it with `update_identity` and finishes with
// `complete_bootstrap`. This route is the ONLY caller that starts one: the
// onboarding Default Agent and admin-created agents are `none`. Nothing is
// written to the agent's workspace: this route used to seed a bootstrap file
// there, best-effort, and a silent failure of that seed left a new agent in
// normal mode.
//
// The handler FIXES the capability profile server-side — wildcard tool scope
// (allowedTools=[] AND mcpConfigIds=[]), `personal` visibility, owner = caller,
// the default model, and the first-run state — so a client cannot over-grant
// by spoofing tools/visibility/model/bootstrap. This is the same capability
// profile onboarding gives the "Default Agent" (completion-tx.ts). We can't
// reuse POST /admin/agents because that route deliberately rejects the
// wildcard (admin-routes.ts); the service hook `agents:create` allows it.
//
// Boundary review: no new service-hook signature — an HTTP route calling the
// EXISTING `agents:create`, with its top-level `bootstrap` field (TASK-989's
// boundary review covers that field).
//
// Security review (see PR body): `displayName` is an untrusted browser string —
// zod-validated (length-bounded) and passed to `agents:create` as DATA (stored,
// never interpolated into a shell command, SQL, or prompt by this route).
// Everything that grants capability (tools/visibility/owner/model) or picks
// the prompt mode (`bootstrap`) is fixed here, never read from the body. CSRF
// is enforced by @ax/http-server's subscriber on state-changing methods; the
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
    // BARE agent: no systemPrompt. Its identity and soul are @ax/agents rows
    // the agent writes itself during first-run setup. `agents:create` has no
    // `systemPrompt` field (removed in TASK-142), so there is nothing to omit.
    allowedTools: string[];
    mcpConfigIds: string[];
    model: string;
    visibility: 'personal' | 'team';
  };
  // TASK-989 — beside `input`, not in it: the first-run state, recorded with
  // the agent in one transaction. Only this route ever sends `pending`.
  bootstrap: 'pending';
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

      let model = DEFAULT_PERSONAL_AGENT_MODEL;
      if (bus.hasService('models:get-policy')) {
        try {
          const policy = await bus.call<Record<string, never>, { allowed: string[]; default: string }>(
            'models:get-policy', makeAgentContext({ sessionId: 'agent-bootstrap-policy', agentId: PLUGIN_NAME, userId: actor.id }), {},
          );
          if (isModelRef(policy.default) && policy.allowed.includes(policy.default)) model = policy.default;
        } catch {
          initCtx.logger.warn('agent_bootstrap_policy_unavailable', { plugin: PLUGIN_NAME });
        }
      }

      // 3) Create a BARE agent — no systemPrompt; wildcard tool scope, personal
      //    visibility, owner = caller — in first-run setup. Identical
      //    capability profile to the onboarding Default Agent (minus the
      //    prompt). The admin HTTP route rejects the wildcard; the service
      //    hook allows it.
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
              model,
              visibility: 'personal',
            },
            bootstrap: 'pending',
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
