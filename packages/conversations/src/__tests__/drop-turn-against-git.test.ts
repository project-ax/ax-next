// End-to-end proof of the version-as-parent fix.
//
// Phase 1 of the routines-phase-b-followups plan teaches workspace:read to
// surface the snapshot version, and teaches conversations:drop-turn to pass
// that version as the workspace:apply parent. The drop-turn unit test runs
// against an in-test mock and locks in the *wiring* — but only an integration
// against the real `@ax/workspace-git` plugin proves the CAS gate actually
// accepts the rewritten apply. That's what this file does.
//
// Before the fix: workspace:apply receives `parent: null`, the git backend
// has a non-null HEAD, and the apply throws PARENT_MISMATCH. The drop-turn
// silence-token write is therefore a no-op in production; only the
// conversation hide takes effect.
//
// After the fix: read returns the commit OID it was read at, drop-turn
// threads it through, the apply lands, and the rewritten jsonl persists.
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createWorkspaceGitPlugin } from '@ax/workspace-git';
import type {
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import { createConversationsPlugin } from '../plugin.js';
import type { CreateInput, CreateOutput } from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0)
    await harnesses.pop()!.close({ onError: () => {} });
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_turns');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('conversations:drop-turn against the real git workspace', () => {
  it('persists the rewritten jsonl by passing read.version as parent', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-conv-drop-turn-'));
    try {
      const h = await createTestHarness({
        services: {
          'agents:resolve': async (_c, input: unknown) => ({
            agent: {
              id: (input as { agentId: string }).agentId,
              visibility: 'personal',
            },
          }),
        },
        plugins: [
          createDatabasePostgresPlugin({ connectionString }),
          createWorkspaceGitPlugin({ repoRoot }),
          createConversationsPlugin(),
        ],
      });
      harnesses.push(h);

      // Seed: write a 2-turn jsonl to the workspace. This creates a real
      // commit so the workspace HEAD is non-null — the exact state where
      // `parent: null` would fail the CAS gate.
      const path = '.claude/projects/proj/sess_a.jsonl';
      const lines = [
        JSON.stringify({
          type: 'assistant',
          uuid: 't1',
          message: {
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'text', text: 'first' }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 't2',
          message: {
            id: 'm2',
            role: 'assistant',
            content: [{ type: 'text', text: 'second' }],
          },
        }),
      ];
      await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        {
          changes: [
            {
              path,
              kind: 'put',
              content: new TextEncoder().encode(lines.join('\n') + '\n'),
            },
          ],
          parent: null,
        },
      );

      // Bind a conversation to this sessionId.
      const conv = await h.bus.call<CreateInput, CreateOutput>(
        'conversations:create',
        h.ctx({ userId: 'u1' }),
        { userId: 'u1', agentId: 'a1' },
      );
      await h.bus.call(
        'conversations:store-runner-session',
        h.ctx({ userId: 'u1' }),
        {
          conversationId: conv.conversationId,
          runnerSessionId: 'sess_a',
        },
      );

      // Drop turn 1. Pre-fix this would throw PARENT_MISMATCH on the
      // workspace:apply inside drop-turn; post-fix it lands.
      await h.bus.call(
        'conversations:drop-turn',
        h.ctx({ userId: 'u1' }),
        {
          conversationId: conv.conversationId,
          userId: 'u1',
          turnId: 't1',
        },
      );

      // Read the file back from the workspace — the load-bearing assertion.
      const read = await h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        h.ctx(),
        { path },
      );
      expect(read.found).toBe(true);
      if (!read.found) return;
      const text = new TextDecoder().decode(read.bytes);
      expect(text).not.toContain('"uuid":"t1"');
      expect(text).toContain('"uuid":"t2"');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
