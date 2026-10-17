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
import { createSharedFoldersPlugin } from '@ax/shared-folders';
import { createProjectsPlugin } from '@ax/projects';
import type { Plugin } from '@ax/core';
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
// W2 adds @ax/shared-folders: its grants table is keyed on agent_id with no FK
// (cross-plugin FKs are banned), so the whole-schema walk below is what proves
// the `agents:deleted` subscriber really removes the doomed agent's grants. Its
// folders table deliberately has NO agent column, so a tombstoned folder's row
// (which stays until a sandbox provider removes the bytes — none is loaded
// here) carries no agent id; that is asserted explicitly, since the walk cannot
// see it.
//
// W3a adds @ax/projects: a project is a folder plus a name, with NO agent
// column, so the walk can't see it either. A project whose folder the doomed
// agent owned alone must go (W2 tombstones the folder, fires
// `shared-folders:deleted`, projects drops the row and fires
// `projects:deleted`); one whose folder had an editor survives, owned by it.
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

/** The four shared folders `seedSharedFolders` creates, by what must happen to them. */
interface SeededFolders {
  /** Owned by the doomed agent, no editor: tombstoned when it is deleted. */
  tombstoned: string;
  /** Owned by the doomed agent, the control agent is an editor: ownership moves to the control. */
  transferred: string;
  /** Owned by the control agent, the doomed agent is a viewer: only the viewer grant goes. */
  controlOwned: string;
  /** Owned by the control agent alone: untouched. */
  controlOnly: string;
}

/**
 * Seed shared folders through the real hooks. `USER` owns both agents, so the
 * `agents:can-manage-sharing` / same-owner checks the plugin makes pass for
 * real — no raw SQL, so the rows are exactly what the product writes.
 */
async function seedSharedFolders(
  h: TestHarness,
  doomed: Seeded,
  control: Seeded,
): Promise<SeededFolders> {
  const ctx = h.ctx({ userId: USER });
  const create = async (ownerAgentId: string): Promise<string> =>
    (
      await h.bus.call<unknown, { folderId: string }>('shared-folders:create', ctx, {
        ownerAgentId,
      })
    ).folderId;
  const grant = async (folderId: string, agentId: string, role: 'editor' | 'viewer'): Promise<void> => {
    await h.bus.call('shared-folders:grant', ctx, { folderId, agentId, role });
  };

  const tombstoned = await create(doomed.agentId);
  const transferred = await create(doomed.agentId);
  await grant(transferred, control.agentId, 'editor');
  const controlOwned = await create(control.agentId);
  await grant(controlOwned, doomed.agentId, 'viewer');
  const controlOnly = await create(control.agentId);
  return { tombstoned, transferred, controlOwned, controlOnly };
}

/** The two projects `seedProjects` creates, both owned by the doomed agent. */
interface SeededProjects {
  /** No editor: removed with its folder when the doomed agent goes. */
  removed: string;
  /** The control agent is an editor: survives, owned by the control. */
  survives: string;
}

async function seedProjects(h: TestHarness, doomed: Seeded, control: Seeded): Promise<SeededProjects> {
  const ctx = h.ctx({ userId: USER });
  const create = async (name: string): Promise<{ projectId: string; folderId: string }> =>
    h.bus.call<unknown, { projectId: string; folderId: string }>('projects:create', ctx, {
      ownerAgentId: doomed.agentId,
      name,
    });
  const removed = await create('Doomed alone');
  const survives = await create('Shared with control');
  await h.bus.call('shared-folders:grant', ctx, {
    folderId: survives.folderId,
    agentId: control.agentId,
    role: 'editor',
  });
  return { removed: removed.projectId, survives: survives.projectId };
}

/** Records every `projects:deleted` payload. */
function projectsDeletedRecorder(seen: string[]): Plugin {
  const name = '@ax/preset-k8s/test/projects-deleted-recorder';
  return {
    manifest: { name, version: '0.0.0', registers: [], calls: [], subscribes: ['projects:deleted'] },
    init({ bus }) {
      bus.subscribe<{ projectId: string }>('projects:deleted', name, async (_ctx, payload) => {
        seen.push(payload.projectId);
        return undefined;
      });
    },
  };
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
    const projectsDeleted: string[] = [];
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
        createConversationsPlugin({ purgeSweepIntervalMs: 0 }),
        createAttachmentsPlugin({ janitorIntervalSeconds: 3600 }),
        createSessionPostgresPlugin({ connectionString }),
        // No timer: the sweep must not retry a tombstone mid-assertion. No
        // sandbox provider is loaded either, so the tombstone row stays.
        createSharedFoldersPlugin({ sweepIntervalMs: 0 }),
        createProjectsPlugin(),
        projectsDeletedRecorder(projectsDeleted),
      ],
    });
    const h = harness;

    const doomed = await seedAgent(h, 'Doomed');
    const control = await seedAgent(h, 'Control');
    const folders = await seedSharedFolders(h, doomed, control);
    const projects = await seedProjects(h, doomed, control);

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
        // W2: the doomed agent owns two folders and views a third.
        'shared_folders_v1_grants.agent_id',
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

      // Shared folders, folder by folder. The walk above counts rows; this
      // pins WHICH rows, including the one table it cannot see.
      const folderRows = await client.query<{ folder_id: string; deleted: boolean }>(
        'SELECT folder_id, deleted_at IS NOT NULL AS deleted FROM shared_folders_v1_folders ORDER BY folder_id',
      );
      const deletedByFolder = new Map(folderRows.rows.map((r) => [r.folder_id, r.deleted]));
      // The unowned folder is tombstoned (no sandbox provider here, so the row
      // stays), and nothing of it — no grant, no agent id — is left behind.
      expect(deletedByFolder.get(folders.tombstoned)).toBe(true);
      for (const live of [folders.transferred, folders.controlOwned, folders.controlOnly]) {
        expect(deletedByFolder.get(live), `folder ${live} must stay live`).toBe(false);
      }
      const grantRows = await client.query<{ folder_id: string; agent_id: string; role: string }>(
        'SELECT folder_id, agent_id, role FROM shared_folders_v1_grants ORDER BY folder_id, agent_id',
      );
      const grantsOf = (folderId: string): string[] =>
        grantRows.rows
          .filter((g) => g.folder_id === folderId)
          .map((g) => `${g.agent_id}:${g.role}`);
      expect(grantsOf(folders.tombstoned)).toEqual([]);
      // The editor inherits; the doomed agent is gone from the folder.
      expect(grantsOf(folders.transferred)).toEqual([`${control.agentId}:owner`]);
      // The doomed agent's viewer grant went; the control's ownership did not.
      expect(grantsOf(folders.controlOwned)).toEqual([`${control.agentId}:owner`]);
      expect(grantsOf(folders.controlOnly)).toEqual([`${control.agentId}:owner`]);

      // W3a: the project on the doomed agent's unshared folder went with it —
      // row gone, `projects:get` answers not-found, `projects:deleted` fired
      // exactly once for it. The project whose folder had an editor survives.
      const projectRows = await client.query<{ project_id: string }>(
        'SELECT project_id FROM projects_v1_projects ORDER BY project_id',
      );
      expect(projectRows.rows.map((r) => r.project_id)).toEqual([projects.survives]);
      await expect(
        h.bus.call('projects:get', h.ctx({ userId: USER }), { projectId: projects.removed }),
      ).rejects.toMatchObject({ code: 'not-found' });
      expect(projectsDeleted).toEqual([projects.removed]);
      const survivor = await h.bus.call<unknown, { members: { agentId: string; role: string }[] }>(
        'projects:get',
        h.ctx({ userId: USER }),
        { projectId: projects.survives },
      );
      expect(survivor.members).toEqual([{ agentId: control.agentId, role: 'owner' }]);
    } finally {
      await client.end().catch(() => {});
    }
  }, 180_000);
});
