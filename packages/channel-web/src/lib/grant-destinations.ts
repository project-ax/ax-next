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
 * TASK-124 — build the account destination for a CONNECTOR slot. Prefer the
 * resolved `service`/`slotTag` (so a multi-slot connector hits its distinct
 * per-slot `account:<service>:<slot>` row); fall back to the legacy
 * `account ?? connectorId` collapsed shape for a card without the new tags.
 */
export function accountDestinationForConnectorSlot(
  s: CardSlot,
  connectorId: string,
): Destination {
  const service = s.service ?? s.account ?? connectorId;
  return {
    kind: 'account',
    service,
    ...(s.slotTag !== undefined ? { slot: s.slotTag } : {}),
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
  if (s.service !== undefined) {
    return {
      kind: 'account',
      service: s.service,
      ...(s.slotTag !== undefined ? { slot: s.slotTag } : {}),
    };
  }
  if (s.account !== undefined) {
    return { kind: 'account', service: s.account };
  }
  return { kind: 'skill-slot', skillId, slot: s.slot };
}
