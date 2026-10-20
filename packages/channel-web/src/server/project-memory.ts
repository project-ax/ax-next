/**
 * W3d-2 — "Updated project memory" under an answer.
 *
 * `@ax/projects` answers `projects:conversation-changes` with every file
 * change this chat's agent turns recorded in the project, each stamped with
 * `turnAt` (the moment the turn ended). This module keeps the ones under
 * `memory/` — which files the chip shows is a UI rule, not the hook's — and
 * hangs them on the answer of the exchange open at `turnAt` (see
 * `exchanges.ts`; the same rule as the "Used N memories" chip).
 *
 * THE PAYLOAD IS ANOTHER PLUGIN'S (invariant 2 — no import from @ax/projects;
 * the types below are local and structural). Every field is checked and
 * copied one at a time, never spread, so nothing rides to the browser that
 * this file did not name.
 */
import type {
  ProjectMemoryFile,
  ProjectMemoryUpdate,
  ThreadMessage,
} from '../lib/workspace-types.js';
import { answerFor, buildExchanges, type ExchangeTurn } from './exchanges.js';

/** Only paths under this folder show on the chip. */
export const PROJECT_MEMORY_PREFIX = 'memory/';

/** One change as `projects:conversation-changes` reports it, checked. */
export interface ConversationChange {
  versionId: string;
  path: string;
  change: ProjectMemoryFile['change'];
  turnAt: string;
  undo: ProjectMemoryFile['undo'];
}

export interface ConversationChangesReply {
  canEdit: boolean;
  changes: ConversationChange[];
}

const CHANGES = new Set(['created', 'edited', 'deleted']);
const UNDOS = new Set(['available', 'changed-since', 'not-undoable']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate the `projects:conversation-changes` reply. Returns `null` for a
 * reply that is not the documented shape at all; a malformed individual
 * change is dropped rather than sinking the rest.
 */
export function parseConversationChangesReply(reply: unknown): ConversationChangesReply | null {
  if (!isRecord(reply) || typeof reply.canEdit !== 'boolean' || !Array.isArray(reply.changes)) {
    return null;
  }
  const changes: ConversationChange[] = [];
  for (const c of reply.changes as unknown[]) {
    if (!isRecord(c)) continue;
    const { versionId, path, change, turnAt, undo } = c;
    if (
      typeof versionId !== 'string' ||
      versionId.length === 0 ||
      typeof path !== 'string' ||
      path.length === 0 ||
      typeof change !== 'string' ||
      !CHANGES.has(change) ||
      typeof turnAt !== 'string' ||
      typeof undo !== 'string' ||
      !UNDOS.has(undo)
    ) {
      continue;
    }
    changes.push({
      versionId,
      path,
      change: change as ConversationChange['change'],
      turnAt,
      undo: undo as ConversationChange['undo'],
    });
  }
  return { canEdit: reply.canEdit, changes };
}

/**
 * Return a copy of `thread` with `projectMemory` set on each answer whose
 * exchange changed a `memory/` file. A path changed twice in one exchange is
 * listed once, as its LATER change (the reply is in recording order). Changes
 * that match no answer are dropped. Messages without changes are returned
 * untouched (same object).
 */
export function attachProjectMemory(
  thread: readonly ThreadMessage[],
  turns: readonly ExchangeTurn[],
  projectId: string,
  reply: ConversationChangesReply,
): ThreadMessage[] {
  const memory = reply.changes.filter((c) => c.path.startsWith(PROJECT_MEMORY_PREFIX));
  if (memory.length === 0) return [...thread];

  const exchanges = buildExchanges(thread, turns);
  const byAnswer = new Map<string, Map<string, ProjectMemoryFile>>();
  for (const c of memory) {
    const answerId = answerFor(exchanges, c.turnAt);
    if (answerId === null) continue;
    let files = byAnswer.get(answerId);
    if (files === undefined) {
      files = new Map();
      byAnswer.set(answerId, files);
    }
    // Delete first so the list's order follows each path's latest change.
    files.delete(c.path);
    files.set(c.path, { versionId: c.versionId, path: c.path, change: c.change, undo: c.undo });
  }

  return thread.map((m) => {
    if (m.kind !== 'agent' && m.kind !== 'steps') return m;
    const files = byAnswer.get(m.id);
    if (files === undefined || files.size === 0) return m;
    const projectMemory: ProjectMemoryUpdate = {
      projectId,
      canEdit: reply.canEdit,
      files: [...files.values()],
    };
    return { ...m, projectMemory };
  });
}
