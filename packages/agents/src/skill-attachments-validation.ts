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

// A valid credential slot id: SCREAMING_SNAKE_CASE, starts with A-Z. This is the
// manifest parser's contract (`@ax/skills-parser` manifest.ts SLOT_RE), re-checked
// here so a drifted upstream (or an untrusted, possibly model-authored skill shape)
// can't smuggle a malformed slot id into the per-skill credential namespace
// (`skill:<id>:<garbage>`). Kept structurally in sync, not imported (invariant #2).
const SLOT_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

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

    // invalid-slot: a declared slot id must be SCREAMING_SNAKE (the manifest
    // parser's contract). Re-checked here as a defense-in-depth drift guard — a
    // malformed slot must never flow into the per-skill credential namespace
    // (`skill:<id>:<garbage>`). Slot values are untrusted (a skill manifest may be
    // model-authored), so this is enforced before any binding check.
    for (const declared of skill.capabilities.credentials) {
      if (!SLOT_RE.test(declared.slot)) {
        return {
          ok: false,
          code: 'invalid-slot',
          message: `attachment for skill '${skill.id}' declares malformed credential slot '${declared.slot}' (must match /^[A-Z][A-Z0-9_]{0,63}$/)`,
        };
      }
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

    // NO slot-collision check (TASK-87) — two skills (or a skill + a trusted
    // reserved slot) sharing a bare slot name coexist: TASK-86 namespaces them
    // per-skill at runtime, and a trusted bare name always wins the env stamp.
  }

  return { ok: true, validated: attachments };
}
