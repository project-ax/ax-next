import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { sql, type Kysely } from 'kysely';

import {
  createTestHarness,
  startTestContainer,
  stopPostgresContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createAgentsPlugin } from '@ax/agents';
import { createConversationsPlugin } from '@ax/conversations';
import { createAttachmentsPlugin } from '@ax/attachments';
import { createSessionPostgresPlugin } from '@ax/session-postgres';
import type { AgentInput, CreateOutput as AgentCreateOutput } from '@ax/agents';

// ---------------------------------------------------------------------------
// TASK-718 — deleting an agent leaves nothing of it in the database.
//
// The prod walk (TASK-346 W8) deleted one throwaway agent and found rows left in
// seven tables. Every plugin now has its own test that fires `agents:deleted` at
// it; this is the one that goes through the REAL `agents:delete` and lets the
// REAL plugins react to each other, because two of the seven are only reachable
// that way: @ax/attachments knows conversation ids and nothing about agents, so
// its rows go only when @ax/conversations' purge announces
// `conversations:purged`.
//
// Then, instead of trusting a list of tables, it asks the DATABASE. Every column
// named agent_id / conversation_id / session_id in the schema is checked for a
// row that belongs to the deleted agent, so a table nobody thought to list is
// caught too. A second agent (same user) is seeded alongside, and its rows must
// all survive: a delete that removed too much would otherwise pass.
//
// What this does not do: run the k8s reclaim pod (needs a cluster; the script is
// covered by sandbox-k8s' shell tests) or load the plugins whose own tests cover
// them (skills, connectors, memory facts, ...). The static guard in
// scripts/__tests__/agent-keyed-tables-are-cleaned.test.js keeps that list honest.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
let harness: TestHarness | undefined;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  await harness?.close({ onError: () => {} });
  if (container) await stopPostgresContainer(container);
});

const USER = 'user-1';
const AGENT_CONFIG = {
  displayName: 'Cleanup Agent',
  systemPromptAugment: 'be helpful',
  allowedTools: ['file.read'],
  mcpConfigIds: [],
  model: 'anthropic/claude-sonnet-4-7',
  runner: 'claude-sdk',
};

function agentInput(name: string): AgentInput {
  return {
    displayName: name,
    allowedTools: ['bash.run'],
    mcpConfigIds: [],
    model: 'anthropic/claude-opus-4-7',
    visibility: 'personal',
  };
}

const emptyHash = () => createHash('sha256').digest('hex');

interface Seeded {
  agentId: string;
  conversationIds: string[];
  sessionIds: string[];
}

/** Everything one agent owns across the seven tables the walk found rows in. */
async function seedAgent(h: TestHarness, name: string): Promise<Seeded> {
  const ctx = h.ctx({ userId: USER });
  const created = await h.bus.call<unknown, AgentCreateOutput>('agents:create', ctx, {
    actor: { userId: USER, isAdmin: false },
    input: agentInput(name),
  });
  const agentId = created.agent.id;

  const conversationIds: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const conv = await h.bus.call<unknown, { conversationId: string }>('conversations:create', ctx, {
      userId: USER,
      agentId,
    });
    conversationIds.push(conv.conversationId);
    await h.bus.call('conversations:append-event', ctx, {
      conversationId: conv.conversationId,
      kind: 'turn',
      role: 'user',
      payload: { blocks: [{ type: 'text', text: `hello from ${name}` }] },
    });
    await h.bus.call('conversations:append-transcript', ctx, {
      conversationId: conv.conversationId,
      fromSeq: 0,
      prefixHash: emptyHash(),
      lines: [JSON.stringify({ role: 'user', content: `hello from ${name}` })],
    });
  }

  // Attachments rows: nothing in the product writes these without a blob store,
  // and the rows are all this test is about, so seed them directly.
  const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    ctx,
    {},
  );
  for (const conversationId of conversationIds) {
    for (const table of ['attachments_v1_artifacts', 'attachments_v1_files']) {
      const idColumn = table === 'attachments_v1_artifacts' ? 'artifact_id' : 'attachment_id';
      await sql`
        INSERT INTO ${sql.table(table)}
          (${sql.ref(idColumn)}, conversation_id, user_id, sha256, path, display_name, media_type, size_bytes)
        VALUES
          (${`${table}-${conversationId}`}, ${conversationId}, ${USER}, ${'ab'.repeat(32)},
           ${'notes.txt'}, ${'notes.txt'}, ${'text/plain'}, ${5})
      `.execute(db);
    }
  }

  // One live session (with an inbox entry) and one already terminated.
  const sessionIds: string[] = [];
  for (const [i, terminate] of [false, true].entries()) {
    const sessionId = `sess-${agentId}-${i}`;
    await h.bus.call('session:create', ctx, {
      sessionId,
      workspaceRoot: '/tmp/ws',
      owner: {
        userId: USER,
        agentId,
        agentConfig: AGENT_CONFIG,
        conversationId: conversationIds[i] ?? null,
      },
    });
    await h.bus.call('session:queue-work', ctx, {
      sessionId,
      entry: { type: 'cancel' },
    });
    if (terminate) await h.bus.call('session:terminate', ctx, { sessionId });
    sessionIds.push(sessionId);
  }
  return { agentId, conversationIds, sessionIds };
}

/** `{ table.column -> rows that mention one of these ids }` over the WHOLE schema. */
async function rowsMentioning(
  client: pg.Client,
  ids: { agentIds: string[]; conversationIds: string[]; sessionIds: string[] },
): Promise<Record<string, number>> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND c.column_name IN ('agent_id', 'conversation_id', 'session_id')
      ORDER BY 1, 2`,
  );
  const wanted: Record<string, string[]> = {
    agent_id: ids.agentIds,
    conversation_id: ids.conversationIds,
    session_id: ids.sessionIds,
  };
  const out: Record<string, number> = {};
  for (const { table_name, column_name } of rows) {
    const values = wanted[column_name] ?? [];
    if (values.length === 0) continue;
    const res = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table_name}" WHERE "${column_name}" = ANY($1::text[])`,
      [values],
    );
    out[`${table_name}.${column_name}`] = Number(res.rows[0]?.n ?? 0);
  }
  return out;
}

describe('deleting an agent through agents:delete leaves nothing of it in the database (TASK-718)', () => {
  it('removes every row keyed on the agent, its conversations and its sessions, and touches nothing else', async () => {
    harness = await createTestHarness({
      services: {
        // @ax/agents mounts admin routes; this test drives the bus directly.
        'http:register-route': async () => ({ unregister: () => {} }),
        'auth:require-user': async () => {
          throw new Error('auth:require-user is not exercised by this test');
        },
        // @ax/attachments declares blob hooks; no bytes move here.
        'blob:put': async () => ({}),
        'blob:get': async () => ({}),
        'blob:stat': async () => ({ found: false }),
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createAgentsPlugin(),
        createConversationsPlugin(),
        createAttachmentsPlugin({ janitorIntervalSeconds: 3600 }),
        createSessionPostgresPlugin({ connectionString }),
      ],
    });
    const h = harness;

    const doomed = await seedAgent(h, 'Doomed');
    const control = await seedAgent(h, 'Control');

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const doomedIds = {
        agentIds: [doomed.agentId],
        conversationIds: doomed.conversationIds,
        sessionIds: doomed.sessionIds,
      };
      const controlIds = {
        agentIds: [control.agentId],
        conversationIds: control.conversationIds,
        sessionIds: control.sessionIds,
      };

      // The seed must have landed in every table the walk named, or "nothing
      // left" below would be true of an empty database.
      const walkTables = [
        'conversations_v1_conversations.conversation_id',
        'conversations_v1_events.conversation_id',
        'conversations_v1_transcripts.conversation_id',
        'attachments_v1_artifacts.conversation_id',
        'attachments_v1_files.conversation_id',
        'session_postgres_v1_sessions.session_id',
        'session_postgres_v1_inbox.session_id',
        'session_postgres_v2_session_agent.session_id',
      ];
      const before = await rowsMentioning(client, doomedIds);
      const controlBefore = await rowsMentioning(client, controlIds);
      for (const key of walkTables) {
        expect(before[key], `seed missing for the doomed agent in ${key}`).toBeGreaterThan(0);
        expect(controlBefore[key], `seed missing for the control agent in ${key}`).toBeGreaterThan(0);
      }

      await h.bus.call('agents:delete', h.ctx({ userId: USER }), {
        actor: { userId: USER, isAdmin: false },
        agentId: doomed.agentId,
      });

      const after = await rowsMentioning(client, doomedIds);
      const leftovers = Object.entries(after).filter(([, n]) => n > 0);
      expect(leftovers, 'rows still keyed on the deleted agent').toEqual([]);

      // The other agent lost nothing, table for table.
      const controlAfter = await rowsMentioning(client, controlIds);
      expect(controlAfter).toEqual(controlBefore);
    } finally {
      await client.end().catch(() => {});
    }
  }, 180_000);
});
