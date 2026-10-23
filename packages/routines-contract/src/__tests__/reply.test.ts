import { describe, expect, it } from 'vitest';
import {
  ROUTINE_REPLY_MAX_CHARS, RoutineRecentRepliesInputSchema, RoutineRecentRepliesOutputSchema,
  RoutineReplyCheckInSchema, RoutineReplyInputSchema, RoutineReplyOutputSchema, RoutineReplyTextSchema,
} from '../index.js';

// A reply is what a task's owner writes to their agent on the task page
// (TASK-931). The host stores it, and it reaches a model only inside a later
// check-in message. The text rule's messages reach the person: the reply box
// runs this same schema before it sends. Every invisible character below is
// built from its code point, never typed: an invisible character in source is
// the very thing being tested.

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const TAG_LATIN_A = String.fromCodePoint(0xe0041);
const SOFT_HYPHEN = String.fromCodePoint(0xad);
const EMOJI = String.fromCodePoint(0x1f600);
const LONE_SURROGATE = String.fromCharCode(0xd800);

/** The text rule's issue messages, or [] when it parses. */
const messagesOf = (text: unknown): string[] => {
  const result = RoutineReplyTextSchema.safeParse(text);
  return result.success ? [] : result.error.issues.map(issue => issue.message);
};

describe('a reply’s text (TASK-931)', () => {
  it('is capped at 2,000 characters', () => {
    expect(ROUTINE_REPLY_MAX_CHARS).toBe(2000);
  });

  it.each([
    ['two paragraphs', 'Refunds under $100 are fine.\n\nAsk me about the rest.'],
    ['exactly the cap', 'x'.repeat(2000)],
    ['the cap, ending in a whole emoji (two UTF-16 units)', `${'x'.repeat(1998)}${EMOJI}`],
    ['tabs and CRLF', 'a\tb\r\nc'],
    // A person's own words: their spacing isn't trimmed or refused.
    ['the person’s own padding', '  Thanks!\n\n\n\nOne more thing.  '],
  ])('accepts %s, unchanged', (_label, text) => {
    expect(RoutineReplyTextSchema.parse(text)).toBe(text);
  });

  it.each([
    ['empty text', '', 'Write a reply first.'],
    ['blank text', ' \n\t ', 'Write a reply first.'],
    ['text over the cap', 'x'.repeat(2001), 'A reply can be up to 2,000 characters.'],
    // The cap speaks alone: blank text over the cap gets one reason, not two.
    ['blank text over the cap', ' '.repeat(2001), 'A reply can be up to 2,000 characters.'],
    ['a zero-width space', `ok${ZERO_WIDTH_SPACE}then`, 'A reply can’t contain invisible characters (U+200B at character 3).'],
    ['a tag character', `${TAG_LATIN_A}hi`, 'A reply can’t contain invisible characters (U+E0041 at character 1).'],
    // Counted as a person counts, in characters (the emoji is one), and the code point padded to four digits.
    ['a soft hyphen after an emoji', `${EMOJI} ok${SOFT_HYPHEN}`, 'A reply can’t contain invisible characters (U+00AD at character 5).'],
    ['a lone surrogate', `ok${LONE_SURROGATE}`, 'A reply can’t contain broken characters.'],
  ])('refuses %s with one reason, in the person’s words', (_label, text, message) => {
    expect(messagesOf(text)).toEqual([message]);
  });
});

describe('routines:reply (TASK-931)', () => {
  const input = { agentId: 'a', routineId: 'r', requestId: 'q', text: 'hi' } as const;
  const accepts = (value: unknown): boolean => RoutineReplyInputSchema.safeParse(value).success;

  it('takes a routine’s key, a request id and the text, and nothing else', () => {
    expect(RoutineReplyInputSchema.parse(input)).toEqual(input);
    // The host names the author from the caller, never from the input.
    expect(accepts({ ...input, authorUserId: 'owner' })).toBe(false);
    const { requestId: _requestId, ...noRequestId } = input;
    expect(accepts(noRequestId)).toBe(false);
    expect(accepts({ ...input, requestId: '' })).toBe(false);
    expect(accepts({ ...input, requestId: 'q'.repeat(256) })).toBe(true);
    expect(accepts({ ...input, requestId: 'q'.repeat(257) })).toBe(false);
  });

  it('holds the text rule, so no caller can store what the reply box refuses', () => {
    for (const text of [' ', 'x'.repeat(2001), `ok${ZERO_WIDTH_SPACE}then`, `ok${LONE_SURROGATE}`]) {
      expect(accepts({ ...input, text }), `${text.length} units`).toBe(false);
    }
  });

  it.each(['started', 'paused', 'not-allowed', 'replayed'] as const)('answers a reply id and checkIn %s', checkIn => {
    expect(RoutineReplyOutputSchema.parse({ replyId: 'reply_1', checkIn })).toEqual({ replyId: 'reply_1', checkIn });
  });

  it('answers only those four check-in words, and nothing else', () => {
    expect(RoutineReplyCheckInSchema.options).toEqual(['started', 'paused', 'not-allowed', 'replayed']);
    const answers = (value: unknown): boolean => RoutineReplyOutputSchema.safeParse(value).success;
    expect(answers({ replyId: 'reply_1', checkIn: 'finished' })).toBe(false);
    expect(answers({ replyId: 'reply_1', checkIn: 'started', status: 'ok' })).toBe(false);
    expect(answers({ checkIn: 'started' })).toBe(false);
  });
});

describe('routines:recent-replies (TASK-931)', () => {
  const key = { agentId: 'a', routineId: 'r' } as const;

  it('takes a routine’s key and an optional limit from 1 to 50', () => {
    for (const input of [key, { ...key, limit: 1 }, { ...key, limit: 50 }]) {
      expect(RoutineRecentRepliesInputSchema.parse(input)).toEqual(input);
    }
    for (const input of [{ ...key, limit: 0 }, { ...key, limit: 51 }, { ...key, limit: 1.5 }, { ...key, authorUserId: 'owner' }]) {
      expect(RoutineRecentRepliesInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('answers each reply’s id, author, text and time, and doesn’t re-cap stored text', () => {
    const reply = { replyId: 'reply_1', authorUserId: 'owner', text: 'x'.repeat(3000), sentAt: '2026-10-23T09:00:00.000Z' } as const;
    // Stored text isn't re-capped (TASK-913): a later cap change can't make a stored reply unreadable.
    expect(RoutineRecentRepliesOutputSchema.parse({ replies: [reply] })).toEqual({ replies: [reply] });
    expect(RoutineRecentRepliesOutputSchema.parse({ replies: [] })).toEqual({ replies: [] });
    const answers = (value: unknown): boolean => RoutineRecentRepliesOutputSchema.safeParse(value).success;
    expect(answers({ replies: [{ ...reply, ownerUserId: 'owner' }] })).toBe(false);
    expect(answers({ replies: [reply], more: false })).toBe(false);
    expect(answers({ replies: [{ ...reply, sentAt: 'yesterday' }] })).toBe(false);
  });
});
