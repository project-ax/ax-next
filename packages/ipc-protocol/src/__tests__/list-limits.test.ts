import { describe, expect, it } from 'vitest';
import {
  AgentMessageSchema,
  CHAT_END_MESSAGES_MAX,
  CONTENT_BLOCKS_MAX,
  ContentBlockSchema,
  EventChatEndSchema,
  EventTurnEndSchema,
} from '../index.js';

// TASK-945. Junk elements (`0`) would each fail on their own, so a result
// holding ONLY the size issue shows the list was refused before any element
// was parsed.
const junk = (n: number): unknown[] => Array.from({ length: n }, () => 0);
const texts = (n: number): unknown[] => Array.from({ length: n }, () => ({ type: 'text', text: 'x' }));
const messages = (n: number): unknown[] => Array.from({ length: n }, () => ({ role: 'user', content: 'x' }));

function expectOnlySizeIssue(
  r: { success: boolean; error?: { issues: unknown[] } },
  path: (string | number)[],
  maximum: number,
): void {
  expect(r.success).toBe(false);
  expect(r.error?.issues).toEqual([expect.objectContaining({ code: 'too_big', type: 'array', path, maximum })]);
}

describe('runner→host list limits (TASK-945)', () => {
  // The "takes the limit" cases below build their lists FROM the constants, so
  // they cannot see a lowered limit. A lowered limit is the dangerous direction:
  // a refused turn-end loses that turn's display frame silently (the runner
  // swallows the 400). Pin the sized values; raising or lowering one is a
  // decision to make on purpose (see the constants' comments).
  it('pins the sized values', () => {
    expect(CONTENT_BLOCKS_MAX).toBe(50_000);
    expect(CHAT_END_MESSAGES_MAX).toBe(50_000);
  });

  it('event.turn-end takes CONTENT_BLOCKS_MAX blocks', () => {
    const r = EventTurnEndSchema.safeParse({
      reason: 'complete',
      role: 'tool',
      contentBlocks: texts(CONTENT_BLOCKS_MAX),
    });
    expect(r.success).toBe(true);
  });

  it('event.turn-end with one block over fails with only the size issue', () => {
    const r = EventTurnEndSchema.safeParse({
      reason: 'complete',
      contentBlocks: junk(CONTENT_BLOCKS_MAX + 1),
    });
    expectOnlySizeIssue(r, ['contentBlocks'], CONTENT_BLOCKS_MAX);
  });

  it('event.chat-end takes CHAT_END_MESSAGES_MAX messages', () => {
    const r = EventChatEndSchema.safeParse({
      outcome: { kind: 'complete', messages: messages(CHAT_END_MESSAGES_MAX) },
    });
    expect(r.success).toBe(true);
  });

  it('event.chat-end with one message over fails with only the size issue', () => {
    const r = EventChatEndSchema.safeParse({
      outcome: { kind: 'complete', messages: junk(CHAT_END_MESSAGES_MAX + 1) },
    });
    expectOnlySizeIssue(r, ['outcome', 'messages'], CHAT_END_MESSAGES_MAX);
  });

  it('event.chat-end takes a message with CONTENT_BLOCKS_MAX blocks and refuses one more with only the size issue', () => {
    const atLimit = EventChatEndSchema.safeParse({
      outcome: {
        kind: 'complete',
        messages: [{ role: 'assistant', content: '', contentBlocks: texts(CONTENT_BLOCKS_MAX) }],
      },
    });
    expect(atLimit.success).toBe(true);

    const r = EventChatEndSchema.safeParse({
      outcome: {
        kind: 'complete',
        messages: [{ role: 'assistant', content: '', contentBlocks: junk(CONTENT_BLOCKS_MAX + 1) }],
      },
    });
    expectOnlySizeIssue(r, ['outcome', 'messages', 0, 'contentBlocks'], CONTENT_BLOCKS_MAX);
  });

  it('AgentMessageSchema (also the session.next-message and session.get-display-history payloads) takes CONTENT_BLOCKS_MAX blocks and refuses one more', () => {
    const atLimit = AgentMessageSchema.safeParse({
      role: 'user',
      content: '',
      contentBlocks: texts(CONTENT_BLOCKS_MAX),
    });
    expect(atLimit.success).toBe(true);

    const r = AgentMessageSchema.safeParse({
      role: 'user',
      content: '',
      contentBlocks: junk(CONTENT_BLOCKS_MAX + 1),
    });
    expectOnlySizeIssue(r, ['contentBlocks'], CONTENT_BLOCKS_MAX);
  });

  it('leaves tool_result.content unbounded: stored turns re-parse with ContentBlockSchema, and the read path drops a turn that fails', () => {
    const r = ContentBlockSchema.safeParse({
      type: 'tool_result',
      tool_use_id: 't',
      content: texts(CONTENT_BLOCKS_MAX + 1),
    });
    expect(r.success).toBe(true);
  });
});
