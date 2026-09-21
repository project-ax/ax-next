/**
 * Where a grant card's key actually gets written (TASK-124), for every surface
 * that asks for one (TASK-350).
 *
 * These were private functions in `src/components/PermissionCard.tsx` while chat
 * was the only surface that could ask. They are pure, React-free, and getting
 * them wrong writes a secret to the wrong vault row — so when the agent
 * workspace grew its own grant renderer they moved here rather than being
 * copied. Same reasoning as `grant-copy.ts`, and the same deadline:
 * `PermissionCard.tsx` is deleted by TASK-360.
 */
import type { Destination } from '@ax/credentials';

/**
 * One card slot row, as the WRITE paths read it. `service`/`slotTag` (TASK-124)
 * are the resolved vault-key tags the producer (orchestrator / skill-broker) set;
 * `account` is the legacy pre-TASK-124 field kept for back-compat with a card that
 * predates the new tags.
 */
export interface CardSlot {
  slot: string;
  account?: string;
  service?: string;
  slotTag?: string;
}

/**
 * (TASK-388) These tags are typed `string` and arrive off the wire, where
 * neither grant surface's producer checks them: chat's validates nothing at
 * all, and the workspace's `isRenderableGrant` checks `slot` and stops there.
 * So "typed `string`" means "the producer promised", not "we looked".
 *
 * A non-string tag matters HERE more than in a renderer, because these
 * functions decide which vault row a secret lands in — getting it wrong is the
 * failure this module's header already warns about, and `{service: {}}` would
 * be carried straight into the write. Treating a non-string as ABSENT is what
 * makes that safe: every branch below already has a defined fallback for an
 * absent tag (the collapsed `account` route, then `skill-slot`/`connectorId`),
 * so a malformed frame degrades onto the id the caller passed in.
 *
 * The caller-id fallback is required only when no usable service/account
 * tag supplied a destination. It must also be a non-blank string.
 * Never stringify an invalid value or invent a placeholder identity:
 * either would select a vault row the request did not name.
 * An invalid floor throws before a credential write; both grant surfaces
 * catch submission failures and keep the card visible.
 * Both grant surfaces use the user-scoped settings endpoint. The server
 * validates destinations, computes refs, and forces user scope with
 * the authenticated actor as owner. This client check is defense in depth,
 * not the authority for destination grammar or ownership.
 */
function tag(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function requiredCallerId(value: unknown): string {
  const id = tag(value);
  if (id === undefined) throw new TypeError('Invalid credential caller identifier.');
  return id;
}

/**
 * TASK-124 — build the account destination for a CONNECTOR slot. Prefer the
 * resolved `service`/`slotTag` (so a multi-slot connector hits its distinct
 * per-slot `account:<service>:<slot>` row); fall back to the legacy
 * `account ?? connectorId` collapsed shape for a card without the new tags.
 */
export function accountDestinationForConnectorSlot(
  s: CardSlot,
  connectorId: string,
): Destination {
  const service = tag(s.service) ?? tag(s.account) ?? requiredCallerId(connectorId);
  const slotTag = tag(s.slotTag);
  return {
    kind: 'account',
    service,
    ...(slotTag !== undefined ? { slot: slotTag } : {}),
  };
}

/**
 * TASK-124 — build the destination for a SKILL-card slot. A connector-derived
 * slot carries `service` (always set by the producer) → the
 * `account:<service>[:<slot>]` vault row; a legacy slot with only `account` keeps
 * the collapsed account route; an untagged slot keeps the per-skill `skill-slot`
 * destination.
 */
export function accountOrSkillDestination(s: CardSlot, skillId: string): Destination {
  const service = tag(s.service);
  if (service !== undefined) {
    const slotTag = tag(s.slotTag);
    return {
      kind: 'account',
      service,
      ...(slotTag !== undefined ? { slot: slotTag } : {}),
    };
  }
  const account = tag(s.account);
  if (account !== undefined) {
    return { kind: 'account', service: account };
  }
  return { kind: 'skill-slot', skillId: requiredCallerId(skillId), slot: s.slot };
}
