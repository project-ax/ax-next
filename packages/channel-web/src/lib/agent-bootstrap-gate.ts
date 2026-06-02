import type { AgentStoreState } from './agent-store';

/**
 * Whether the AgentBootstrap flow should mount (vs. the chat shell).
 *
 * First-run = the agent list loaded `ready` and is empty. We also mount when
 * the user explicitly opened "+ New agent". This is the gate that, when it
 * flips to false mid-create, used to unmount AgentBootstrap before its 'done'
 * screen could paint — the deferred-store-mutation fix lives in AgentBootstrap.
 *
 * Lives in its own module (not App.tsx) so the first-run interaction can be
 * exercised in a test without dragging the whole chat runtime + admin imports
 * in via <AppContent>.
 *
 * 'error' deliberately keeps the gate closed (returns false here unless
 * createAgentOpen) — a transient agent-list blip must not force an existing
 * user into the create flow; "+ New agent" remains available from the menu.
 */
export function shouldShowAgentBootstrap(args: {
  agentsStatus: AgentStoreState['agentsStatus'];
  agentCount: number;
  createAgentOpen: boolean;
}): boolean {
  const noAgents = args.agentsStatus === 'ready' && args.agentCount === 0;
  return args.createAgentOpen || noAgents;
}
