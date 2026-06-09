import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcServerPlugin } from '@ax/ipc-server';
import { createWorkspaceLocaldirPlugin } from '@ax/workspace-localdir';
import type {
  ReadUserFilesInput,
  ReadUserFilesOutput,
} from '@ax/sandbox-mount-protocol';
import { createSandboxSubprocessPlugin } from '../plugin.js';
import type { OpenSessionResult } from '../open-session.js';

// ---------------------------------------------------------------------------
// filestore-user-files Phase 1 — CANARY acceptance (design §12).
//
// The fully-wired end-to-end proof (invariant I3): the real subprocess sandbox
// provider + the real @ax/workspace-localdir resolver, no NFS, no mocks of the
// mount path. A session of agent `a` writes a file under the durable
// AX_USERFILES_ROOT mount and ends; a FRESH session of the SAME agent sees that
// file PERSIST. This is the load-bearing promise of the localDir backing — the
// per-agent subtree survives the process death across sessions.
//
// We drive the real plugin chain (session-inmemory + ipc-server +
// workspace-localdir + sandbox-subprocess) through `sandbox:open-session`, and
// a small runner stub (userfiles-stub.mjs) does on boot exactly what the real
// runner would: read AX_USERFILES_ROOT, read back any prior `canary.txt`,
// append this session's id. The stub echoes `{ before, after }` so the test can
// assert cross-session persistence directly.
// ---------------------------------------------------------------------------

const USERFILES_STUB = fileURLToPath(
  new URL('./fixtures/userfiles-stub.mjs', import.meta.url),
);

function owner(agentId: string) {
  return {
    userId: 'user-1',
    agentId,
    agentConfig: {
      displayName: 'Canary',
      systemPromptAugment: '',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'claude',
    },
  };
}

async function makeHarness(userFilesRootDir: string) {
  return createTestHarness({
    services: {
      'llm:call': async () => ({
        assistantMessage: { role: 'assistant', content: '' },
        toolCalls: [],
      }),
      'tool:list': async () => ({ tools: [] }),
      'workspace:read': async () => ({ found: false }),
    },
    plugins: [
      createSessionInmemoryPlugin(),
      createIpcServerPlugin(),
      // The mount resolver (CLI/dev backing). Its per-agent subtree root is a
      // real persistent host dir we control, so two sessions of the same agent
      // share `<root>/<agentId>`.
      createWorkspaceLocaldirPlugin({ root: userFilesRootDir }),
      createSandboxSubprocessPlugin(),
    ],
  });
}

function readFirstStdoutLine(result: OpenSessionResult): Promise<string> {
  const stdout = result.handle.child?.stdout;
  if (stdout === undefined) throw new Error('expected handle.child.stdout');
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        stdout.off('data', onData);
        stdout.off('error', onErr);
        resolve(buf.slice(0, nl));
      }
    };
    const onErr = (err: Error): void => reject(err);
    stdout.on('data', onData);
    stdout.on('error', onErr);
  });
}

interface CanaryProbe {
  userFilesRoot: string | null;
  before: string | null;
  after: string | null;
}

async function runSession(
  h: Awaited<ReturnType<typeof makeHarness>>,
  agentId: string,
  sessionId: string,
  workspaceRoot: string,
): Promise<CanaryProbe> {
  const result = await h.bus.call<unknown, OpenSessionResult>(
    'sandbox:open-session',
    h.ctx(),
    {
      sessionId,
      workspaceRoot,
      runnerBinary: USERFILES_STUB,
      owner: owner(agentId),
    },
  );
  const line = await readFirstStdoutLine(result);
  // End the session — the stub holds itself open, so kill it to mimic the pod
  // dying. The localDir subtree on the host FS persists past this.
  await result.handle.kill();
  return JSON.parse(line) as CanaryProbe;
}

describe('filestore-user-files canary (subprocess + localDir)', () => {
  it('a file written to AX_USERFILES_ROOT persists across two sessions of the same agent', async () => {
    const userFilesRootDir = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? '/tmp', 'ax-userfiles-'),
    );
    const ws1 = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ax-ws-'));
    const ws2 = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ax-ws-'));
    const h = await makeHarness(userFilesRootDir);

    // Session 1: the mount is fresh, so `before` is null; the stub writes
    // session-1 into canary.txt.
    const s1 = await runSession(h, 'canary-agent', 'sess-1', ws1);
    expect(s1.userFilesRoot).toBe(path.join(userFilesRootDir, 'canary-agent'));
    expect(s1.before).toBeNull();
    expect(s1.after).toBe('sess-1\n');

    // Session 2: a FRESH session of the SAME agent. The durable subtree
    // persisted across the first session's death — `before` MUST carry the
    // first session's write.
    const s2 = await runSession(h, 'canary-agent', 'sess-2', ws2);
    expect(s2.userFilesRoot).toBe(path.join(userFilesRootDir, 'canary-agent'));
    expect(s2.before).toBe('sess-1\n');
    expect(s2.after).toBe('sess-1\nsess-2\n');

    await h.close();
  });

  it('a different agent gets an isolated subtree (no cross-agent bleed)', async () => {
    const userFilesRootDir = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? '/tmp', 'ax-userfiles-'),
    );
    const ws = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ax-ws-'));
    const h = await makeHarness(userFilesRootDir);

    await runSession(h, 'agent-a', 'sess-a', ws);
    // Agent B's first session sees NOTHING agent A wrote — different subPath.
    const b = await runSession(h, 'agent-b', 'sess-b', ws);
    expect(b.userFilesRoot).toBe(path.join(userFilesRootDir, 'agent-b'));
    expect(b.before).toBeNull();

    await h.close();
  });

  // TASK-167 (§11 host-read) — canary-reachable: after a session writes a file
  // to its durable mount, the HOST reads it back READ-ONLY via the real
  // `sandbox:read-user-files` hook (the web-UI path), without entering a live
  // sandbox and without granting write.
  it('the host reads an agent file back via sandbox:read-user-files (read-only)', async () => {
    const userFilesRootDir = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? '/tmp', 'ax-userfiles-'),
    );
    const ws = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ax-ws-'));
    const h = await makeHarness(userFilesRootDir);

    // The stub writes `canary.txt` under the mount during session 1.
    await runSession(h, 'reader-agent', 'sess-r', ws);

    // Host-read the directory listing.
    const list = await h.bus.call<ReadUserFilesInput, ReadUserFilesOutput>(
      'sandbox:read-user-files',
      h.ctx(),
      { owner: owner('reader-agent') },
    );
    expect(list.kind).toBe('dir');
    if (list.kind !== 'dir') throw new Error('expected dir');
    expect(list.entries.map((e) => e.name)).toContain('canary.txt');

    // Host-read the file bytes.
    const file = await h.bus.call<ReadUserFilesInput, ReadUserFilesOutput>(
      'sandbox:read-user-files',
      h.ctx(),
      { owner: owner('reader-agent'), relPath: 'canary.txt' },
    );
    expect(file.kind).toBe('file');
    if (file.kind !== 'file') throw new Error('expected file');
    expect(Buffer.from(file.contents).toString('utf-8')).toBe('sess-r\n');

    // A non-existent agent → absent (the host serves nothing).
    const none = await h.bus.call<ReadUserFilesInput, ReadUserFilesOutput>(
      'sandbox:read-user-files',
      h.ctx(),
      { owner: owner('no-such-agent') },
    );
    expect(none).toEqual({ kind: 'absent' });

    await h.close();
  });

  // TASK-167 (§11 cleanup) — canary-reachable: firing `agents:deleted` cleans up
  // ONLY that agent's durable subtree via the real subprocess subscriber; a
  // sibling agent's files are untouched (cross-tenant safety).
  it('agents:deleted cleans up only the deleted agent subtree (cross-tenant safe)', async () => {
    const userFilesRootDir = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? '/tmp', 'ax-userfiles-'),
    );
    const ws = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ax-ws-'));
    const h = await makeHarness(userFilesRootDir);

    // Seed two agents' subtrees by running a session for each.
    await runSession(h, 'del-agent-a', 'sess-da', ws);
    await runSession(h, 'del-agent-b', 'sess-db', ws);
    const dirA = path.join(userFilesRootDir, 'del-agent-a');
    const dirB = path.join(userFilesRootDir, 'del-agent-b');
    await expect(fs.stat(dirA)).resolves.toBeTruthy();
    await expect(fs.stat(dirB)).resolves.toBeTruthy();

    // Fire agents:deleted for A only (the @ax/agents fire site does this after
    // the row is removed). The subprocess subscriber rm -rf's A's subtree.
    const fired = await h.bus.fire('agents:deleted', h.ctx(), {
      agentId: 'del-agent-a',
      ownerId: 'user-1',
      ownerType: 'user',
    });
    expect(fired.rejected).toBe(false);

    await expect(fs.stat(dirA)).rejects.toThrow(); // gone
    await expect(fs.stat(dirB)).resolves.toBeTruthy(); // untouched

    await h.close();
  });
});
