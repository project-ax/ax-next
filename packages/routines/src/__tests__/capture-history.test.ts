import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';
import { makeAgentContext } from '@ax/core';
import { taskCaptureVeto } from '../capture.js';
import { createRoutinesStore } from '../store.js';
import type { RoutinesDatabase } from '../migrations.js';

// Execute the production Kysely query on a real SQL engine without Docker.
// This adapter changes only the native node:sqlite calling convention, never
// the classification predicate. PostgreSQL migration/acceptance has its own tests.
let sqlite: DatabaseSync;
let db: Kysely<RoutinesDatabase>;
let dispatchId = 0;
beforeEach(() => {
  dispatchId = 0;
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE routines_v1_definitions (agent_id TEXT, routine_id TEXT, kind TEXT);
    CREATE TABLE routines_v1_dispatches (
      dispatch_id TEXT, agent_id TEXT, routine_id TEXT,
      conversation_id TEXT, kind TEXT, report TEXT
    );
  `);
  db = new Kysely<RoutinesDatabase>({ dialect: new SqliteDialect({ database: {
    close: () => sqlite.close(),
    prepare(text) {
      const statement = sqlite.prepare(text);
      return {
        reader: statement.columns().length > 0,
        all: parameters => statement.all(...parameters as SQLInputValue[]),
        run: parameters => statement.run(...parameters as SQLInputValue[]),
        iterate: parameters => statement.iterate(...parameters as SQLInputValue[]),
      };
    },
  } }) });
});
afterEach(async () => { await db.destroy(); });

const definition = (kind: string, agentId = 'agent', routineId = 'routine') => {
  sqlite.prepare('INSERT INTO routines_v1_definitions VALUES (?, ?, ?)').run(agentId, routineId, kind);
};
const dispatch = (kind: string | null, options: {
  agentId?: string; conversationId?: string; routineId?: string; report?: string | null;
} = {}) => {
  sqlite.prepare('INSERT INTO routines_v1_dispatches VALUES (?, ?, ?, ?, ?, ?)')
    .run(`dispatch-${++dispatchId}`, options.agentId ?? 'agent', options.routineId ?? 'routine',
      options.conversationId ?? 'check-in', kind, options.report ?? null);
};
const capture = (conversationId = 'check-in', agentId = 'agent') => {
  // A later ordinary-person pass must consult persisted run history even
  // after a restart, rather than trusting this caller's source or identity.
  const ctx = makeAgentContext({ sessionId: 'capture', agentId, userId: 'new-owner', conversationId, source: 'user' });
  return taskCaptureVeto(createRoutinesStore(db), ctx, { conversationId });
};

describe('immutable run history gates capture (TASK-919)', () => {
  it.each(['stay-on-top', 'get-done'])('refuses an earlier %s check-in after its definition becomes repeat', async kind => {
    definition(kind);
    dispatch(kind, { report: '{"status":"on-track","update":"Agent-owned report"}' });
    expect(await capture()).toMatchObject({ rejected: true, reason: 'task-check-in' });
    sqlite.prepare("UPDATE routines_v1_definitions SET kind = 'repeat'").run();
    expect(await capture()).toMatchObject({ rejected: true, reason: 'task-check-in' });
  });

  it('refuses an unreported check-in after the definition changes', async () => {
    definition('repeat');
    dispatch('stay-on-top');
    expect(await capture()).toMatchObject({ rejected: true, reason: 'task-check-in' });
  });

  it.each([null, 'future-kind'])('refuses unknown accepted kind %s even beside a repeat definition', async kind => {
    definition('repeat');
    dispatch(kind);
    expect(await capture()).toMatchObject({ rejected: true, reason: 'task-check-in' });
  });

  it('retains a task refusal when its routine has been deleted', async () => {
    dispatch('get-done');
    expect(await capture()).toMatchObject({ rejected: true, reason: 'task-check-in' });
  });

  it('refuses mixed shared history if any accepted run was a task', async () => {
    definition('repeat');
    dispatch('repeat');
    dispatch('stay-on-top');
    expect(await capture()).toMatchObject({ rejected: true, reason: 'task-check-in' });
  });

  it('captures a known repeat run', async () => {
    definition('repeat');
    dispatch('repeat');
    expect(await capture()).toBeUndefined();
  });

  it('captures a known repeat run even when the definition later becomes a task', async () => {
    definition('get-done');
    dispatch('repeat');
    expect(await capture()).toBeUndefined();
  });

  it('captures a known repeat run after its definition is deleted', async () => {
    dispatch('repeat');
    expect(await capture()).toBeUndefined();
  });

  it('captures an ordinary web conversation and isolates another agent’s history', async () => {
    definition('stay-on-top', 'other-agent');
    dispatch('stay-on-top', { agentId: 'other-agent' });
    expect(await capture()).toBeUndefined();
    expect(await capture('ordinary-web', 'other-agent')).toBeUndefined();
    expect(await capture('check-in', 'other-agent')).toMatchObject({ rejected: true, reason: 'task-check-in' });
  });
});
