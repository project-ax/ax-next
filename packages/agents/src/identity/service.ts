import {
  PluginError,
  SYSTEM_PROMPT_AUGMENT_CHANGED_HOOK,
  type AgentContext,
  type HookBus,
  type SystemPromptAugmentChangedPayload,
} from '@ax/core';
import { checkAccess } from '../acl.js';
import type { AgentStore } from '../store.js';
import {
  AGENTS_IDENTITY_COMPLETE_BOOTSTRAP_HOOK,
  AGENTS_IDENTITY_GET_HOOK,
  AGENTS_IDENTITY_SET_HOOK,
  IDENTITY_SCAN_HOOK,
  IDENTITY_SECTIONS,
  INSTRUCTIONS_MAX_CHARS,
  type AgentIdentityRecord,
  type IdentityCompleteBootstrapOutput,
  type IdentityRefusalCode,
  type IdentityScanPayload,
  type IdentitySection,
  type IdentitySetOutput,
} from '../types.js';
import type { IdentityStore } from './store.js';

// ---------------------------------------------------------------------------
// TASK-989 — the three identity hooks. The agent tools (tools.ts) call these
// same hooks on the bus with `ctx.agentId`, so a person's save and an agent's
// save pass the same checks and the same `returns` schemas.
//
// Order on every hook: input shape (incl. `input.agentId === ctx.agentId`) →
// the agent exists → `ctx.userId` reaches it (`checkAccess`). Then `set`
// normalises, caps the Instructions, scans every non-empty section (fail
// closed) and compare-and-sets; `saved` and `completed` announce
// `system-prompt:augment-changed`.
//
// Never logged: identity, soul or Instructions text, or a scanner's reason.
// Logged: agentId, section names, revision, refusal code, scan category, an
// error's name/code.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/agents';

/** INSTRUCTIONS_MAX_CHARS, spelled for people (pinned by identity.test.ts). */
const TOO_LONG_REASON = 'Instructions must be 16,384 characters or fewer.';
const SCAN_UNAVAILABLE_REASON = "The safety check isn't available right now, so nothing was saved.";
/** Postgres TEXT cannot hold U+0000; refused here so the write answers, not throws. */
const NUL_REASON = 'contains a NUL character, which cannot be stored';
/** Used when a refusal carries no usable reason of its own. */
const DEFAULT_REFUSAL_REASON = 'flagged by identity safety scan';
const MAX_SCAN_REASON_CHARS = 160;
/** Shape of a scan category worth logging (`instruction-override`, …). */
const LOGGABLE_CATEGORY = /^[a-z][a-z-]{0,39}$/;

export interface IdentityService {
  get(ctx: AgentContext, input: unknown): Promise<AgentIdentityRecord>;
  set(ctx: AgentContext, input: unknown): Promise<IdentitySetOutput>;
  completeBootstrap(ctx: AgentContext, input: unknown): Promise<IdentityCompleteBootstrapOutput>;
}

export interface IdentityServiceDeps {
  bus: HookBus;
  agents: Pick<AgentStore, 'getById'>;
  identity: IdentityStore;
}

type ScanResult =
  | { ok: true }
  | { ok: false; code: Exclude<IdentityRefusalCode, 'too-long'>; reason: string };

function invalid(hookName: string, message: string): PluginError {
  return new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, hookName, message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSection(key: string): key is IdentitySection {
  return (IDENTITY_SECTIONS as readonly string[]).includes(key);
}

/** The calling context's own agent, and nothing else. */
function requireContextAgent(ctx: AgentContext, agentId: unknown, hookName: string): string {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw invalid(hookName, 'agentId must be a non-empty string');
  }
  if (agentId !== ctx.agentId) {
    throw invalid(hookName, 'agentId does not match the calling context');
  }
  return agentId;
}

function parseAgentIdInput(ctx: AgentContext, input: unknown, hookName: string): string {
  if (!isPlainObject(input)) throw invalid(hookName, 'input must be an object carrying agentId');
  if (Object.keys(input).some((key) => key !== 'agentId')) {
    throw invalid(hookName, 'input carries a field this hook does not take');
  }
  return requireContextAgent(ctx, input.agentId, hookName);
}

interface ParsedSet {
  agentId: string;
  patch: Partial<Record<IdentitySection, string>>;
  expectedRevision: number;
}

function parseSetInput(ctx: AgentContext, input: unknown): ParsedSet {
  const hook = AGENTS_IDENTITY_SET_HOOK;
  if (!isPlainObject(input)) throw invalid(hook, 'input must be an object');
  if (Object.keys(input).some((key) => !['agentId', 'patch', 'expectedRevision'].includes(key))) {
    throw invalid(hook, 'input carries a field this hook does not take');
  }
  const agentId = requireContextAgent(ctx, input.agentId, hook);
  const raw = input.patch;
  if (!isPlainObject(raw)) throw invalid(hook, 'patch must be an object');
  const keys = Object.keys(raw);
  if (keys.length === 0) throw invalid(hook, 'patch must name at least one section');
  const patch: Partial<Record<IdentitySection, string>> = {};
  for (const key of keys) {
    if (!isSection(key)) throw invalid(hook, 'patch may only name identity, soul or instructions');
    const value = raw[key];
    if (typeof value !== 'string') throw invalid(hook, `patch.${key} must be a string`);
    patch[key] = value;
  }
  const expectedRevision = input.expectedRevision;
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw invalid(hook, 'expectedRevision must be a non-negative integer');
  }
  return { agentId, patch, expectedRevision };
}

function errorFields(err: unknown): { name: string; code?: string } {
  const name = err instanceof Error ? err.name : typeof err;
  return err instanceof PluginError ? { name, code: err.code } : { name };
}

/**
 * Exactly `{ verdict: 'clean' }`. Anything else — another verdict, a
 * misspelling, an extra field, a non-object — is not a pass (fail closed).
 */
function isClean(answer: unknown): boolean {
  return isPlainObject(answer) && Object.keys(answer).length === 1 && answer.verdict === 'clean';
}

/**
 * A `refused` verdict: the scanner judged the text. Any other non-clean
 * answer is a broken scanner, not a judgement (see `scan`).
 */
function isRefusal(answer: unknown): boolean {
  return isPlainObject(answer) && answer.verdict === 'refused';
}

/**
 * A well-formed refusal's own short reason; anything else gets the fixed one.
 * Only a `refused` verdict's reason is passed on, so odd text from a
 * malformed answer never reaches a person or the agent.
 */
function refusalReason(answer: unknown): string {
  if (
    isPlainObject(answer) &&
    answer.verdict === 'refused' &&
    typeof answer.reason === 'string' &&
    answer.reason.length > 0 &&
    answer.reason.length <= MAX_SCAN_REASON_CHARS
  ) {
    return answer.reason;
  }
  return DEFAULT_REFUSAL_REASON;
}

function loggableCategory(answer: unknown): string | undefined {
  if (!isPlainObject(answer)) return undefined;
  const category = answer.category;
  return typeof category === 'string' && LOGGABLE_CATEGORY.test(category) ? category : undefined;
}

export function createIdentityService(deps: IdentityServiceDeps): IdentityService {
  const { bus } = deps;

  async function requireAccess(ctx: AgentContext, agentId: string, hookName: string): Promise<void> {
    const agent = await deps.agents.getById(agentId);
    if (agent === null) {
      throw new PluginError({
        code: 'not-found',
        plugin: PLUGIN_NAME,
        hookName,
        message: `agent '${agentId}' not found`,
      });
    }
    const acl = await checkAccess(agent, ctx.userId, bus, ctx);
    if (!acl.allowed) {
      throw new PluginError({
        code: 'forbidden',
        plugin: PLUGIN_NAME,
        hookName,
        message: `agent '${agentId}' is not accessible to user '${ctx.userId}'`,
      });
    }
  }

  async function scan(
    ctx: AgentContext,
    agentId: string,
    section: IdentitySection,
    text: string,
  ): Promise<ScanResult> {
    // People's Instructions are scanned as kind 'instructions' (every check
    // but the weak egress-near-secret heuristic, which refuses ordinary
    // instructions); identity and soul take the scanner's default, full check.
    const payload: IdentityScanPayload =
      section === 'instructions' ? { text, kind: 'instructions' } : { text };
    let answer: unknown;
    try {
      // No hasService check: a missing scanner rejects with `no-service`,
      // which lands in the same fail-closed branch as any other failure.
      answer = await bus.call<IdentityScanPayload, unknown>(IDENTITY_SCAN_HOOK, ctx, payload);
    } catch (err) {
      ctx.logger.warn('agent_identity_scan_unavailable', { agentId, section, ...errorFields(err) });
      return { ok: false, code: 'scan-unavailable', reason: SCAN_UNAVAILABLE_REASON };
    }
    if (isClean(answer)) return { ok: true };
    // Neither clean nor a refusal: the scanner is broken, which says nothing
    // about the text. Still nothing is saved (fail closed), but it is not
    // reported as a content refusal the writer should reword.
    if (!isRefusal(answer)) {
      ctx.logger.warn('agent_identity_scan_unavailable', { agentId, section, name: 'malformed-answer' });
      return { ok: false, code: 'scan-unavailable', reason: SCAN_UNAVAILABLE_REASON };
    }
    const category = loggableCategory(answer);
    ctx.logger.info('agent_identity_write_refused', {
      agentId,
      section,
      code: 'content',
      ...(category !== undefined ? { category } : {}),
    });
    return { ok: false, code: 'content', reason: refusalReason(answer) };
  }

  async function announce(ctx: AgentContext, agentId: string): Promise<void> {
    // `fire`, not `call`: a subscriber's throw is isolated, so a saved change
    // is never reported as a failed save because a listener broke.
    const payload: SystemPromptAugmentChangedPayload = { agentId };
    await bus.fire(SYSTEM_PROMPT_AUGMENT_CHANGED_HOOK, ctx, payload);
  }

  return {
    async get(ctx, input) {
      const agentId = parseAgentIdInput(ctx, input, AGENTS_IDENTITY_GET_HOOK);
      await requireAccess(ctx, agentId, AGENTS_IDENTITY_GET_HOOK);
      return deps.identity.get(agentId);
    },

    async set(ctx, input) {
      const { agentId, patch, expectedRevision } = parseSetInput(ctx, input);
      await requireAccess(ctx, agentId, AGENTS_IDENTITY_SET_HOOK);

      // Normalise: trailing whitespace goes, so a whitespace-only section is
      // stored empty (and counts as empty for complete-bootstrap).
      const normalised: Partial<Record<IdentitySection, string>> = {};
      for (const section of IDENTITY_SECTIONS) {
        const value = patch[section];
        if (value !== undefined) normalised[section] = value.trimEnd();
      }

      const instructions = normalised.instructions;
      if (instructions !== undefined && instructions.length > INSTRUCTIONS_MAX_CHARS) {
        ctx.logger.info('agent_identity_write_refused', {
          agentId,
          section: 'instructions',
          code: 'too-long',
        });
        return { outcome: 'refused', section: 'instructions', code: 'too-long', reason: TOO_LONG_REASON };
      }

      // Text the store cannot keep is refused before anything is checked.
      for (const section of IDENTITY_SECTIONS) {
        if (normalised[section]?.includes('\u0000') === true) {
          ctx.logger.info('agent_identity_write_refused', {
            agentId,
            section,
            code: 'content',
            category: 'nul-character',
          });
          return { outcome: 'refused', section, code: 'content', reason: NUL_REASON };
        }
      }

      // Every non-empty section, in a fixed order; the first refusal refuses
      // the whole patch. Clearing a section needs no check.
      for (const section of IDENTITY_SECTIONS) {
        const text = normalised[section];
        if (text === undefined || text === '') continue;
        const verdict = await scan(ctx, agentId, section, text);
        if (!verdict.ok) {
          return { outcome: 'refused', section, code: verdict.code, reason: verdict.reason };
        }
      }

      const result = await deps.identity.set({ agentId, patch: normalised, expectedRevision });
      if (result.kind === 'saved') {
        ctx.logger.info('agent_identity_saved', {
          agentId,
          sections: Object.keys(normalised),
          revision: result.record.revision,
        });
        await announce(ctx, agentId);
      }
      return { outcome: result.kind, record: result.record };
    },

    async completeBootstrap(ctx, input) {
      const agentId = parseAgentIdInput(ctx, input, AGENTS_IDENTITY_COMPLETE_BOOTSTRAP_HOOK);
      await requireAccess(ctx, agentId, AGENTS_IDENTITY_COMPLETE_BOOTSTRAP_HOOK);
      const result = await deps.identity.completeBootstrap(agentId);
      if (result.kind === 'completed') {
        ctx.logger.info('agent_bootstrap_completed', { agentId, revision: result.record.revision });
        await announce(ctx, agentId);
      }
      return { outcome: result.kind, record: result.record };
    },
  };
}
