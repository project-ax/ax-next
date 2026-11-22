/**
 * The reads the bridge and its settings routes share: who an agent belongs
 * to, which connectors reach it, what they're called, and whether a person
 * may manage them.
 *
 * Hooks only (I2): the agent and connector shapes below are local structural
 * views, as in @ax/mcp-client's connector-call.ts, with no runtime import of
 * @ax/agents or @ax/connectors. Each answer is read field by field; one that
 * can't be read throws (the caller answers `unavailable`), so a malformed
 * answer never grants anything.
 */
import { PluginError, makeAgentContext, type AgentContext, type Logger } from '@ax/core';

/** The one bus method these reads use. A local view: @ax/core exports no `Bus` type. */
export interface BridgeBus {
  call<I, O>(hook: string, ctx: AgentContext, input: I): Promise<O>;
}

export interface AgentView {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  displayName: string;
  connectorAttachments: string[];
  connectorExclusions: string[];
}

/** Every bridge hook call runs as one (person, agent), in the `apps-bridge` session. */
export function bridgeCtx(userId: string, agentId: string, logger: Logger): AgentContext {
  return makeAgentContext({ sessionId: 'apps-bridge', agentId, userId, logger });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** "Not this person's" (or not there): an access miss, not an outage. */
function isAccessMiss(err: unknown): boolean {
  return err instanceof PluginError && (err.code === 'not-found' || err.code === 'forbidden');
}

function unreadable(hook: string): Error {
  return new PluginError({ code: 'invalid-return', plugin: '@ax/apps-bridge', hookName: hook, message: `${hook}: unreadable answer` });
}

/** `agents:resolve`. Not found or not this person's → null; anything else throws. */
export async function resolveAgent(bus: BridgeBus, ctx: AgentContext, agentId: string, userId: string): Promise<AgentView | null> {
  let answer: unknown;
  try {
    answer = await bus.call<{ agentId: string; userId: string }, unknown>('agents:resolve', ctx, { agentId, userId });
  } catch (err) {
    if (isAccessMiss(err)) return null;
    throw err;
  }
  const agent = isRecord(answer) ? answer['agent'] : undefined;
  if (!isRecord(agent)) throw unreadable('agents:resolve');
  const { id, ownerId, ownerType, displayName } = agent;
  if (
    id !== agentId ||
    typeof ownerId !== 'string' ||
    ownerId.length === 0 ||
    (ownerType !== 'user' && ownerType !== 'team') ||
    typeof displayName !== 'string'
  ) {
    throw unreadable('agents:resolve');
  }
  return {
    id,
    ownerId,
    ownerType,
    displayName,
    connectorAttachments: stringList(agent['connectorAttachments']),
    connectorExclusions: stringList(agent['connectorExclusions']),
  };
}

/** `connectors:list-effective` for the agent's own lists: the connectors that reach it. */
export async function effectiveConnectors(
  bus: BridgeBus,
  ctx: AgentContext,
  userId: string,
  agent: AgentView,
): Promise<Array<{ id: string; name: string; toolNamespaces: string[] }>> {
  const answer = await bus.call<{ userId: string; attachmentIds: string[]; exclusions: string[] }, unknown>(
    'connectors:list-effective',
    ctx,
    { userId, attachmentIds: [...agent.connectorAttachments], exclusions: [...agent.connectorExclusions] },
  );
  const list = isRecord(answer) ? answer['connectors'] : undefined;
  if (!Array.isArray(list)) throw unreadable('connectors:list-effective');
  const out: Array<{ id: string; name: string; toolNamespaces: string[] }> = [];
  for (const entry of list) {
    const summary = isRecord(entry) ? entry['summary'] : undefined;
    if (!isRecord(summary) || typeof summary['id'] !== 'string' || typeof summary['name'] !== 'string') continue;
    const namespaces = Array.isArray(entry['toolNamespaces']) ? entry['toolNamespaces'] : [];
    out.push({
      id: summary['id'],
      name: summary['name'],
      toolNamespaces: namespaces
        .map((t: unknown) => (isRecord(t) ? t['toolNamespace'] : undefined))
        .filter((t: unknown): t is string => typeof t === 'string'),
    });
  }
  return out;
}

/** `connectors:list`: connector id → display name, for this person. */
export async function connectorNames(bus: BridgeBus, ctx: AgentContext, userId: string): Promise<Map<string, string>> {
  const answer = await bus.call<{ userId: string }, unknown>('connectors:list', ctx, { userId });
  const list = isRecord(answer) ? answer['connectors'] : undefined;
  if (!Array.isArray(list)) throw unreadable('connectors:list');
  const names = new Map<string, string>();
  for (const c of list) {
    if (isRecord(c) && typeof c['id'] === 'string' && typeof c['name'] === 'string' && !names.has(c['id'])) {
      names.set(c['id'], c['name']);
    }
  }
  return names;
}

/**
 * `agents:can-manage-connectors`, asked as the person and never as an admin:
 * the bridge acts on the person's own rights. Not found or not reachable →
 * false; anything else throws.
 */
export async function canManageAgent(bus: BridgeBus, ctx: AgentContext, agentId: string, userId: string): Promise<boolean> {
  let answer: unknown;
  try {
    answer = await bus.call<{ agentId: string; actor: { userId: string; isAdmin: false } }, unknown>(
      'agents:can-manage-connectors',
      ctx,
      { agentId, actor: { userId, isAdmin: false } },
    );
  } catch (err) {
    if (isAccessMiss(err)) return false;
    throw err;
  }
  const allowed = isRecord(answer) ? answer['allowed'] : undefined;
  if (typeof allowed !== 'boolean') throw unreadable('agents:can-manage-connectors');
  return allowed;
}
