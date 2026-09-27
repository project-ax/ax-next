/**
 * The one-time wipe of OLD memory (TASK-576). DESTRUCTIVE AND IRREVERSIBLE.
 *
 * When `@ax/memory` became the default memory, the owner ruled that every
 * agent starts fresh: the old (Strata) memory is deleted from each agent's
 * workspace AND from that workspace's history, and the facts rows are
 * cleared. This module does that exactly once per deployment, at boot, before
 * the host serves (see `plugin.ts`: it is the last thing `init()` awaits).
 *
 * ## What is wiped, per agent (decided, not guessed — see
 * docs/plans/2026-09-27-task-576-facts-default-strata-wipe.md)
 *
 * | Path | Wiped? | Why |
 * |---|---|---|
 * | `memory/**` except `memory/system/rules.md` | tree + history | The Strata tier: `system/{agent,user,session,recent,map}.md`, `system/.map-cache.json`, `inbox/**`, `docs/**`, plus anything a runner wrote there. `agent.md` is a derived copy of `.ax/IDENTITY.md`+`.ax/SOUL.md`, which are untouched. |
 * | `memory/system/rules.md` | **kept**, history kept | Human-authored Rules; `memory:rules:*` is the shared contract and `@ax/memory` reads/writes the SAME path (`MEMORY_RULES_PATH`). Rules carry over. |
 * | `permanent/memory/facts/**` | tree + history | The facts export: a host-owned, wholesale-regenerated projection of the facts rows we are clearing. Keeping it would keep the cleared rows' text. |
 * | facts rows (`memory:facts:clear`) | cleared | Owner ruling. |
 * | export volume, agent slot | emptied | Same projection as the workspace facts export; the runner mounts it read-only. |
 * | everything else in the workspace | untouched, history untouched | |
 *
 * ## Why it cannot half-apply or repeat
 *
 * - A global `complete` marker makes every later boot a single `storage:get`.
 * - The COHORT (agent ids at the first run) is stored BEFORE anything
 *   destructive happens and is re-read, never re-listed, on a resumed run: an
 *   agent created after the switch never had old memory, and a later boot
 *   must not clear its new facts.
 * - A per-agent `done` marker is set only after all of that agent's steps
 *   succeeded. `memory:facts:clear` is the one step that is not naturally
 *   idempotent (re-running it would delete post-switch facts), and this
 *   marker is what guards it.
 * - Any failure throws a PluginError naming the agent and the step, and stops
 *   immediately. `init()` rejects, the host does not start, and the next boot
 *   resumes at the failed agent.
 *
 * Log lines carry agent ids, workspace paths (agent-authored names, so they
 * are JSON-encoded by the logger, never interpolated) and counts — never file
 * content.
 */
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  MEMORY_FACTS_EXPORT_ROOT,
  MEMORY_RULES_PATH,
  PluginError,
  WorkspacePurgeOutputSchema,
  createLogger,
  isOwnerlessId,
  makeAgentContext,
  type AgentContext,
  type HookBus,
  type Logger,
  type WorkspacePurgeInput,
  type WorkspacePurgeOutput,
} from '@ax/core';

import { syncFactsVolume, volumeAgentKey, type MemoryVolumeConfig } from './export-volume.js';
import { PLUGIN_NAME } from './plugin-name.js';

/**
 * The Strata workspace tier's root directory. A literal on purpose: its owning
 * constant (`AGENT_TIER_MEMORY_ROOT`) lives in the Strata plugin, which this
 * package may not import (invariant 2). It is also the top directory of
 * `MEMORY_RULES_PATH`; the tests pin both facts.
 */
const OLD_MEMORY_TIER_PREFIX = 'memory/';

export const OLD_MEMORY_WIPE_PREFIXES: readonly string[] = Object.freeze([
  OLD_MEMORY_TIER_PREFIX,
  `${MEMORY_FACTS_EXPORT_ROOT}/`,
]);
export const OLD_MEMORY_WIPE_KEEP: readonly string[] = Object.freeze([MEMORY_RULES_PATH]);

export const OLD_MEMORY_WIPE_COMPLETE_KEY = 'memory:old-memory-wipe:v1:complete';
export const OLD_MEMORY_WIPE_COHORT_KEY = 'memory:old-memory-wipe:v1:cohort';
export function oldMemoryWipeDoneKey(agentId: string): string {
  return `memory:old-memory-wipe:v1:done:${agentId}`;
}

export const OLD_MEMORY_WIPE_STARTED_EVENT = 'memory_old_memory_wipe_started';
export const OLD_MEMORY_WIPED_EVENT = 'memory_old_memory_wiped';
export const OLD_MEMORY_WIPE_COMPLETE_EVENT = 'memory_old_memory_wipe_complete';
export const OLD_MEMORY_WIPE_FAILED_EVENT = 'memory_old_memory_wipe_failed';

export const OLD_MEMORY_WIPE_HOOKS = [
  'agents:list-ids',
  'storage:get',
  'storage:set',
  'workspace:purge',
  'memory:facts:clear',
] as const;

const SESSION_ID = 'memory-old-memory-wipe';
// The same system identity every other boot-time path uses for storage:*.
// The destructive per-agent hooks key on `ctx.agentId` only (the workspace
// backends' `requireAgent`, the facts engines' `agentScopeKey`), so no real
// user is needed and `agents:resolve` is deliberately not consulted.
const SYSTEM_USER_ID = 'system';

type Step = 'cohort' | 'purge' | 'facts-clear' | 'export-volume' | 'marker' | 'complete';

export interface OldMemoryWipeOptions {
  /** The plugin's export volume, when one is configured. */
  volume?: MemoryVolumeConfig;
  /** One JSON log line per call. Defaults to stderr. */
  writeLine?: (line: string) => void;
}

export type OldMemoryWipeResult =
  | { skipped: true }
  | { skipped: false; agents: number; pathsRemoved: number; factsRemoved: number };

function failure(step: Step, agentId: string | undefined, cause: unknown): PluginError {
  const who = agentId === undefined ? '' : ` for agent ${JSON.stringify(agentId)}`;
  const why = cause instanceof Error ? cause.message : String(cause);
  return new PluginError({
    code: 'old-memory-wipe-failed',
    plugin: PLUGIN_NAME,
    message: `old memory wipe failed${who} at step '${step}': ${why}`,
    cause,
  });
}

function malformed(message: string): Error {
  return new Error(message);
}

async function readMarker(
  bus: HookBus,
  ctx: AgentContext,
  key: string,
): Promise<Uint8Array | undefined> {
  const reply = await bus.call<{ key: string }, { value: Uint8Array | undefined } | undefined>(
    'storage:get',
    ctx,
    { key },
  );
  if (reply === null || typeof reply !== 'object') {
    throw malformed('storage:get returned no result');
  }
  const { value } = reply;
  if (value !== undefined && !(value instanceof Uint8Array)) {
    throw malformed('storage:get returned a non-binary value');
  }
  return value;
}

const isSet = (v: Uint8Array | undefined): boolean => v !== undefined && v.length > 0;

async function writeMarker(
  bus: HookBus,
  ctx: AgentContext,
  key: string,
  value: string,
): Promise<void> {
  await bus.call<{ key: string; value: Uint8Array }, unknown>('storage:set', ctx, {
    key,
    value: new TextEncoder().encode(value),
  });
}

function validateIds(ids: unknown, source: string): string[] {
  if (!Array.isArray(ids)) throw malformed(`${source} is not an array of agent ids`);
  for (const [i, id] of ids.entries()) {
    if (typeof id !== 'string' || id.trim() === '' || isOwnerlessId(id)) {
      throw malformed(`${source}[${i}] is not an agent id`);
    }
  }
  return ids as string[];
}

function parseCohort(raw: Uint8Array): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw malformed('the stored cohort is not valid JSON');
  }
  const ids = validateIds(parsed, 'stored cohort');
  if (new Set(ids).size !== ids.length) throw malformed('the stored cohort has duplicate ids');
  return ids;
}

function validatePurgeReply(reply: unknown): WorkspacePurgeOutput {
  const parsed = WorkspacePurgeOutputSchema.safeParse(reply);
  if (!parsed.success) throw malformed('workspace:purge returned an invalid shape');
  return parsed.data;
}

function validateClearReply(reply: unknown): number {
  const removed = (reply as { removed?: unknown } | null | undefined)?.removed;
  if (typeof removed !== 'number' || !Number.isSafeInteger(removed) || removed < 0) {
    throw malformed('memory:facts:clear returned no valid removed count');
  }
  return removed;
}

async function countSlotFiles(dir: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let n = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) n += await countSlotFiles(join(dir, entry.name));
    else n += 1;
  }
  return n;
}

/**
 * Empty one agent's export-volume slot through the existing projection sync
 * (an empty desired set deletes every facts file in the slot). A slot that
 * does not exist is left uncreated. Returns files removed (before − after).
 */
async function emptyVolumeSlot(volume: MemoryVolumeConfig, agentId: string): Promise<number> {
  const slot = join(resolve(volume.hostRoot), volumeAgentKey(agentId));
  const present = await fs.lstat(slot).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false;
      throw err;
    },
  );
  if (!present) return 0;
  const factsDir = join(slot, ...MEMORY_FACTS_EXPORT_ROOT.split('/'));
  const before = await countSlotFiles(factsDir);
  await syncFactsVolume(volume, agentId, new Map());
  const after = await countSlotFiles(factsDir);
  return before - after;
}

export async function runOldMemoryWipe(
  bus: HookBus,
  opts: OldMemoryWipeOptions = {},
): Promise<OldMemoryWipeResult> {
  const writeLine = opts.writeLine ?? ((line: string) => process.stderr.write(line + '\n'));
  const logger: Logger = createLogger({ reqId: SESSION_ID, writer: writeLine });
  const systemCtx = makeAgentContext({
    sessionId: SESSION_ID,
    agentId: PLUGIN_NAME,
    userId: SYSTEM_USER_ID,
    logger,
  });

  // 1. Done already? One read, nothing else.
  let complete: Uint8Array | undefined;
  try {
    complete = await readMarker(bus, systemCtx, OLD_MEMORY_WIPE_COMPLETE_KEY);
  } catch (err) {
    throw failure('marker', undefined, err);
  }
  if (isSet(complete)) return { skipped: true };

  // 2. The cohort: read it, or list + store it BEFORE anything destructive.
  let cohort: string[];
  const doneBefore = new Set<string>();
  try {
    const stored = await readMarker(bus, systemCtx, OLD_MEMORY_WIPE_COHORT_KEY);
    if (stored !== undefined) {
      cohort = parseCohort(stored);
    } else {
      const reply = await bus.call<Record<string, never>, { agentIds?: unknown } | undefined>(
        'agents:list-ids',
        systemCtx,
        {},
      );
      const listed = validateIds(reply?.agentIds, 'agents:list-ids agentIds');
      cohort = [...new Set(listed)].sort();
      await writeMarker(bus, systemCtx, OLD_MEMORY_WIPE_COHORT_KEY, JSON.stringify(cohort));
    }
    for (const agentId of cohort) {
      if (isSet(await readMarker(bus, systemCtx, oldMemoryWipeDoneKey(agentId)))) {
        doneBefore.add(agentId);
      }
    }
  } catch (err) {
    throw failure('cohort', undefined, err);
  }

  logger.info(OLD_MEMORY_WIPE_STARTED_EVENT, {
    cohortSize: cohort.length,
    alreadyDone: doneBefore.size,
  });

  // 3. One agent at a time; stop at the first failure.
  const purgeInput: WorkspacePurgeInput = {
    prefixes: [...OLD_MEMORY_WIPE_PREFIXES],
    keep: [...OLD_MEMORY_WIPE_KEEP],
  };
  let agents = 0;
  let pathsRemoved = 0;
  let factsRemoved = 0;
  for (const agentId of cohort) {
    if (doneBefore.has(agentId)) continue;
    const ctx = makeAgentContext({
      sessionId: SESSION_ID,
      agentId,
      userId: SYSTEM_USER_ID,
      logger,
    });
    let step: Step = 'purge';
    try {
      const purged = validatePurgeReply(
        await bus.call<WorkspacePurgeInput, unknown>('workspace:purge', ctx, purgeInput),
      );
      step = 'facts-clear';
      const removed = validateClearReply(
        await bus.call<Record<string, never>, unknown>('memory:facts:clear', ctx, {}),
      );
      step = 'export-volume';
      const exportFilesRemoved =
        opts.volume === undefined ? 0 : await emptyVolumeSlot(opts.volume, agentId);
      logger.info(OLD_MEMORY_WIPED_EVENT, {
        agentId,
        workspacePathsRemoved: purged.purged,
        workspacePathsRemovedCount: purged.purged.length,
        pastVersionsChanged: purged.pastVersionsChanged,
        factsRemoved: removed,
        exportFilesRemoved,
      });
      step = 'marker';
      await writeMarker(bus, systemCtx, oldMemoryWipeDoneKey(agentId), new Date().toISOString());
      agents += 1;
      pathsRemoved += purged.purged.length;
      factsRemoved += removed;
    } catch (err) {
      logger.error(OLD_MEMORY_WIPE_FAILED_EVENT, { agentId, step });
      throw failure(step, agentId, err);
    }
  }

  // 4. Every cohort agent is done.
  try {
    await writeMarker(bus, systemCtx, OLD_MEMORY_WIPE_COMPLETE_KEY, new Date().toISOString());
  } catch (err) {
    throw failure('complete', undefined, err);
  }
  logger.info(OLD_MEMORY_WIPE_COMPLETE_EVENT, {
    cohortSize: cohort.length,
    agents,
    pathsRemoved,
    factsRemoved,
  });
  return { skipped: false, agents, pathsRemoved, factsRemoved };
}
