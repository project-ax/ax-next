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
 *   - slot-collision:    two attachments (or an attachment + agent reserved
 *                        slots) claim the same credential slot
 */

// Types are structurally inlined rather than imported from @ax/skills to avoid
// a cross-plugin runtime import (Invariant I2). The shapes must stay in sync;
// a breaking change in CapabilitySlot or ResolvedSkill will surface as a tsc
// error here.
interface CapabilitySlotShape {
  slot: string;
  kind: 'api-key';
  description?: string;
}
interface ResolvedSkillShape {
  id: string;
  capabilities: {
    allowedHosts: string[];
    credentials: CapabilitySlotShape[];
  };
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
      code: 'skill-not-found' | 'binding-missing' | 'binding-orphan' | 'slot-collision';
      message: string;
    };

/**
 * Validate a proposed set of skill attachments for an agent.
 *
 * @param attachments         - The incoming attachments array from the PATCH body.
 * @param resolvedSkills      - Skills resolved from skills:resolve for the referenced skillIds.
 * @param agentRequiredCredentialSlots - Slot names the agent itself already claims
 *                              (forward-compat for Phase 1.5 when orchestrator plumbs
 *                              requiredCredentials through the agent shape). Pass [] for now.
 */
export function validateNewAttachments(
  attachments: NewAttachmentInput[],
  resolvedSkills: ResolvedSkillShape[],
  agentRequiredCredentialSlots: readonly string[],
): ValidationResult {
  const skillById = new Map(resolvedSkills.map((s) => [s.id, s]));

  // Seed slot ownership with the agent's reserved credential slots.
  const slotOwners = new Map<string, string>();
  for (const slot of agentRequiredCredentialSlots) {
    slotOwners.set(slot, '<agent.requiredCredentials>');
  }

  for (const attachment of attachments) {
    const skill = skillById.get(attachment.skillId);
    if (skill === undefined) {
      return {
        ok: false,
        code: 'skill-not-found',
        message: `skill '${attachment.skillId}' is not installed`,
      };
    }

    const declaredSlots = new Set(skill.capabilities.credentials.map((c) => c.slot));

    // binding-orphan: a binding key not declared by the skill
    for (const slot of Object.keys(attachment.credentialBindings)) {
      if (!declaredSlots.has(slot)) {
        return {
          ok: false,
          code: 'binding-orphan',
          message: `attachment for skill '${skill.id}' includes binding for slot '${slot}' which the skill does not declare`,
        };
      }
    }

    // binding-missing: a declared slot without a binding
    for (const declared of skill.capabilities.credentials) {
      if (!(declared.slot in attachment.credentialBindings)) {
        return {
          ok: false,
          code: 'binding-missing',
          message: `attachment for skill '${skill.id}' is missing binding for required slot '${declared.slot}'`,
        };
      }
    }

    // slot-collision: this skill claims a slot some other owner already has
    for (const declared of skill.capabilities.credentials) {
      if (slotOwners.has(declared.slot)) {
        const other = slotOwners.get(declared.slot)!;
        return {
          ok: false,
          code: 'slot-collision',
          message: `slot '${declared.slot}' on skill '${skill.id}' collides with existing owner '${other}'`,
        };
      }
      slotOwners.set(declared.slot, skill.id);
    }
  }

  return { ok: true, validated: attachments };
}
