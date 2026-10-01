import { PluginError, type AgentContext, type HookBus } from '@ax/core';

import { PLUGIN_NAME } from './plugin-name.js';
import { conversationOf } from './conversation.js';
import { STORAGE_GET_HOOK, STORAGE_SET_HOOK } from './incremental.js';
import type {
  MemoryRecallInput,
  MemoryRecallOutput,
  MemoryRecallReceipt,
  MemoryStatement,
  MemoryStatementKind,
  MemoryUsedStatement,
} from './types.js';

/**
 * Bounded, owner-scoped snapshots of retrieved candidates and explicit usage.
 * Retrieval is not usage: pending candidates never reach the answer chip.
 * Writes and selections share a per-key queue on the single-replica host.
 * Version 1 receipts represented retrieval, so they cannot establish usage.
 */

export const MEMORY_RECALL_RECEIPTS_HOOK = 'memory:recall-receipts';

/** Emitted (warn) when recording or annotating a receipt fails. Never carries statement text. */
export const RECALL_RECEIPT_FAILED_EVENT = 'memory_recall_receipt_failed';

export const RECALL_RECEIPTS_CAP = 50;

/** At most this many history reads per `memory:recall-receipts` call. */
export const MAX_STATUS_SUBJECTS = 10;

export const MAX_CONVERSATION_ID_CHARS = 256;

const STORED_VERSION = 2;

interface StoredReceipt extends MemoryRecallReceipt {
  recallId?: string;
  selected: boolean;
  usedIds?: string[];
}

interface StoredReceipts {
  v: 2;
  agentId: string;
  userId: string;
  receipts: StoredReceipt[];
}

export function recallReceiptsKey(conversationId: string): string {
  return `memory:recall-receipts:${conversationId}`;
}

function hasStorage(bus: HookBus): boolean {
  return bus.hasService(STORAGE_GET_HOOK) && bus.hasService(STORAGE_SET_HOOK);
}

const KINDS: readonly MemoryStatementKind[] = ['world', 'experience', 'observation', 'opinion'];

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/**
 * The used-statement projection of one row. Fields copied one at a time —
 * never a spread — so a field added to `MemoryStatement` later does not ride
 * into storage (or out to a browser) without someone choosing it. Also the
 * reader for stored rows: anything malformed is `undefined`.
 */
function toUsedStatement(row: unknown): MemoryUsedStatement | undefined {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined;
  const r = row as Record<string, unknown>;
  if (!isString(r.id) || !isString(r.about) || !isString(r.relation) || !isString(r.value) || !isString(r.when)) {
    return undefined;
  }
  const out: MemoryUsedStatement = {
    id: r.id,
    about: r.about,
    relation: r.relation,
    value: r.value,
    when: r.when,
  };
  if (isString(r.until)) out.until = r.until;
  if (isString(r.kind) && KINDS.includes(r.kind as MemoryStatementKind)) {
    out.kind = r.kind as MemoryStatementKind;
  }
  if (isString(r.slot)) out.slot = r.slot;
  if (r.savedBy === 'person' || r.savedBy === 'agent') out.savedBy = r.savedBy;
  if (isString(r.aboutText)) out.aboutText = r.aboutText;
  return out;
}

/** The stored list, or `undefined` when absent or unreadable. */
async function readStored(
  bus: HookBus,
  ctx: AgentContext,
  key: string,
): Promise<StoredReceipts | undefined> {
  const out = await bus.call<{ key: string }, { value?: Uint8Array } | null | undefined>(
    STORAGE_GET_HOOK,
    ctx,
    { key },
  );
  const value = out?.value;
  if (value === undefined || value === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(value));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const p = parsed as Record<string, unknown>;
  if (p.v !== STORED_VERSION || !isString(p.agentId) || !isString(p.userId) || !Array.isArray(p.receipts)) {
    return undefined;
  }
  const receipts: StoredReceipt[] = [];
  for (const raw of p.receipts as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (!isString(r.at) || !Array.isArray(r.statements)) continue;
    const statements = (r.statements as unknown[])
      .map(toUsedStatement)
      .filter((s): s is MemoryUsedStatement => s !== undefined);
    if (statements.length > 0) receipts.push({
      at: r.at, statements, selected: r.selected === true,
      ...(Array.isArray(r.usedIds) && r.usedIds.every(isString) ? { usedIds: r.usedIds } : {}),
      ...(isString(r.recallId) ? { recallId: r.recallId } : {}),
    });
  }
  return { v: STORED_VERSION, agentId: p.agentId, userId: p.userId, receipts };
}

function warn(ctx: AgentContext, stage: 'record' | 'status', err: unknown): void {
  // Static fields only: statement text is untrusted dialogue, and an error
  // message may quote it.
  ctx.logger.warn(RECALL_RECEIPT_FAILED_EVENT, {
    stage,
    errorName: err instanceof Error ? err.name : typeof err,
  });
}

interface RecallReceiptRecorder {
  /** Record one tool answer. Never throws, never rejects. */
  record(
    ctx: AgentContext,
    statements: readonly MemoryStatement[],
    at: string,
    recallId?: string,
  ): Promise<void>;
  select(ctx: AgentContext, recallId: string, ids: readonly string[]): Promise<void>;
}

/**
 * A recorder with its own per-key write chain. One per bus (see
 * `recordRecallReceipt`), so two hosts in one process never serialize
 * against each other.
 */
function createRecallReceiptRecorder(bus: HookBus): RecallReceiptRecorder {
  const tails = new Map<string, Promise<void>>();

  const append = async (
    ctx: AgentContext,
    key: string,
    receipt: StoredReceipt,
  ): Promise<void> => {
    const stored = await readStored(bus, ctx, key);
    // A list recorded for anyone else is not ours to extend — and never
    // something to carry over into ours. Start fresh.
    const previous =
      stored !== undefined && stored.agentId === ctx.agentId && stored.userId === ctx.userId
        ? stored.receipts
        : [];
    const receipts = [...previous, receipt].slice(-RECALL_RECEIPTS_CAP);
    const next: StoredReceipts = {
      v: STORED_VERSION,
      agentId: ctx.agentId,
      userId: ctx.userId,
      receipts,
    };
    await bus.call<{ key: string; value: Uint8Array }, unknown>(STORAGE_SET_HOOK, ctx, {
      key,
      value: new TextEncoder().encode(JSON.stringify(next)),
    });
  };

  const enqueue = async (key: string, action: () => Promise<void>): Promise<void> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(action);
    tails.set(key, work);
    try { await work; } finally {
      if (tails.get(key) === work) tails.delete(key);
    }
  };

  return {
    async select(ctx, recallId, ids) {
      const conversationId = conversationOf(ctx);
      if (!conversationId || !hasStorage(bus)) return;
      const key = recallReceiptsKey(conversationId);
      await enqueue(key, async () => {
        const stored = await readStored(bus, ctx, key);
        const receipt = stored?.agentId === ctx.agentId && stored.userId === ctx.userId
          ? stored.receipts.find((r) => r.recallId === recallId) : undefined;
        if (!receipt || ids.some((id) => !receipt.statements.some((s) => s.id === id))) {
          throw new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME,
            hookName: 'tool:execute:memory_use', message: 'Select only IDs from this conversation’s recall result' });
        }
        if (receipt.selected) {
          if (receipt.usedIds?.length === new Set(ids).size &&
              receipt.usedIds.every((id) => ids.includes(id))) return;
          throw new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME,
            hookName: 'tool:execute:memory_use', message: 'This recall result already has recorded sources' });
        }
        // A selection is final and idempotent. No new row text or owner scope
        // can be supplied by the model. Preserve the retrieval timestamp.
        receipt.usedIds = [...new Set(ids)];
        receipt.selected = true;
        await bus.call(STORAGE_SET_HOOK, ctx, {
          key, value: new TextEncoder().encode(JSON.stringify(stored)),
        });
      });
    },
    async record(ctx, statements, at, recallId) {
      try {
        const conversationId = conversationOf(ctx);
        if (conversationId === undefined || conversationId === '') return;
        if (typeof ctx.userId !== 'string' || ctx.userId === '') return;
        if (typeof ctx.agentId !== 'string' || ctx.agentId === '') return;
        if (statements.length === 0) return;
        if (!hasStorage(bus)) return;

        const snapshot = statements
          .map(toUsedStatement)
          .filter((s): s is MemoryUsedStatement => s !== undefined);
        if (snapshot.length === 0) return;

        const key = recallReceiptsKey(conversationId);
        await enqueue(key, () => append(ctx, key, {
          at, statements: snapshot, selected: recallId === undefined,
          ...(recallId !== undefined ? { recallId } : {}),
        }));
      } catch (err) {
        try {
          warn(ctx, 'record', err);
        } catch {
          // A logger that throws must not fail the tool either.
        }
      }
    },
  };
}

/** One recorder (so one write chain) per bus — see `createRecallReceiptRecorder`. */
const recorders = new WeakMap<HookBus, RecallReceiptRecorder>();

/**
 * Snapshot recalled candidates (recallId supplied), or confirmed usage, inside
 * a conversation. Never throws. Skips a routine turn (`conversationOf`), a
 * caller with no user, an empty answer, and a host without `storage:*`.
 */
export async function recordRecallReceipt(
  bus: HookBus,
  ctx: AgentContext,
  statements: readonly MemoryStatement[],
  at: string,
  recallId?: string,
): Promise<void> {
  let recorder = recorders.get(bus);
  if (recorder === undefined) {
    recorder = createRecallReceiptRecorder(bus);
    recorders.set(bus, recorder);
  }
  await recorder.record(ctx, statements, at, recallId);
}

/** Mark a retrieved snapshot as used, selecting only its own rows. */
export async function selectRecallReceipt(
  bus: HookBus, ctx: AgentContext, recallId: string, ids: readonly string[],
): Promise<void> {
  let recorder = recorders.get(bus);
  if (recorder === undefined) {
    recorder = createRecallReceiptRecorder(bus);
    recorders.set(bus, recorder);
  }
  await recorder.select(ctx, recallId, ids);
}

/**
 * The caller's receipts for one conversation, each row annotated with
 * `closedSince` when it has been closed since.
 *
 * The caller has already validated input and resolved access. Returns `[]`
 * when there is no storage, nothing stored, or the stored list belongs to a
 * different agent or user.
 *
 * `closedSince` comes from at most {@link MAX_STATUS_SUBJECTS} history reads
 * through this plugin's own `memory:recall` (so the same owner scope and the
 * same closure vocabulary apply), over the distinct subjects of the most
 * recent receipts first. `about` is passed through verbatim: a stored subject
 * is already post-rewrite (`user:<id>`), which `memory:recall` leaves alone
 * — only the literal `user` is rewritten. A row that is not found stays
 * without `closedSince`; a failed read is logged and skipped.
 */
export async function readRecallReceipts(
  bus: HookBus,
  ctx: AgentContext,
  conversationId: string,
  recallLimit: number,
): Promise<MemoryRecallReceipt[]> {
  if (!hasStorage(bus)) return [];
  const stored = await readStored(bus, ctx, recallReceiptsKey(conversationId));
  if (stored === undefined) return [];
  if (stored.agentId !== ctx.agentId || stored.userId !== ctx.userId) return [];
  const selected = stored.receipts.filter((r) => r.selected).map((r) => ({
    ...r, statements: r.statements.filter((s) => r.usedIds === undefined || r.usedIds.includes(s.id)),
  })).filter((r) => r.statements.length > 0);
  if (selected.length === 0) return [];

  const subjects: string[] = [];
  for (const receipt of [...selected].reverse()) {
    for (const s of receipt.statements) {
      if (subjects.length >= MAX_STATUS_SUBJECTS) break;
      if (!subjects.includes(s.about)) subjects.push(s.about);
    }
  }

  const closures = new Map<string, 'replaced' | 'forgotten' | 'retracted'>();
  for (const about of subjects) {
    try {
      const out = await bus.call<MemoryRecallInput, MemoryRecallOutput>('memory:recall', ctx, {
        about,
        activeOnly: false,
        limit: recallLimit,
      });
      if (out == null || !Array.isArray(out.statements)) continue;
      for (const row of out.statements) {
        const c = row?.closure;
        if (c === 'replaced' || c === 'forgotten' || c === 'retracted') closures.set(row.id, c);
      }
    } catch (err) {
      warn(ctx, 'status', err);
    }
  }

  return selected.map((receipt) => ({
    at: receipt.at,
    statements: receipt.statements.map((s) => {
      const closedSince = closures.get(s.id);
      return closedSince !== undefined ? { ...s, closedSince } : s;
    }),
  }));
}
