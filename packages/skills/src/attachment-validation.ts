/**
 * Pure-function validation for a per-user skill attachment's credential
 * bindings. No bus calls, no DB — exercised independently in unit tests.
 *
 * Mirrors @ax/agents' validateNewAttachments (binding-orphan / binding-missing)
 * but is re-implemented here on purpose: invariant #2 forbids importing across
 * the plugin boundary. The shapes are simple (a slot-name array + a slot→ref
 * map), so there is no cross-plugin type to drift.
 *
 * `slot-collision` is intentionally NOT checked here. Per-user wins over the
 * agent-global copy of the SAME skill id (the agent-global copy is dropped). Two
 * DIFFERENT skills declaring the same bare slot name (e.g. both `LINEAR_API_KEY`)
 * COEXIST — TASK-86 namespaces credential slots per-skill (`skill:<id>:<slot>`)
 * in the orchestrator's host-side credential map, so they no longer collide at
 * session open (the old fatal `skill-slot-collision` lockout is gone). This
 * validator only checks one skill's own bindings against its own declared slots.
 */
export type AttachmentValidationResult =
  | { ok: true }
  | { ok: false; code: 'binding-orphan' | 'binding-missing'; message: string };

export function validateAttachmentBindings(
  declaredSlots: readonly string[],
  credentialBindings: Record<string, string>,
): AttachmentValidationResult {
  const declared = new Set(declaredSlots);

  // binding-orphan: a binding key the skill does not declare.
  for (const slot of Object.keys(credentialBindings)) {
    if (!declared.has(slot)) {
      return {
        ok: false,
        code: 'binding-orphan',
        message: `attachment binds slot '${slot}' which the skill does not declare`,
      };
    }
  }

  // binding-missing: a declared slot with no binding.
  for (const slot of declared) {
    if (!(slot in credentialBindings)) {
      return {
        ok: false,
        code: 'binding-missing',
        message: `attachment is missing binding for required slot '${slot}'`,
      };
    }
  }

  return { ok: true };
}
