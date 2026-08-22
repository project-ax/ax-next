// ---------------------------------------------------------------------------
// The Memory tab's service hooks (TASK-234 / plan task AW-13).
//
//   memory:rules:read   { agentId }         → { body }
//   memory:rules:write  { agentId, body }   → { written }
//   memory:learned:read { agentId }         → { docs: [{ name, body }] }
//
// BOUNDARY REVIEW
//
// - Alternate impl: the human tier stored as a database row rather than a
//   workspace file — same three hooks, no filesystem. Nothing in these payloads
//   would change.
// - Field names that might leak: none. `body` is text, `name` is a display
//   label, `written` is a boolean. Rejected: `path` (filesystem), `docId`
//   (strata-internal), `tier` (workspace-topology vocabulary), `version` (a CAS
//   token, which is the git backend's word for a concept the caller has no use
//   for).
// - Subscriber risk: none — three service hooks, no events.
// - Wire surface: no IPC action. The runner never calls these; the human tier
//   reaches the agent by injection, like every other memory file.
//
// WHY `agentId` IS IN THE PAYLOAD WHEN `ctx` ALREADY CARRIES ONE. Because the
// write routes by `(userId, agentId)` from the ctx, and the established
// regression here is a caller that fires with the WRONG ctx and lands a write
// in another agent's workspace. Carrying the id the caller BELIEVES it is
// writing lets us reject the mismatch loudly instead of writing it quietly.
// ---------------------------------------------------------------------------

import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import { readLearnedDocs, readRules, writeRules, type LearnedDoc } from './rules-store.js';

const PLUGIN_NAME = '@ax/memory-strata';

/** `memory:rules:read` / `memory:learned:read` input. */
export interface MemoryRulesReadInput {
  /** The agent whose memory is being read. Must match the calling ctx. */
  agentId: string;
}

/** `memory:rules:read` output — the human tier, verbatim. '' when unwritten. */
export interface MemoryRulesReadOutput {
  body: string;
}

/** `memory:rules:write` input. */
export interface MemoryRulesWriteInput {
  agentId: string;
  /** The user's text, as typed. Stored verbatim, never parsed or summarized. */
  body: string;
}

/** `memory:rules:write` output. */
export interface MemoryRulesWriteOutput {
  /** True once the bytes are durable. A failed write throws; it never reports false. */
  written: boolean;
}

/** `memory:learned:read` output — the agent's own always-injected working docs. */
export interface MemoryLearnedReadOutput {
  docs: LearnedDoc[];
}

/**
 * The caller must be asking about the agent its ctx routes to.
 *
 * `workspace:apply` routes by `(userId, agentId)` off the ctx, and a subscriber
 * that reuses somebody else's ctx lands the write in the wrong workspace — a
 * bug this repo has shipped before. A mismatch is a programming error, so it
 * throws rather than degrading.
 */
function assertCtxMatches(ctx: AgentContext, agentId: string, hookName: string): void {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: 'agentId is required',
    });
  }
  if (agentId !== ctx.agentId) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message:
        `agentId ${agentId} does not match the calling context (${ctx.agentId}). ` +
        'Build a context for the agent you are reading or writing.',
    });
  }
}

/** Register the Memory tab's three service hooks. */
export function registerRulesHooks(bus: HookBus): void {
  bus.registerService<MemoryRulesReadInput, MemoryRulesReadOutput>(
    'memory:rules:read',
    PLUGIN_NAME,
    async (ctx, input) => {
      assertCtxMatches(ctx, input.agentId, 'memory:rules:read');
      return { body: await readRules(bus, ctx, ctx.workspace.rootPath) };
    },
  );

  bus.registerService<MemoryRulesWriteInput, MemoryRulesWriteOutput>(
    'memory:rules:write',
    PLUGIN_NAME,
    async (ctx, input) => {
      assertCtxMatches(ctx, input.agentId, 'memory:rules:write');
      if (typeof input.body !== 'string') {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'memory:rules:write',
          message: 'body must be a string',
        });
      }
      if (input.body.length > MAX_RULES_BYTES) {
        // The whole file is injected into every system prompt, so an unbounded
        // one is a bill, not a feature. Refusing beats silently truncating
        // something the user was promised is kept word for word.
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'memory:rules:write',
          message: `rules must be ${MAX_RULES_BYTES} characters or fewer`,
        });
      }
      await writeRules(bus, ctx, ctx.workspace.rootPath, input.body);
      return { written: true };
    },
  );

  bus.registerService<MemoryRulesReadInput, MemoryLearnedReadOutput>(
    'memory:learned:read',
    PLUGIN_NAME,
    async (ctx, input) => {
      assertCtxMatches(ctx, input.agentId, 'memory:learned:read');
      return { docs: await readLearnedDocs(bus, ctx, ctx.workspace.rootPath) };
    },
  );
}

/**
 * Cap on the human tier, in characters. ~16k characters is about 4k tokens —
 * larger than the entire memory block's default budget, so anyone who hits
 * this is not writing rules any more. Generous on purpose: the point of this
 * tier is that we keep what the user wrote.
 */
export const MAX_RULES_BYTES = 16_384;
