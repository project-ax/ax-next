import { describe, expect, it } from 'vitest';
import { MEMORY_PRE_CAPTURE_HOOK, MemoryPreCapturePayloadSchema } from '../index.js';

describe('memory:pre-capture contract (TASK-908)', () => {
  it('names the event', () => expect(MEMORY_PRE_CAPTURE_HOOK).toBe('memory:pre-capture'));
  it('accepts a conversation id', () =>
    expect(MemoryPreCapturePayloadSchema.parse({ conversationId: 'c' })).toEqual({ conversationId: 'c' }));
  it('drops an unknown key instead of refusing the payload', () =>
    expect(MemoryPreCapturePayloadSchema.parse({ conversationId: 'c', later: 1 })).toEqual({ conversationId: 'c' }));
  it.each([
    ['no conversationId', {}],
    ['an empty conversationId', { conversationId: '' }],
    ['a non-string conversationId', { conversationId: 7 }],
  ])('refuses %s', (_l, value) => expect(MemoryPreCapturePayloadSchema.safeParse(value).success).toBe(false));
});
