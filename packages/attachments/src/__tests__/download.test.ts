import { describe, it, expect } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import type { AgentContext } from '@ax/core';
import type { ContentBlock } from '@ax/ipc-protocol';
import { createDownloadHandler } from '../handlers.js';
import type { AttachmentsStore, FileRow } from '../store.js';

// ---------------------------------------------------------------------------
// TASK-68: attachments:download keeps its full ACL ladder (normalize → owner
// gate → path-scope) but its FINAL fetch swaps workspace:read (git) for
// row → blob:get (content-addressed store). These tests prove the ACL is intact
// and the new fetch path resolves a path → metadata row → blob bytes.
// ---------------------------------------------------------------------------

function makeCtx(userId: string): AgentContext {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId,
  });
}

function makeConversationRow(opts: {
  conversationId: string;
  userId: string;
  agentId?: string;
}) {
  return {
    conversationId: opts.conversationId,
    userId: opts.userId,
    agentId: opts.agentId ?? 'a-1',
    title: null as string | null,
    activeSessionId: null as string | null,
    activeReqId: null as string | null,
    runnerType: null as string | null,
    runnerSessionId: null as string | null,
    workspaceRef: null as string | null,
    lastActivityAt: null as string | null,
    hidden: false,
    externalKey: null as string | null,
    createdAt: '2026-05-15T00:00:00.000Z',
    updatedAt: '2026-05-15T00:00:00.000Z',
  };
}

interface ConversationsGetInput {
  conversationId: string;
  userId: string;
}

/** A row keyed by `${conversationId}::${path}`. */
function fileRow(conversationId: string, path: string, sha256: string, extra?: Partial<FileRow>): FileRow {
  return {
    id: 'id-' + sha256.slice(0, 6),
    conversationId,
    userId: 'u-1',
    sha256,
    path,
    displayName: extra?.displayName ?? path.split('/').pop() ?? 'file',
    mediaType: extra?.mediaType ?? 'application/octet-stream',
    sizeBytes: extra?.sizeBytes ?? 0,
  };
}

/**
 * Mock store exposing only the read methods download uses. `files`/`artifacts`
 * are keyed by `${conversationId}::${path}`.
 */
function makeStore(opts: {
  files?: Record<string, FileRow>;
  artifacts?: Record<string, FileRow>;
} = {}): AttachmentsStore {
  const files = opts.files ?? {};
  const artifacts = opts.artifacts ?? {};
  const stub = {
    getFileByPath: async (c: string, p: string) => files[`${c}::${p}`] ?? null,
    getArtifactByPath: async (c: string, p: string) => artifacts[`${c}::${p}`] ?? null,
  } as Partial<AttachmentsStore>;
  return stub as AttachmentsStore;
}

function makeBus(
  opts: {
    conversationsGet?: (input: ConversationsGetInput) => Promise<unknown>;
    blobGet?: (input: { sha256: string }) => Promise<unknown>;
  } = {},
): HookBus {
  const bus = new HookBus();
  const cg =
    opts.conversationsGet ??
    (async (input: ConversationsGetInput) => {
      if (input.userId !== 'u-1') {
        throw new PluginError({
          code: 'not-found',
          plugin: 'test-mock',
          message: 'conversation not found',
        });
      }
      return {
        conversation: makeConversationRow({
          conversationId: input.conversationId,
          userId: 'u-1',
        }),
        turns: [],
      };
    });
  const bg =
    opts.blobGet ??
    (async (input: { sha256: string }) => {
      if (input.sha256 === 'sha-pdf') {
        return { bytes: new Uint8Array(Buffer.from('pdf-bytes')) };
      }
      return { found: false };
    });
  bus.registerService('conversations:get', 'test-mock', async (_ctx, input) =>
    cg(input as ConversationsGetInput),
  );
  bus.registerService('blob:get', 'test-blob', async (_ctx, input) =>
    bg(input as { sha256: string }),
  );
  return bus;
}

const UPLOAD_PATH = '.ax/uploads/c-1/t-1/abc__file.pdf';

describe('attachments:download handler (blob-backed)', () => {
  describe('path normalization', () => {
    it.each([
      ['../etc/passwd'],
      ['.ax/uploads/c/t/../../escape'],
      ['/etc/passwd'],
      ['.ax//uploads/c/t/file'],
      ['a'.repeat(1025)],
      [''],
    ])('rejects path %j with not-found', async (badPath) => {
      const handler = createDownloadHandler({ bus: makeBus(), store: makeStore() });
      await expect(
        handler(makeCtx('u-1'), { path: badPath, conversationId: 'c-1', userId: 'u-1' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('owner gate', () => {
    it('rejects foreign conversation with not-found (uniform existence-leak)', async () => {
      const handler = createDownloadHandler({ bus: makeBus(), store: makeStore() });
      await expect(
        handler(makeCtx('u-attacker'), { path: UPLOAD_PATH, conversationId: 'c-1', userId: 'u-attacker' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('collapses forbidden from conversations:get to not-found', async () => {
      const bus = makeBus({
        conversationsGet: async () => {
          throw new PluginError({ code: 'forbidden', plugin: 'test-mock', message: 'no' });
        },
      });
      const handler = createDownloadHandler({ bus, store: makeStore() });
      await expect(
        handler(makeCtx('u-1'), { path: UPLOAD_PATH, conversationId: 'c-1', userId: 'u-1' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('rejects input.userId !== ctx.userId with not-found (spoof attempt)', async () => {
      const handler = createDownloadHandler({ bus: makeBus(), store: makeStore() });
      await expect(
        handler(makeCtx('u-attacker'), { path: UPLOAD_PATH, conversationId: 'c-1', userId: 'u-1' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('path-scope check', () => {
    it('allows + serves a path under .ax/uploads/<conversationId>/ via its files row', async () => {
      const store = makeStore({ files: { [`c-1::${UPLOAD_PATH}`]: fileRow('c-1', UPLOAD_PATH, 'sha-pdf', { mediaType: 'application/pdf', displayName: 'file.pdf' }) } });
      const handler = createDownloadHandler({ bus: makeBus(), store });
      const result = await handler(makeCtx('u-1'), { path: UPLOAD_PATH, conversationId: 'c-1', userId: 'u-1' });
      expect(result.bytes.toString()).toBe('pdf-bytes');
      expect(result.mediaType).toBe('application/pdf');
      expect(result.displayName).toBe('file.pdf');
    });

    it('rejects path under another conversation with forbidden', async () => {
      const handler = createDownloadHandler({ bus: makeBus(), store: makeStore() });
      await expect(
        handler(makeCtx('u-1'), { path: '.ax/uploads/c-OTHER/t-1/abc__file.pdf', conversationId: 'c-1', userId: 'u-1' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('serves a path referenced from an artifact_publish tool_result via its artifact row', async () => {
      const toolResultPath = 'workspace/reports/Q4.pdf';
      const toolUseBlock: ContentBlock = {
        type: 'tool_use',
        id: 'toolu-1',
        name: 'artifact_publish',
        input: { path: '/ephemeral/artifacts/Q4.pdf' },
      };
      const toolResultBlock: ContentBlock = {
        type: 'tool_result',
        tool_use_id: 'toolu-1',
        content: JSON.stringify({
          artifactId: 'abcd',
          downloadUrl: 'ax://artifact/abcd',
          path: toolResultPath,
          displayName: 'Q4',
          mediaType: 'application/pdf',
          sizeBytes: 1,
          sha256: 'sha-q4',
        }),
      };
      const bus = makeBus({
        conversationsGet: async () => ({
          conversation: makeConversationRow({ conversationId: 'c-1', userId: 'u-1' }),
          turns: [
            {
              turnId: 't-1',
              turnIndex: 0,
              role: 'assistant' as const,
              contentBlocks: [toolUseBlock, toolResultBlock],
              createdAt: '2026-05-15T00:00:00Z',
            },
          ],
        }),
        blobGet: async (input) =>
          input.sha256 === 'sha-q4' ? { bytes: new Uint8Array(Buffer.from('q4')) } : { found: false },
      });
      const store = makeStore({
        artifacts: { [`c-1::${toolResultPath}`]: fileRow('c-1', toolResultPath, 'sha-q4', { mediaType: 'application/pdf', displayName: 'Q4' }) },
      });
      const handler = createDownloadHandler({ bus, store });
      const result = await handler(makeCtx('u-1'), { path: toolResultPath, conversationId: 'c-1', userId: 'u-1' });
      expect(result.bytes.toString()).toBe('q4');
      expect(result.displayName).toBe('Q4');
      expect(result.mediaType).toBe('application/pdf');
    });

    // TASK-77 (regression): the runner persists an artifact_publish tool_result
    // as the SDK/MCP ARRAY shape `[{type:'text', text:<json>}]`, NOT the string
    // form the test above uses. Before the fix, checkPathScope only parsed the
    // string branch, so a published artifact's path was never matched → the
    // download collapsed to `forbidden` and the UI showed "unknown artifact"
    // (the TASK-72 walk step-4 404). This proves the array branch resolves too.
    it('serves a path referenced from an artifact_publish tool_result with ARRAY content', async () => {
      const toolResultPath = 'workspace/reports/Q4.pdf';
      const toolUseBlock: ContentBlock = {
        type: 'tool_use',
        id: 'toolu-1',
        name: 'artifact_publish',
        input: { path: '/ephemeral/artifacts/Q4.pdf' },
      };
      const toolResultBlock: ContentBlock = {
        type: 'tool_result',
        tool_use_id: 'toolu-1',
        // The shape the runner actually emits (main.ts narrows the SDK echo to
        // `[{type:'text', text}]`), not the string form.
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              artifactId: 'abcd',
              downloadUrl: 'ax://artifact/abcd',
              path: toolResultPath,
              displayName: 'Q4',
              mediaType: 'application/pdf',
              sizeBytes: 1,
              sha256: 'sha-q4',
            }),
          },
        ],
      };
      const bus = makeBus({
        conversationsGet: async () => ({
          conversation: makeConversationRow({ conversationId: 'c-1', userId: 'u-1' }),
          turns: [
            {
              turnId: 't-1',
              turnIndex: 0,
              role: 'assistant' as const,
              contentBlocks: [toolUseBlock, toolResultBlock],
              createdAt: '2026-05-15T00:00:00Z',
            },
          ],
        }),
        blobGet: async (input) =>
          input.sha256 === 'sha-q4' ? { bytes: new Uint8Array(Buffer.from('q4')) } : { found: false },
      });
      const store = makeStore({
        artifacts: { [`c-1::${toolResultPath}`]: fileRow('c-1', toolResultPath, 'sha-q4', { mediaType: 'application/pdf', displayName: 'Q4' }) },
      });
      const handler = createDownloadHandler({ bus, store });
      const result = await handler(makeCtx('u-1'), { path: toolResultPath, conversationId: 'c-1', userId: 'u-1' });
      expect(result.bytes.toString()).toBe('q4');
      expect(result.displayName).toBe('Q4');
      expect(result.mediaType).toBe('application/pdf');
    });

    it('rejects path not referenced anywhere with forbidden', async () => {
      const handler = createDownloadHandler({ bus: makeBus(), store: makeStore() });
      await expect(
        handler(makeCtx('u-1'), { path: 'workspace/reports/SECRET.pdf', conversationId: 'c-1', userId: 'u-1' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  describe('row + blob resolution', () => {
    it('returns not-found when the path is in scope but no metadata row exists', async () => {
      // In scope (uploads prefix), but no row → not-found (e.g. a pre-TASK-68
      // git-era attachment, or a GC'd blob).
      const handler = createDownloadHandler({ bus: makeBus(), store: makeStore() });
      await expect(
        handler(makeCtx('u-1'), { path: '.ax/uploads/c-1/t-1/missing__file.pdf', conversationId: 'c-1', userId: 'u-1' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('returns not-found when the row exists but the blob is gone', async () => {
      const store = makeStore({ files: { [`c-1::${UPLOAD_PATH}`]: fileRow('c-1', UPLOAD_PATH, 'sha-missing') } });
      const handler = createDownloadHandler({ bus: makeBus(), store });
      await expect(
        handler(makeCtx('u-1'), { path: UPLOAD_PATH, conversationId: 'c-1', userId: 'u-1' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });
});
