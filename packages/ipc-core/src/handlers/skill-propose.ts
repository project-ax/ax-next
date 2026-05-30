import {
  SkillProposeRequestSchema,
  SkillProposeResponseSchema,
} from '@ax/ipc-protocol';
import { internalError, logInternalError, mapPluginError, validationError } from '../errors.js';
import { PluginError } from '@ax/core';
import type { ActionHandler } from './types.js';

// Structural-validation PluginError codes the skills:propose hook throws when
// the agent's bundle is malformed: every skills-parser ManifestCode is
// `invalid-*` (invalid-yaml/-manifest/-name/-host/-slot/…) plus the bundle-file
// validator's `invalid-bundle-file`. These are RECOVERABLE author errors (the
// agent re-drafts and re-proposes), so we surface a 400 VALIDATION the runner
// turns into a model-actionable tool error — NOT a sanitized 500. We do NOT
// echo the plugin-supplied message (I9 redaction: plugin codes/messages are
// forgeable); a fixed string is enough for the model to know to re-draft. Any
// OTHER PluginError falls through to mapPluginError (auth/forbidden → status;
// unknown → 500).
function isStructuralRejectCode(code: string): boolean {
  return code.startsWith('invalid-');
}

// ---------------------------------------------------------------------------
// POST /skill.propose — TASK-74, out-of-git Part D (§D1–D3). The runner-side
// skill authoring chokepoint.
//
// The runner's skill_propose executor reads + structurally validates a draft
// dir under /ephemeral/skill-draft/<id>/ and posts this JSON envelope. We hand
// it to the host's `skills:propose` hook, which re-validates, fires the
// skills:scan veto, runs the hybrid materialization gate, and writes ONE
// authored-skill row.
//
// SCOPE / AUTHZ: the (ownerUserId, agentId) the skill is authored under come
// from `ctx` — the IPC server resolved the runner's bearer token to its session
// row and stamped ctx.userId + ctx.agentId before dispatch. There is
// intentionally NO ownerUserId/agentId on the wire, so a runner cannot author a
// skill into a foreign agent's namespace. `origin` is fixed to 'authored' by the
// wire schema (the runner only ever proposes a bundle it composed).
//
// The bundle text (manifest/body/files) is UNTRUSTED, adversarial model output —
// stored as opaque bytes, structurally validated + scanned + gated by the hook,
// never executed or shell-interpolated here.
// ---------------------------------------------------------------------------

interface SkillsProposeHookInput {
  ownerUserId: string;
  agentId: string;
  manifestYaml: string;
  bodyMd: string;
  files: Array<{ path: string; contents: string }>;
  capabilityProposal: unknown;
  origin: 'authored';
}
interface SkillsProposeHookOutput {
  skillId: string;
  status: 'active' | 'pending' | 'quarantined';
  reason?: string;
}

export const skillProposeHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = SkillProposeRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`skill.propose: ${parsed.error.message}`);
  }
  // A runner with an unbound session (placeholder owner — canary / pre-9.5)
  // can't author a skill: the (user, agent) scope is required. Reject cleanly
  // rather than write a row under the 'ipc-server' placeholder.
  if (ctx.userId === 'ipc-server' || ctx.agentId === 'ipc-server') {
    return validationError('skill.propose: session is not bound to a user+agent');
  }

  let out: SkillsProposeHookOutput;
  try {
    out = await bus.call<SkillsProposeHookInput, SkillsProposeHookOutput>(
      'skills:propose',
      ctx,
      {
        ownerUserId: ctx.userId,
        agentId: ctx.agentId,
        manifestYaml: parsed.data.manifestYaml,
        bodyMd: parsed.data.bodyMd,
        files: parsed.data.files,
        capabilityProposal: parsed.data.capabilityProposal,
        origin: parsed.data.origin,
      },
    );
  } catch (err) {
    if (err instanceof PluginError) {
      // Recoverable structural author error → 400 with a fixed, model-safe
      // message (no plugin-message echo — I9). Other codes → mapPluginError.
      if (isStructuralRejectCode(err.code)) {
        return validationError('skill.propose: the skill bundle is malformed (re-draft the SKILL.md)');
      }
      return mapPluginError(err);
    }
    logInternalError(ctx.logger, 'skill.propose', err);
    return internalError();
  }

  const body =
    out.reason !== undefined
      ? { skillId: out.skillId, status: out.status, reason: out.reason }
      : { skillId: out.skillId, status: out.status };
  const checked = SkillProposeResponseSchema.safeParse(body);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'skill.propose',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
