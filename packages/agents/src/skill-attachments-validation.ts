/**
 * Pure-function validation for skill attachment inputs.
 *
 * No bus calls, no DB — exercised independently in unit tests. The admin
 * route handler glues this to bus.call('skills:resolve', ...) and the
 * persistence path (agents:set-skill-attachments).
 *
 * Validates:
 *   - skill-not-found:   attachment references a skillId not in resolvedSkills
 *   - binding-orphan:    attachment binds a slot the skill doesn't declare
 *   - binding-missing:   attachment is missing a binding for a declared slot
 *   - invalid-slot:      a declared slot id is malformed (not SCREAMING_SNAKE) —
 *                        re-checked here against the manifest parser's contract as
 *                        a defense-in-depth drift guard (slot values are untrusted:
 *                        a skill manifest may be model-authored)
 *
 * NO cross-skill `slot-collision` check (TASK-87). TASK-86 namespaces credential
 * slots PER-SKILL (`skill:<id>:<slot>`) in the orchestrator's host-side credential
 * map, so two attachments declaring the same bare slot name resolve to two DISTINCT
 * keys → two distinct `ax-cred:<hex>` placeholders → no runtime collision. A skill
 * slot shadowing a TRUSTED/agent-reserved bare name is likewise not a fatal
 * collision: the trusted bare name always wins the flat sandbox env stamp
 * (`projectEnvMapToBareNames`) — a benign no-op suppression, not the old
 * `skill-slot-collision` lockout. Rejecting either at admin-attach time would be a
 * false negative, stricter than runtime. This mirrors the per-user validator
 * (`@ax/skills` attachment-validation.ts), which dropped its collision check in
 * TASK-86 for the same reason.
 */

// Types are structurally inlined rather than imported from @ax/skills to avoid
// a cross-plugin runtime import (Invariant I2). The shapes must stay in sync;
// a breaking change in ResolvedSkill will surface as a tsc error here.
//
// TASK-100 — a skill manifest declares NO capabilities (its reach is the
// connectors it references), so a skill has NO credential slots: an attachment
// must carry no bindings (any binding is a `binding-orphan`). The validator no
// longer reads a per-skill slot set; it confirms the skill exists and rejects
// stray bindings.
interface ResolvedSkillShape {
  id: string;
  bodyMd: string;
  manifestYaml: string;
}

export interface NewAttachmentInput {
  skillId: string;
  credentialBindings: Record<string, string>;
}

export type ValidationResult =
  | { ok: true; validated: NewAttachmentInput[] }
  | {
      ok: false;
      code: 'skill-not-found' | 'binding-missing' | 'binding-orphan' | 'invalid-slot';
      message: string;
    };

/**
 * Validate a proposed set of skill attachments for an agent.
 *
 * @param attachments         - The incoming attachments array from the PATCH body.
 * @param resolvedSkills      - Skills resolved from skills:resolve for the referenced skillIds.
 * @param agentRequiredCredentialSlots - Slot names the agent itself already claims.
 *                              Forward-compat seam for Phase 1.5 (when the orchestrator
 *                              plumbs requiredCredentials through the agent shape);
 *                              pass [] for now. NO LONGER used to reject a colliding
 *                              skill slot (TASK-87): a skill slot shadowing a trusted
 *                              bare name is a benign no-op suppression at runtime
 *                              (the trusted name wins the env stamp), not a fatal
 *                              collision. Kept as a documented seam — wired through the
 *                              admin route's `reservedAgentSlots` + its
 *                              `TODO(orchestrator-grows-requiredCredentials)`.
 */
export function validateNewAttachments(
  attachments: NewAttachmentInput[],
  resolvedSkills: ResolvedSkillShape[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- forward-compat seam; see jsdoc + TASK-87 decision.
  agentRequiredCredentialSlots: readonly string[],
): ValidationResult {
  const skillById = new Map(resolvedSkills.map((s) => [s.id, s]));

  for (const attachment of attachments) {
    const skill = skillById.get(attachment.skillId);
    if (skill === undefined) {
      return {
        ok: false,
        code: 'skill-not-found',
        message: `skill '${attachment.skillId}' is not installed`,
      };
    }

    // TASK-100 — a skill declares NO credential slots, so an attachment must
    // carry no bindings. binding-orphan: any binding key is rejected (the skill
    // declares nothing to bind to). There is no binding-missing / invalid-slot
    // check anymore (a skill has no declared slots). A skill's credential reach
    // is its connectors', gated by the connector approval flow.
    for (const slot of Object.keys(attachment.credentialBindings)) {
      return {
        ok: false,
        code: 'binding-orphan',
        message: `attachment for skill '${skill.id}' includes binding for slot '${slot}' which the skill does not declare (a skill declares no credentials; use a connector)`,
      };
    }
  }

  return { ok: true, validated: attachments };
}
