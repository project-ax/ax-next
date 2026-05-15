import { describe, it, expect } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import type { AgentContext } from '@ax/core';
import type { ContentBlock } from '@ax/ipc-protocol';
import { createDownloadHandler } from '../handlers.js';

function makeCtx(userId: string): AgentContext {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId,
  });
}

/**
 * Build a full Conversation row shape that matches GetOutput.conversation.
 * conversations:get returns the strongly-typed Conversation interface — every
 * nullable field needs to be present (even if null) so the handler's
 * type-checks against `got.turns` succeed regardless of which other fields
 * it might one day key off of.
 */
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

function makeBus(
  opts: {
    conversationsGet?: (input: ConversationsGetInput) => Promise<unknown>;
    workspaceRead?: (input: { path: string }) => Promise<unknown>;
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
  const wr =
    opts.workspaceRead ??
    (async (input: { path: string }) => {
      if (input.path === '.ax/uploads/c-1/t-1/abc__file.pdf') {
        return { found: true, bytes: Buffer.from('pdf-bytes') };
      }
      return { found: false };
    });
  // Service handlers receive (ctx, input). Test factories above only need
  // `input`, so we wrap them to discard the ctx.
  bus.registerService('conversations:get', 'test-mock', async (_ctx, input) =>
    cg(input as ConversationsGetInput),
  );
  bus.registerService('workspace:read', 'test-mock', async (_ctx, input) =>
    wr(input as { path: string }),
  );
  return bus;
}

describe('attachments:download handler', () => {
  describe('path normalization', () => {
    it.each([
      ['../etc/passwd'],
      ['.ax/uploads/c/t/../../escape'],
      ['/etc/passwd'],
      ['.ax//uploads/c/t/file'],
      ['a'.repeat(1025)],
      [''],
    ])('rejects path %j with not-found', async (badPath) => {
      const handler = createDownloadHandler({ bus: makeBus() });
      await expect(
        handler(makeCtx('u-1'), {
          path: badPath,
          conversationId: 'c-1',
          userId: 'u-1',
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('owner gate', () => {
    it('rejects foreign conversation with not-found (uniform existence-leak)', async () => {
      const handler = createDownloadHandler({ bus: makeBus() });
      await expect(
        handler(makeCtx('u-attacker'), {
          path: '.ax/uploads/c-1/t-1/abc__file.pdf',
          conversationId: 'c-1',
          userId: 'u-attacker',
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('collapses forbidden from conversations:get to not-found', async () => {
      const bus = makeBus({
        conversationsGet: async () => {
          throw new PluginError({
            code: 'forbidden',
            plugin: 'test-mock',
            message: 'no',
          });
        },
      });
      const handler = createDownloadHandler({ bus });
      await expect(
        handler(makeCtx('u-1'), {
          path: '.ax/uploads/c-1/t-1/abc__file.pdf',
          conversationId: 'c-1',
          userId: 'u-1',
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('rejects input.userId !== ctx.userId with not-found (spoof attempt)', async () => {
      // A caller asserting they're acting as someone else than ctx.userId
      // is either confused or probing — collapse to not-found so the
      // response is indistinguishable from a missing conversation.
      const handler = createDownloadHandler({ bus: makeBus() });
      await expect(
        handler(makeCtx('u-attacker'), {
          path: '.ax/uploads/c-1/t-1/abc__file.pdf',
          conversationId: 'c-1',
          userId: 'u-1', // claims to be the legitimate owner
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('path-scope check', () => {
    it('allows path under .ax/uploads/<conversationId>/', async () => {
      const handler = createDownloadHandler({ bus: makeBus() });
      const result = await handler(makeCtx('u-1'), {
        path: '.ax/uploads/c-1/t-1/abc__file.pdf',
        conversationId: 'c-1',
        userId: 'u-1',
      });
      expect(result.bytes.toString()).toBe('pdf-bytes');
    });

    it('rejects path under another conversation with forbidden', async () => {
      const handler = createDownloadHandler({ bus: makeBus() });
      await expect(
        handler(makeCtx('u-1'), {
          path: '.ax/uploads/c-OTHER/t-1/abc__file.pdf',
          conversationId: 'c-1',
          userId: 'u-1',
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('allows path referenced from an attachment block in any turn', async () => {
      const attachmentBlock: ContentBlock = {
        type: 'attachment',
        path: 'workspace/reports/Q4.pdf',
        displayName: 'Q4',
        mediaType: 'application/pdf',
        sizeBytes: 1,
      };
      const bus = makeBus({
        conversationsGet: async () => ({
          conversation: makeConversationRow({
            conversationId: 'c-1',
            userId: 'u-1',
          }),
          turns: [
            {
              turnId: 't-1',
              turnIndex: 0,
              role: 'assistant' as const,
              contentBlocks: [attachmentBlock],
              createdAt: '2026-05-15T00:00:00Z',
            },
          ],
        }),
        workspaceRead: async () => ({ found: true, bytes: Buffer.from('q4') }),
      });
      const handler = createDownloadHandler({ bus });
      const result = await handler(makeCtx('u-1'), {
        path: 'workspace/reports/Q4.pdf',
        conversationId: 'c-1',
        userId: 'u-1',
      });
      expect(result.bytes.toString()).toBe('q4');
      expect(result.displayName).toBe('Q4');
      expect(result.mediaType).toBe('application/pdf');
    });

    it('allows path referenced from an artifact_publish tool_result', async () => {
      const toolResultPath = 'workspace/reports/Q4.pdf';
      const toolUseBlock: ContentBlock = {
        type: 'tool_use',
        id: 'toolu-1',
        name: 'artifact_publish',
        input: { path: '/permanent/workspace/reports/Q4.pdf' },
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
          sha256: 'x',
        }),
      };
      const bus = makeBus({
        conversationsGet: async () => ({
          conversation: makeConversationRow({
            conversationId: 'c-1',
            userId: 'u-1',
          }),
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
        workspaceRead: async () => ({ found: true, bytes: Buffer.from('q4') }),
      });
      const handler = createDownloadHandler({ bus });
      const result = await handler(makeCtx('u-1'), {
        path: toolResultPath,
        conversationId: 'c-1',
        userId: 'u-1',
      });
      expect(result.bytes.toString()).toBe('q4');
      expect(result.displayName).toBe('Q4');
      expect(result.mediaType).toBe('application/pdf');
    });

    it('rejects path not referenced anywhere with forbidden', async () => {
      const handler = createDownloadHandler({ bus: makeBus() });
      await expect(
        handler(makeCtx('u-1'), {
          path: 'workspace/reports/SECRET.pdf',
          conversationId: 'c-1',
          userId: 'u-1',
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  describe('workspace:read', () => {
    it('returns not-found when the file is gone from main', async () => {
      const handler = createDownloadHandler({ bus: makeBus() });
      await expect(
        handler(makeCtx('u-1'), {
          path: '.ax/uploads/c-1/t-1/missing__file.pdf',
          conversationId: 'c-1',
          userId: 'u-1',
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });
});
