/**
 * The materialization gate (TASK-74, design §D3; narrowed by TASK-100). Pure
 * function: given the trust provenance and the safety-scan verdict, classify a
 * proposed skill into one of three materialization states.
 *
 *   clean scan  AND  origin = authored
 *       → 'active'       (materialize freely next spawn, no human)
 *
 *   origin ∈ {imported, attached}
 *       → 'pending'      (approve-before-materialize; nothing projects)
 *
 *   scan hit (any class)
 *       → 'quarantined'  (omit from projection; reason returned to the agent)
 *
 * TASK-100 — a skill manifest no longer declares capabilities at all (reach
 * lives only on the connectors a skill references). A self-authored skill is
 * therefore ALWAYS zero-reach instruction scaffolding, so the free path no
 * longer needs a capability check — the only approvable reach is a connector,
 * gated by the connector approval card (TASK-94), not this skill gate. The
 * origin axis is preserved: anything pulled from outside still waits for a
 * human, and a scan hit is quarantined regardless of provenance.
 */
import type { AuthoredStatus, AuthoredOrigin } from './authored-store.js';

// The gate only ever produces a propose-time verdict — never 'adopted' (that's a
// later user action, TASK-134). Narrow the return so it stays assignable to the
// projection / propose-output `status` unions even though AuthoredStatus is wider.
export type ProposeVerdict = Exclude<AuthoredStatus, 'adopted'>;

export function classifyProposal(args: {
  origin: AuthoredOrigin;
  scanClean: boolean;
}): ProposeVerdict {
  if (!args.scanClean) return 'quarantined';
  if (args.origin === 'authored') return 'active';
  return 'pending';
}
