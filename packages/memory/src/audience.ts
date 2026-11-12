import { audienceOf, PluginError, type AgentContext, type HookBus } from '@ax/core';

import { PLUGIN_NAME } from './plugin-name.js';

/**
 * The audience of a memory READ (TASK-1091): a turn whose reply people
 * without access to the agent can read recalls only what was learned where
 * they could see it.
 *
 * `ctx.audience` is stamped by the host and never read off a payload (see
 * `FORBIDDEN_PAYLOAD_FIELDS` in `plugin.ts`), so this scope comes from `ctx`
 * alone, like the owner scope. It is deliberately NOT folded into
 * `memoryReadScope`: that scope also rides the forget/correct/undo writes and
 * the `/memory` export, which audience must not narrow.
 *
 * Every engine read in this package goes through {@link recallFacts}: the
 * `memory:recall` reads, the injected block, and the observer's and the note
 * tool's twin reads. So a shared turn behaves as if private rows did not
 * exist, rather than missing them in one place and meeting them in another.
 */

/**
 * The engine recall scope for a turn: `{ audience: 'shared' }` for a shared
 * turn, and for an audience this build does not know (`audienceOf` reads that
 * as shared, the least recall). Nothing at all for a private turn, whose reads
 * are exactly what they were before audiences existed.
 */
export function recallAudienceScope(ctx: Pick<AgentContext, 'audience'>): { audience?: 'shared' } {
  return audienceOf(ctx) === 'shared' ? { audience: 'shared' } : {};
}

/**
 * Call the engine's recall hook with the turn's audience scope, spread LAST so
 * no caller-built input can override it.
 *
 * ## The backstop
 *
 * A shared read whose answer holds any row not stamped `'shared'` throws
 * `invalid-return` instead of returning it. Both in-repo engines drop an
 * unknown recall field without a word, so an engine without audience support
 * would answer a shared read with every row it has, and those rows would land
 * in a reply people without access to the agent can read. One stray row fails
 * the whole read. Dropping it instead would be the post-filter design §6.1
 * forbids: a short page, and nobody learns the engine ignored the scope.
 *
 * An unstamped row fails too. A row stored before audiences existed is not
 * provably shared, which is the engines' own strict-equality rule.
 *
 * The message names no row, neither its text nor its id: it goes to logs and,
 * through `memory_recall`, to a model in a shared turn.
 *
 * Not checked here: an answer that is not an object, or whose `statements` is
 * not an array. Every caller refuses those on its own terms, and none reads a
 * row out of them.
 */
export async function recallFacts<TOut>(
  bus: HookBus,
  ctx: AgentContext,
  hookName: string,
  input: Record<string, unknown>,
): Promise<TOut | null> {
  const scope = recallAudienceScope(ctx);
  const out = await bus.call<Record<string, unknown>, TOut | null>(hookName, ctx, {
    ...input,
    ...scope,
  });
  if (scope.audience === 'shared') requireSharedRows(out, hookName);
  return out;
}

function requireSharedRows(out: unknown, hookName: string): void {
  if (out === null || typeof out !== 'object') return;
  const statements = (out as { statements?: unknown }).statements;
  if (!Array.isArray(statements)) return;
  // `for...of`, not `every`: `every` skips a hole, and a hole is not a row
  // stamped shared.
  for (const row of statements as unknown[]) {
    if (row === null || typeof row !== 'object' || (row as { audience?: unknown }).audience !== 'shared') {
      throw new PluginError({
        code: 'invalid-return',
        plugin: PLUGIN_NAME,
        hookName,
        message: `${hookName} answered a shared-audience read with a statement not stamped shared: the engine ignored the audience scope, so memory refuses the whole answer rather than show a private statement to people without access to the agent`,
      });
    }
  }
}
