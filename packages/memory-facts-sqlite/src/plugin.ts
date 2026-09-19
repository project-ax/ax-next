import { randomUUID } from 'node:crypto';
import { PluginError, type Plugin } from '@ax/core';
import type {
  RecordInput,
  RecordOutput,
  RecordedStatement,
  FactStatementInput,
  RecallInput,
  RecallOutput,
  FactRecord,
  SupersedeInput,
  SupersedeOutput,
  ClearInput,
  Provenance,
} from '@ax/memory-facts-contract';
import { openDatabase, TABLE, INFINITY_SENTINEL, type FactRow } from './schema.js';
import { insertWithSlotClosure, supersedeIds } from './closure.js';
import { agentScopeKey } from './agent-scope-key.js';
import type { Database as BetterSqliteDb } from 'better-sqlite3';

const PLUGIN_NAME = '@ax/memory-facts-sqlite';

// Hard upper bound on `limit`, mirroring `@ax/memory-strata-index-sqlite`'s
// MAX_TOP_K — a non-positive limit is a real risk to clamp/reject rather
// than let through to `LIMIT -1` (unbounded in SQLite).
const MAX_LIMIT = 200;

const PROVENANCES: readonly Provenance[] = ['extracted', 'agent', 'human'];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// Every closure decision (rules 1-4, closure.ts) and recall's ORDER BY compare
// `when` lexicographically, which equals chronological order ONLY for a
// normalized ISO-8601 Z-suffixed instant — an unpadded date or epoch millis
// would silently mis-bound the (about, slot) chain with no error. `record`
// is the observer's door (default provenance `extracted` = model output),
// so this is a real trust-boundary check (Invariant 5), not decoration.
//
// The offset must be EXPLICIT (`Z` or `+HH:MM`/`-HH:MM`) rather than just
// "whatever Date.parse accepts": a bare local-time string like
// `2023-06-01T12:00:00` (no offset) parses as HOST-LOCAL time, so
// `.toISOString()` would silently shift the stored instant by the server's
// timezone — a correctness bug that varies by deployment, not just a loose
// message. Rejecting it here keeps the normalized value deployment-
// independent.
const EXPLICIT_OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function normalizeIsoInstant(field: string, value: string): string {
  const ms = Date.parse(value);
  if (!EXPLICIT_OFFSET_ISO.test(value) || !Number.isFinite(ms)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `statement.${field} must be an ISO-8601 instant with an explicit Z or +/-HH:MM offset`,
    });
  }
  return new Date(ms).toISOString();
}

function validateStatement(input: unknown): FactStatementInput {
  if (typeof input !== 'object' || input === null) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'statement must be an object',
    });
  }
  const s = input as Record<string, unknown>;
  for (const field of ['about', 'relation', 'value', 'when'] as const) {
    if (!isNonEmptyString(s[field])) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: `statement.${field} must be a non-empty string`,
      });
    }
  }
  const when = normalizeIsoInstant('when', s.when as string);
  if (s.slot !== undefined && !isNonEmptyString(s.slot)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'statement.slot must be a non-empty string when set',
    });
  }
  if (s.provenance !== undefined && !PROVENANCES.includes(s.provenance as Provenance)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: "statement.provenance must be 'extracted', 'agent', or 'human' when set",
    });
  }
  if (s.ownerUserId !== undefined && typeof s.ownerUserId !== 'string') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'statement.ownerUserId must be a string when set',
    });
  }
  if (s.conversationId !== undefined && typeof s.conversationId !== 'string') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'statement.conversationId must be a string when set',
    });
  }
  return { ...s, when } as unknown as FactStatementInput;
}

function validateRecordInput(input: RecordInput): FactStatementInput[] {
  if (typeof input !== 'object' || input === null || !Array.isArray(input.statements)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'statements must be an array',
    });
  }
  return input.statements.map(validateStatement);
}

function validateRecallInput(input: RecallInput): { about?: string; limit: number } {
  if (
    typeof input.limit !== 'number' ||
    !Number.isFinite(input.limit) ||
    input.limit < 1
  ) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'limit must be a positive number',
    });
  }
  if (input.about !== undefined && typeof input.about !== 'string') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'about must be a string when set',
    });
  }
  // `query` (free-text search) and `activeOnly: false` (history) are on the
  // contract's type for forward-compat (TASK-424, TASK-422) but this engine
  // doesn't implement either yet. Rejecting them loudly beats silently
  // returning fewer/more rows than a caller who read the type asked for.
  if (input.query !== undefined) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'query is not implemented yet (TASK-424) — omit it',
    });
  }
  if (input.activeOnly !== undefined && typeof input.activeOnly !== 'boolean') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'activeOnly must be a boolean when set',
    });
  }
  if (input.activeOnly === false) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'activeOnly: false (history) is not implemented yet (TASK-422) — omit it',
    });
  }
  return {
    ...(input.about !== undefined ? { about: input.about } : {}),
    limit: Math.min(Math.floor(input.limit), MAX_LIMIT),
  };
}

function rowToFactRecord(row: FactRow): FactRecord {
  return {
    id: row.id,
    about: row.about,
    relation: row.relation,
    value: row.value,
    when: row.valid_start,
    provenance: row.provenance,
    ...(row.valid_end !== INFINITY_SENTINEL ? { until: row.valid_end } : {}),
    ...(row.closed_by !== null ? { closedBy: row.closed_by } : {}),
  };
}

export interface MemoryFactsSqliteConfig {
  databasePath: string;
}

export function createMemoryFactsSqlitePlugin(config: MemoryFactsSqliteConfig): Plugin {
  let driver: BetterSqliteDb | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'memory:facts:record',
        'memory:facts:recall',
        'memory:facts:supersede',
        'memory:facts:clear',
      ],
      calls: [],
      subscribes: [],
    },

    init({ bus }) {
      const opened = openDatabase(config.databasePath);
      driver = opened.driver;

      // Every handler derives the per-agent scope key from the calling ctx
      // so the single shared sqlite db is partitioned by agentId alone
      // (mirrors @ax/memory-strata-index-sqlite's TASK-257 partition). The
      // hook I/O payloads stay unchanged — the key is ambient (from ctx),
      // never a wire field.
      bus.registerService<RecordInput, RecordOutput>(
        'memory:facts:record',
        PLUGIN_NAME,
        async (ctx, input) => {
          const statements = validateRecordInput(input);
          const agentKey = agentScopeKey(ctx);
          const now = new Date().toISOString();

          const records: RecordedStatement[] = statements.map((statement) => {
            const id = randomUUID();
            const closure = insertWithSlotClosure(driver!, agentKey, {
              id,
              about: statement.about,
              relation: statement.relation,
              value: statement.value,
              when: statement.when,
              provenance: statement.provenance ?? 'extracted',
              transactionTime: now,
              ...(statement.slot !== undefined ? { slot: statement.slot } : {}),
              ...(statement.ownerUserId !== undefined
                ? { ownerUserId: statement.ownerUserId }
                : {}),
              ...(statement.conversationId !== undefined
                ? { conversationId: statement.conversationId }
                : {}),
            });

            return {
              id,
              about: statement.about,
              relation: statement.relation,
              value: statement.value,
              when: statement.when,
              provenance: statement.provenance ?? 'extracted',
              closes: closure.closed,
              ...(closure.selfClosedAt !== null ? { until: closure.selfClosedAt } : {}),
              ...(closure.selfClosedBy !== null ? { closedBy: closure.selfClosedBy } : {}),
            };
          });

          return { records };
        },
      );

      bus.registerService<RecallInput, RecallOutput>(
        'memory:facts:recall',
        PLUGIN_NAME,
        async (ctx, input) => {
          const { about, limit } = validateRecallInput(input);
          const agentKey = agentScopeKey(ctx);

          // The activeOnly-only cut (TASK-421 scope decision): always
          // filters to currently-active rows regardless of `input.
          // activeOnly`'s value, and never consults `input.query` — no
          // FTS/dense/RRF/rerank here (TASK-424).
          const rows = about !== undefined
            ? (driver!
                .prepare(
                  `SELECT * FROM ${TABLE}
                    WHERE agent_key = ? AND about = ? AND valid_end = ?
                    ORDER BY valid_start DESC LIMIT ?`,
                )
                .all(agentKey, about, INFINITY_SENTINEL, limit) as FactRow[])
            : (driver!
                .prepare(
                  `SELECT * FROM ${TABLE}
                    WHERE agent_key = ? AND valid_end = ?
                    ORDER BY valid_start DESC LIMIT ?`,
                )
                .all(agentKey, INFINITY_SENTINEL, limit) as FactRow[]);

          return { statements: rows.map(rowToFactRecord), degraded: [] };
        },
      );

      bus.registerService<SupersedeInput, SupersedeOutput>(
        'memory:facts:supersede',
        PLUGIN_NAME,
        async (ctx, input) => {
          if (!Array.isArray(input.ids)) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'ids must be an array',
            });
          }
          const agentKey = agentScopeKey(ctx);
          const at = new Date().toISOString();
          const closed = supersedeIds(driver!, agentKey, input.ids, at);
          return { closed };
        },
      );

      bus.registerService<ClearInput, void>(
        'memory:facts:clear',
        PLUGIN_NAME,
        async (ctx, _input) => {
          const agentKey = agentScopeKey(ctx);
          driver!.prepare(`DELETE FROM ${TABLE} WHERE agent_key = ?`).run(agentKey);
        },
      );
    },

    shutdown() {
      if (driver !== undefined && driver.open) {
        driver.close();
      }
      driver = undefined;
    },
  };
}
