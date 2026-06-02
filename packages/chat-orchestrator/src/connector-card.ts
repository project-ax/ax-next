/**
 * Upfront authored-CONNECTOR approval card (TASK-94). Pure: turns an
 * agent-authored connector draft's declared proposal (hosts/slots/packages; mcp
 * excluded — deferred, the approved-caps wall rejects kind:'mcp') into the
 * `kind:'connector'` card payload, and computes a stable per-conversation dedup
 * key over the shown surface.
 *
 * Structurally mirrors the authored-SKILL card (authored-card.ts) — a connector
 * is the same mechanism-agnostic capability surface, lifted out of the skill.
 * NOT an import of channel-web's PermissionRequest type (invariant #2). The card
 * payload field names are storage- and mechanism-agnostic; backing-mechanism
 * vocabulary (transport/url/command) never appears (mcp is excluded entirely).
 */

/** The declared connector proposal, as the card reads it. */
export interface ConnectorProposalLike {
  allowedHosts: string[];
  credentials: Array<{ slot: string; kind: string; account?: string }>;
  packages?: { npm?: string[]; pypi?: string[] };
  mcpServers?: unknown[];
}

function normPackages(p: ConnectorProposalLike): { npm: string[]; pypi: string[] } {
  return { npm: p.packages?.npm ?? [], pypi: p.packages?.pypi ?? [] };
}

/**
 * True iff the SHOWN surface is non-empty (hosts OR slots OR npm OR pypi; mcp
 * excluded — deferred). Single source of truth for "is there anything to card"
 * — shared by buildAuthoredConnectorCard's null check and the orchestrator's
 * cold-start filter, so they can't diverge.
 */
export function hasConnectorShownSurface(p: ConnectorProposalLike): boolean {
  const { npm, pypi } = normPackages(p);
  return (
    p.allowedHosts.length > 0 ||
    p.credentials.length > 0 ||
    npm.length > 0 ||
    pypi.length > 0
  );
}

export interface AuthoredConnectorCard {
  kind: 'connector';
  connectorId: string;
  name: string;
  hosts: string[];
  slots: Array<{
    slot: string;
    kind: 'api-key';
    account?: string;
    /**
     * TASK-124 — the resolved `<service>` tag the key binds (slot.account, else
     * the connectorId) + the optional `<slot>` tag for a multi-slot connector's
     * per-slot ref. The card's WRITE path builds `{kind:'account', service,
     * slot?}` from these so it addresses the SAME `account:<service>[:<slot>]`
     * row the orchestrator fold resolves — never re-deriving the service from
     * the raw slot name.
     */
    service?: string;
    slotTag?: string;
    haveExisting?: boolean;
  }>;
  authored: true;
  packages: { npm: string[]; pypi: string[] };
}

/** Build the card, or null if the shown surface is empty (incl. mcp-only). */
export function buildAuthoredConnectorCard(
  args: { connectorId: string; name: string; proposal: ConnectorProposalLike },
  vaultedRefs: Set<string>,
): AuthoredConnectorCard | null {
  const { connectorId, name, proposal } = args;
  if (!hasConnectorShownSurface(proposal)) {
    return null; // nothing the card can show/approve (mcp-only or empty)
  }
  const hosts = proposal.allowedHosts;
  // TASK-124 — the per-slot rule keys on the proposal's slot COUNT (mirrors
  // @ax/connectors' deriveCredentialPlan): exactly 1 slot keeps the collapsed
  // `account:<service>` ref; ≥2 slots expand to `account:<service>:<slot>` per
  // slot so two slots that share a service tag no longer collide.
  const isMulti = proposal.credentials.length >= 2;
  const slots = proposal.credentials.map((c) => {
    // The service tag the key binds is the connectorId (credentials-into-connectors:
    // each connector owns its own key, no share-by-service — matches
    // @ax/connectors' serviceTagForSlot). The `c.account ?? connectorId` is
    // VESTIGIAL: the connectors store strips `account` from a connector proposal's
    // slots, so it is always `connectorId` here; retained only because the shape is
    // shared with skill-slot capability cards (which can carry `account`).
    const service = c.account !== undefined && c.account.length > 0 ? c.account : connectorId;
    const ref = isMulti ? `account:${service}:${c.slot}` : `account:${service}`;
    return {
      slot: c.slot,
      kind: 'api-key' as const,
      ...(c.account !== undefined ? { account: c.account } : {}),
      service,
      ...(isMulti ? { slotTag: c.slot } : {}),
      haveExisting: vaultedRefs.has(ref),
    };
  });
  return {
    kind: 'connector',
    connectorId,
    name,
    hosts,
    slots,
    authored: true,
    packages: normPackages(proposal),
  };
}

/** Stable dedup key over the SHOWN surface (mcp excluded). */
export function authoredConnectorCardDedupKey(
  connectorId: string,
  proposal: ConnectorProposalLike,
): string {
  const { npm, pypi } = normPackages(proposal);
  const canon = JSON.stringify({
    h: [...proposal.allowedHosts].sort(),
    s: [...proposal.credentials.map((c) => c.slot)].sort(),
    n: [...npm].sort(),
    p: [...pypi].sort(),
  });
  // connectorId matches /^[a-z0-9][a-z0-9_-]*$/ (the @ax/connectors store
  // grammar) and can never contain NUL, so the prefix join is unambiguous.
  return `${connectorId}\u0000${canon}`;
}
