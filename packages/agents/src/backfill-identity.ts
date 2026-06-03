import {
  makeAgentContext,
  makeReqId,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { backfillIdentityFile } from '@ax/agent-identity-templates';

const PLUGIN_NAME = '@ax/agents';

/**
 * The minimal agent shape the backfill consumes — a structural subset of the
 * store's `Agent`. Declared locally so the routine is trivially unit-testable
 * against a fake store without dragging the full row type + its JSONB columns
 * into the test.
 */
export interface BackfillAgent {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  displayName: string;
  systemPrompt: string;
}

export interface BackfillStore {
  listAll(): Promise<BackfillAgent[]>;
}

export interface IdentityBackfillDeps {
  bus: HookBus;
  store: BackfillStore;
  /** The plugin's init ctx — used ONLY for logging (never to route a workspace
   * call; each agent gets its own owner-routed ctx below). */
  initCtx: AgentContext;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

interface WorkspaceReadResult {
  found: boolean;
}

/** Extract the storage tier's actual head from a `parent-mismatch` PluginError's
 * `cause.actualParent` (the established workspace CAS contract — see
 * git-engine's `parentMismatch`). Returns the value (a `WorkspaceVersion`
 * string or null) when the error is a parent-mismatch carrying it, or the
 * sentinel `NO_ACTUAL_PARENT` otherwise so the caller knows NOT to retry. */
const NO_ACTUAL_PARENT = Symbol('no-actual-parent');
function actualParentFromMismatch(err: unknown): string | null | typeof NO_ACTUAL_PARENT {
  if (!(err instanceof PluginError) || err.code !== 'parent-mismatch') {
    return NO_ACTUAL_PARENT;
  }
  const cause = err.cause as { actualParent?: string | null } | undefined;
  if (cause === undefined || !('actualParent' in cause)) return NO_ACTUAL_PARENT;
  return cause.actualParent ?? null;
}

/**
 * One-shot, idempotent migration: give every EXISTING personal agent the two
 * `.ax/` identity files the file-reading runner (Phase 1) now expects, so that
 * the moment the file-reading runner is the live path, every existing agent
 * reads from files and the string fallback only covers the brief in-flight
 * window.
 *
 *   `.ax/IDENTITY.md` = `You are <displayName>, a helpful personal assistant.`
 *   `.ax/SOUL.md`     = the agent's legacy `system_prompt`, VERBATIM
 *
 * Design open-question #4 (the safe default): no attempt to split identity from
 * personality — the whole legacy blob is the soul; the IDENTITY line just
 * finally names the agent, closing the "says Claude" gap. No `AGENTS.md`. The
 * DB `system_prompt` column is NOT dropped here (that's Phase 4).
 *
 * Idempotent: an agent that already has `.ax/IDENTITY.md` is skipped (a re-run,
 * or an agent that bootstrapped itself, costs only a read). Team agents are
 * skipped — a team workspace has no single personal-owner ctx to route the
 * apply under, and routing a default identity under a team is a policy
 * question, not a migration (mirrors `agents:list-personal-owners`).
 *
 * Existing-history agents: a USED agent already has a non-empty `/permanent`
 * (chat transcripts, attachments), so the first apply with `parent: null` is a
 * CAS miss (`parent-mismatch`). We retry ONCE with the storage tier's actual
 * head from `cause.actualParent` — exactly the established workspace-CAS rebase
 * contract — so the migration reaches the very agents that have been used (not
 * just freshly-created empty ones). A single retry (no loop) bounds the cost; a
 * second failure is logged + skipped.
 *
 * Best-effort per agent: an apply/read failure is logged and the loop
 * continues — the migration must never block boot. No-op when no workspace
 * backend is registered (a preset that strips workspace) — those agents get
 * their identity later via the runner string fallback.
 */
export async function runIdentityBackfill(deps: IdentityBackfillDeps): Promise<void> {
  const { bus, store, initCtx } = deps;

  // No workspace backend → nothing to write to. The runner string-fallback
  // path keeps these agents working; the file path simply never engages.
  if (!bus.hasService('workspace:apply') || !bus.hasService('workspace:read')) {
    return;
  }

  const agents = await store.listAll();
  for (const agent of agents) {
    // Team agents: no personal-owner ctx to route the per-agent apply under.
    if (agent.ownerType !== 'user') continue;

    // Route reads + writes to THIS agent's workspace: ctx carries
    // (userId, agentId). userId is the agent's REAL owner — never a synthetic
    // actor (a synthetic owner would hide auth regressions; see
    // feedback_no_synthetic_actors_through_agents_resolve).
    const ctx = makeAgentContext({
      reqId: makeReqId(),
      sessionId: 'identity-backfill',
      agentId: agent.id,
      userId: agent.ownerId,
    });

    try {
      const existing = await bus.call<{ path: string }, WorkspaceReadResult>(
        'workspace:read',
        ctx,
        { path: '.ax/IDENTITY.md' },
      );
      // Already has identity files (a re-run, or a self-bootstrapped agent) →
      // idempotent skip. We never overwrite an agent's own identity.
      if (existing.found) continue;

      const changes = [
        {
          path: '.ax/IDENTITY.md',
          kind: 'put' as const,
          content: enc(backfillIdentityFile(agent.displayName)),
        },
        { path: '.ax/SOUL.md', kind: 'put' as const, content: enc(agent.systemPrompt) },
      ];
      // First attempt with parent:null — correct for a never-used agent (the
      // git backend lazy-creates `main`). For a USED agent whose `/permanent`
      // already has history, this is a CAS miss; retry ONCE with the actual
      // head (the established parent-mismatch rebase contract).
      try {
        await bus.call('workspace:apply', ctx, {
          changes,
          parent: null,
          reason: 'identity-backfill',
        });
      } catch (applyErr) {
        const actual = actualParentFromMismatch(applyErr);
        if (actual === NO_ACTUAL_PARENT) throw applyErr; // not a parent-mismatch → real failure
        await bus.call('workspace:apply', ctx, {
          changes,
          parent: actual,
          reason: 'identity-backfill',
        });
      }
    } catch (err) {
      initCtx.logger.warn('agents_identity_backfill_failed', {
        plugin: PLUGIN_NAME,
        agentId: agent.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
