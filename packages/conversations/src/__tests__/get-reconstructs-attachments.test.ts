import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  AppendEventInput,
  AppendEventOutput,
  CreateInput,
  CreateOutput,
  GetInput,
  GetOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// conversations:get attachment-chip reconstruction (read path).
//
// `conversations:get` redisplays from the DISPLAY EVENT LOG (TASK-66) — the
// turn frames the host already emitted over SSE, persisted as rows. The
// legacy transcript-via-git read (`workspace:list` + `workspace:read` glob of
// the runner jsonl) was retired in TASK-70 (out-of-git Phase 5): the resume
// jsonl left git in TASK-67, so that glob no longer hits a tracked file, and
// there's no production data with pre-event-log conversations to fall back
// for. So these tests seed turns through the live event log
// (`conversations:append-event`, the same hook the @ax/ipc-core
// event.turn-end handler calls) and assert `reconstructAttachmentBlocks`
// rebuilds download chips from the runner's path-bearing mentions, gated to
// the conversation's own upload prefix.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => {
        const call = input as { agentId: string };
        return { agent: { id: call.agentId, visibility: 'personal' } };
      },
      // conversations manifest declares these calls (drop-turn uses them);
      // stub for bootstrap. The attachment-chip read path does NOT touch them.
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:read': async () => ({ found: false as const }),
      'workspace:apply': async () => ({
        version: 'v-stub',
        delta: { before: null, after: 'v-stub', changes: [] },
      }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

/** Append one turn frame to the display event log (the redisplay SoT). */
async function appendTurn(
  h: TestHarness,
  conversationId: string,
  role: 'user' | 'assistant' | 'tool',
  blocks: unknown[],
): Promise<void> {
  await h.bus.call<AppendEventInput, AppendEventOutput>(
    'conversations:append-event',
    h.ctx({ conversationId }),
    { conversationId, kind: 'turn', role, payload: { blocks } },
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_events');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('@ax/conversations conversations:get reconstructs attachment chips', () => {
  // Seed the conversation's USER turn from `content` (a literal blocks array,
  // or a function of the freshly-minted conversationId for prefix-bearing
  // mentions), then read it back via conversations:get.
  async function getWithUserContent(
    content: unknown[] | ((conversationId: string) => unknown[]),
  ): Promise<GetOutput> {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    const blocks =
      typeof content === 'function'
        ? content(created.conversationId)
        : content;
    await appendTurn(h, created.conversationId, 'user', blocks);
    return h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
  }

  it('rebuilds an attachment block from a standalone mention block (keeps the typed prompt)', async () => {
    const got = await getWithUserContent((convId: string) => [
      { type: 'text', text: 'Summarize this file' },
      {
        type: 'text',
        text: `User attached 'Disaster Recovery Plan - v3.pdf' at .ax/uploads/${convId}/req-d194/a60d__Disaster_Recovery_Plan_-_v3.pdf (application/pdf)`,
      },
    ]);
    const user = got.turns.find((t) => t.role === 'user');
    expect(user?.contentBlocks).toHaveLength(2);
    expect(user?.contentBlocks[0]).toEqual({
      type: 'text',
      text: 'Summarize this file',
    });
    const att = user?.contentBlocks[1];
    expect(att).toMatchObject({
      type: 'attachment',
      displayName: 'Disaster Recovery Plan - v3.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 0,
    });
    expect((att as { path: string }).path).toContain('.ax/uploads/');
  });

  it('splits a merged "prompt\\nmention" text block into [text, attachment]', async () => {
    const got = await getWithUserContent((convId: string) => [
      {
        type: 'text',
        text: `Summarize this file\nUser attached 'r.pdf' at .ax/uploads/${convId}/req-1/ab__r.pdf (application/pdf)`,
      },
    ]);
    const user = got.turns.find((t) => t.role === 'user');
    expect(user?.contentBlocks).toEqual([
      { type: 'text', text: 'Summarize this file' },
      {
        type: 'attachment',
        path: expect.stringContaining('.ax/uploads/') as unknown as string,
        displayName: 'r.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 0,
      },
    ]);
  });

  it('does NOT convert a mention whose path belongs to a different conversation (false-positive guard)', async () => {
    const mention =
      "User attached 'evil.pdf' at .ax/uploads/cnv_someoneelse/req-x/ab__evil.pdf (application/pdf)";
    const got = await getWithUserContent([{ type: 'text', text: mention }]);
    const user = got.turns.find((t) => t.role === 'user');
    // Untouched — still a plain text block, no attachment block produced.
    expect(user?.contentBlocks).toEqual([{ type: 'text', text: mention }]);
  });

  it('does NOT convert mentions inside an assistant turn (model cannot inject chips)', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    const mention = `User attached 'x.pdf' at .ax/uploads/${created.conversationId}/req-1/ab__x.pdf (application/pdf)`;
    await appendTurn(h, created.conversationId, 'assistant', [
      { type: 'text', text: mention },
    ]);
    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    const assistant = got.turns.find((t) => t.role === 'assistant');
    expect(assistant?.contentBlocks).toEqual([{ type: 'text', text: mention }]);
  });

  it('leaves a normal text-only user turn unchanged', async () => {
    const got = await getWithUserContent([{ type: 'text', text: 'just text' }]);
    const user = got.turns.find((t) => t.role === 'user');
    expect(user?.contentBlocks).toEqual([{ type: 'text', text: 'just text' }]);
  });

  // -------------------------------------------------------------------------
  // TASK-21 — inlined-attachment reconstruction (read path).
  //
  // For a small text/json/yaml/csv file the runner INLINES the bytes for the
  // model: the canonical path-bearing mention on the first line, a blank line,
  // then the file content (see formatAttachmentInline). On reload this whole
  // block must become a download chip — NOT raw text — and the model-view
  // content (preamble + file bytes) must NOT be surfaced verbatim.
  // -------------------------------------------------------------------------
  it('rebuilds a chip from an inlined text attachment and DROPS the model-view content', async () => {
    const fileContent = 'qa-marker\nsecret line that must not leak\nthird line';
    const got = await getWithUserContent((convId: string) => [
      {
        type: 'text',
        text:
          `User attached 'qa-marker.txt' at .ax/uploads/${convId}/req-x/ab__qa-marker.txt (text/plain)\n\n` +
          fileContent,
      },
    ]);
    const user = got.turns.find((t) => t.role === 'user');
    // Exactly one block: the reconstructed attachment chip. No text block
    // carrying the inlined content.
    expect(user?.contentBlocks).toEqual([
      {
        type: 'attachment',
        path: expect.stringContaining('.ax/uploads/') as unknown as string,
        displayName: 'qa-marker.txt',
        mediaType: 'text/plain',
        sizeBytes: 0,
      },
    ]);
    // The chip is downloadable: the workspace-relative path is preserved.
    const att = user!.contentBlocks[0] as { path: string };
    expect(att.path).toBe(`.ax/uploads/${got.conversation.conversationId}/req-x/ab__qa-marker.txt`);
    // The runner's model-view text (preamble + file content) is NOT surfaced
    // anywhere in the user turn.
    const serialized = JSON.stringify(user?.contentBlocks);
    expect(serialized).not.toContain('secret line that must not leak');
    expect(serialized).not.toContain('bytes):');
    expect(serialized).not.toContain('User attached');
  });

  it('keeps the typed prompt (separate block) and converts the inlined-attachment block to a chip', async () => {
    // The runner emits the typed prompt and the inlined attachment as SEPARATE
    // content-array elements (main.ts). Reload must keep the prompt and drop
    // only the attachment's inlined content.
    const got = await getWithUserContent((convId: string) => [
      { type: 'text', text: 'please summarize the attached file' },
      {
        type: 'text',
        text:
          `User attached 'data.json' at .ax/uploads/${convId}/req-y/cd__data.json (application/json)\n\n` +
          '{"k":"v","leak":"do-not-show"}',
      },
    ]);
    const user = got.turns.find((t) => t.role === 'user');
    expect(user?.contentBlocks).toEqual([
      { type: 'text', text: 'please summarize the attached file' },
      {
        type: 'attachment',
        path: expect.stringContaining('.ax/uploads/') as unknown as string,
        displayName: 'data.json',
        mediaType: 'application/json',
        sizeBytes: 0,
      },
    ]);
    expect(JSON.stringify(user?.contentBlocks)).not.toContain('do-not-show');
  });

  it('reconstructs EVERY chip when several bare mentions coalesce into one text block (no early break)', async () => {
    // Regression (TASK-21 Codex P2): the SDK can coalesce adjacent text blocks
    // into one newline-joined block. Two bare (non-inlined) attachment mentions
    // become `mention1\nmention2`. The inline-strip `break` must NOT fire here
    // (a bare mention has no trailing blank line), so both chips reconstruct
    // and trailing user text survives.
    const got = await getWithUserContent((convId: string) => [
      {
        type: 'text',
        text:
          `User attached 'a.pdf' at .ax/uploads/${convId}/req-1/aa__a.pdf (application/pdf)\n` +
          `User attached 'b.pdf' at .ax/uploads/${convId}/req-1/bb__b.pdf (application/pdf)\n` +
          'thanks',
      },
    ]);
    const user = got.turns.find((t) => t.role === 'user');
    expect(user?.contentBlocks).toEqual([
      {
        type: 'attachment',
        path: expect.stringContaining('aa__a.pdf') as unknown as string,
        displayName: 'a.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 0,
      },
      {
        type: 'attachment',
        path: expect.stringContaining('bb__b.pdf') as unknown as string,
        displayName: 'b.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 0,
      },
      { type: 'text', text: 'thanks' },
    ]);
  });

  it('reconstructs BOTH chips when two inline attachments arrive as SEPARATE blocks (drops both bodies)', async () => {
    // The runner emits each attachment as its OWN content-array element, and
    // the event-log projection keeps array elements as separate ContentBlocks
    // — so two inline attachments arrive as two separate text blocks, each
    // handled independently. Both chips reconstruct; neither body leaks.
    const got = await getWithUserContent((convId: string) => [
      {
        type: 'text',
        text:
          `User attached 'a.txt' at .ax/uploads/${convId}/req-1/aa__a.txt (text/plain)\n\n` +
          'BODY-ONE-secret',
      },
      {
        type: 'text',
        text:
          `User attached 'b.json' at .ax/uploads/${convId}/req-1/bb__b.json (application/json)\n\n` +
          'BODY-TWO-secret',
      },
    ]);
    const user = got.turns.find((t) => t.role === 'user');
    expect(user?.contentBlocks).toEqual([
      {
        type: 'attachment',
        path: expect.stringContaining('aa__a.txt') as unknown as string,
        displayName: 'a.txt',
        mediaType: 'text/plain',
        sizeBytes: 0,
      },
      {
        type: 'attachment',
        path: expect.stringContaining('bb__b.json') as unknown as string,
        displayName: 'b.json',
        mediaType: 'application/json',
        sizeBytes: 0,
      },
    ]);
    const serialized = JSON.stringify(user?.contentBlocks);
    expect(serialized).not.toContain('BODY-ONE-secret');
    expect(serialized).not.toContain('BODY-TWO-secret');
  });

  it('does NOT leak inline content even when a body line spoofs an in-prefix mention (security)', async () => {
    // Adversarial (TASK-21 Codex P2 round-2): the attachment's own bytes
    // contain a line that parses as a valid in-prefix mention. The inline-strip
    // must drop the ENTIRE body once the real preamble is seen — a spoofed
    // mention inside the content must NOT terminate the suppression and resume
    // surfacing the remaining bytes.
    const got = await getWithUserContent((convId: string) => [
      {
        type: 'text',
        text:
          `User attached 'a.txt' at .ax/uploads/${convId}/req-1/aa__a.txt (text/plain)\n\n` +
          `harmless line\n` +
          `User attached 'spoof.txt' at .ax/uploads/${convId}/req-1/zz__spoof.txt (text/plain)\n` +
          `SENSITIVE-trailing-bytes`,
      },
    ]);
    const user = got.turns.find((t) => t.role === 'user');
    // Exactly one chip (the real attachment); the entire body — including the
    // spoofed-mention line and everything after it — is dropped.
    expect(user?.contentBlocks).toEqual([
      {
        type: 'attachment',
        path: expect.stringContaining('aa__a.txt') as unknown as string,
        displayName: 'a.txt',
        mediaType: 'text/plain',
        sizeBytes: 0,
      },
    ]);
    const serialized = JSON.stringify(user?.contentBlocks);
    expect(serialized).not.toContain('harmless line');
    expect(serialized).not.toContain('SENSITIVE-trailing-bytes');
    expect(serialized).not.toContain('spoof.txt');
  });

  it('does NOT drop content for an inlined mention pointing at a different conversation', async () => {
    // A crafted inline block whose path is NOT under this conversation's
    // prefix is left fully intact (no chip, content NOT stripped) — the
    // prefix guard prevents a false-positive that would both mis-aim a
    // download and silently hide text.
    const text =
      "User attached 'evil.txt' at .ax/uploads/cnv_someoneelse/req-x/ab__evil.txt (text/plain)\n\nbody stays visible";
    const got = await getWithUserContent([{ type: 'text', text }]);
    const user = got.turns.find((t) => t.role === 'user');
    expect(user?.contentBlocks).toEqual([{ type: 'text', text }]);
  });
});
