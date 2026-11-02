import {
  SKILL_PROPOSE_REASON_MAX,
  SkillProposeRequestSchema,
  SkillProposeResponseSchema,
} from '@ax/ipc-protocol';
import { zodSummary,
  hookRejected,
  internalError,
  logInternalError,
  mapPluginError,
  validationError,
} from '../errors.js';
import { clampCodeUnits, isOwnerlessId, PluginError } from '@ax/core';
import type { ManifestCode } from '@ax/skills-parser';
import type { ActionHandler } from './types.js';

// Structural-validation PluginError codes the skills:propose hook throws when
// the agent's bundle is malformed: every skills-parser `ManifestCode`
// (packages/skills-parser/src/manifest.ts) plus the bundle-file validator's
// `invalid-bundle-file`. These are RECOVERABLE author errors (the agent
// re-drafts and re-proposes), so we surface a 400 VALIDATION the runner turns
// into a model-actionable tool error — NOT a sanitized 500. We do NOT echo the
// plugin-supplied message (I9 redaction: plugin codes/messages are forgeable);
// a fixed string is enough for the model to know to re-draft. Any OTHER
// PluginError falls through to mapPluginError (auth/forbidden → status;
// unknown/timeout/no-service → logged 500).
//
// An explicit list, not an `invalid-` prefix match (TASK-1015): two parser
// codes don't carry the prefix (an honest `capabilities:` block or `token:` key
// became a retried 500), and the bus's own `invalid-return` (a service answer
// that failed its schema, a HOST fault) does.
//
// The parser half is pinned to the parser's own type (TASK-1018): `satisfies
// Record<ManifestCode, true>` makes a code the parser adds later (missing key,
// TS1360) or drops (extra key, TS2353) a `tsc` error here. The fix is to add
// it to this table, i.e. to make it a 400. A code that should NOT be an
// author error must instead be thrown under a non-ManifestCode name. The
// point is that someone looks at skill.propose when the parser grows a code,
// rather than the code being picked up silently. A type-only import, so no
// runtime coupling to @ax/skills-parser.
const MANIFEST_REJECT_CODES = {
  'invalid-yaml': true,
  'invalid-manifest': true,
  'inline-secret-forbidden': true,
  'invalid-name': true,
  'invalid-description': true,
  'invalid-version': true,
  'capability-block-forbidden': true,
  'invalid-connector': true,
} as const satisfies Record<ManifestCode, true>;
const STRUCTURAL_REJECT_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(MANIFEST_REJECT_CODES),
  // The bundle-file validator's code (thrown by skills:propose, not the parser).
  'invalid-bundle-file',
]);
function isStructuralRejectCode(code: string): boolean {
  return STRUCTURAL_REJECT_CODES.has(code);
}

// ---------------------------------------------------------------------------
// POST /skill.propose — TASK-74, out-of-git Part D (§D1–D3). The runner-side
// skill authoring chokepoint.
//
// The runner's skill_propose executor reads + structurally validates a draft
// dir under `<root>/.skill-draft/<id>/` (durable per-agent mount when wired, else
// the ephemeral scratch tier — TASK-165) and posts this JSON envelope. We hand
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
    return validationError(`skill.propose: ${zodSummary(parsed.error)}`);
  }
  // A runner on an OWNER-LESS session (canary / `serve` / pre-9.5) can't
  // author a skill: the (user, agent) scope is required. Reject cleanly rather
  // than write a row under a stand-in owner.
  //
  // TASK-411: this used to read `ctx.userId === 'ipc-server' || ctx.agentId
  // === 'ipc-server'` — one transport's literal. @ax/ipc-http substituted
  // `'ipc-http'` and this guard never saw it, so the k8s transport (the one
  // serving production) could author a skill under a placeholder owner while
  // the subprocess transport could not. A guard spelled as a literal is a
  // census of the callers that mint it, and this one had been stale since
  // @ax/ipc-http shipped. `isOwnerlessId` is the kernel's single spelling of
  // "this caller has no owner", so there is no per-transport set to keep.
  if (isOwnerlessId(ctx.userId) || isOwnerlessId(ctx.agentId)) {
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
      // TASK-690: writing the bundle goes through `blob:put`, which throws code
      // 'rejected' when the per-person storage limit refuses. Same redaction
      // rule as above (the plugin's message is not echoed): a fixed sentence the
      // agent can relay, instead of an opaque 500 that reads as a host fault.
      if (err.code === 'rejected') {
        return hookRejected(
          'skill.propose: the skill was not saved because storage is full. Let the person know an admin can make more room.',
        );
      }
      // Log every 500 before returning it: the real bus wraps a plain throw (a
      // store or DB outage) into PluginError{code:'unknown'}, which maps to 500.
      // Logging only the non-PluginError branch below left that 500 unrecorded
      // (TASK-1015). An expected 4xx answer (forbidden, not-found, …) is not
      // an internal error: a warn carrying the code only — never the
      // plugin-supplied message — so it can still be traced.
      const mapped = mapPluginError(err);
      if (mapped.status >= 500) {
        logInternalError(ctx.logger, 'skill.propose', err);
      } else {
        ctx.logger.warn('skill_propose_hook_refused', {
          action: 'skill.propose',
          pluginErrorCode: err.code,
        });
      }
      return mapped;
    }
    logInternalError(ctx.logger, 'skill.propose', err);
    return internalError();
  }

  const body =
    out.reason !== undefined
      ? {
          skillId: out.skillId,
          status: out.status,
          // Scan text from plugin code: clamp to the wire cap so an over-long
          // reason still arrives as this verdict, not as a 500 (TASK-781).
          reason: clampCodeUnits(out.reason, SKILL_PROPOSE_REASON_MAX),
        }
      : { skillId: out.skillId, status: out.status };
  const checked = SkillProposeResponseSchema.safeParse(body);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'skill.propose',
      new Error(`response shape drift: ${zodSummary(checked.error)}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
