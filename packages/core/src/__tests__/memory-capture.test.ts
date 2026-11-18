import { describe, expect, it } from 'vitest';
import {
  MEMORY_PRE_CAPTURE_HOOK,
  MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX,
  MEMORY_PRE_CAPTURE_SPEAKER_NAME_MAX,
  MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS,
  MemoryPreCapturePayloadSchema,
} from '../index.js';

describe('memory:pre-capture contract (TASK-908)', () => {
  it('names the event', () => expect(MEMORY_PRE_CAPTURE_HOOK).toBe('memory:pre-capture'));
  it('bounds each subscriber at 10 s', () => expect(MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS).toBe(10_000));
  it('accepts a conversation id', () =>
    expect(MemoryPreCapturePayloadSchema.parse({ conversationId: 'c' })).toEqual({ conversationId: 'c' }));
  it('drops an unknown key instead of refusing the payload', () =>
    expect(MemoryPreCapturePayloadSchema.parse({ conversationId: 'c', later: 1 })).toEqual({ conversationId: 'c' }));
  it.each([
    ['no conversationId', {}],
    ['an empty conversationId', { conversationId: '' }],
    ['a non-string conversationId', { conversationId: 7 }],
  ])('refuses %s', (_l, value) => expect(MemoryPreCapturePayloadSchema.safeParse(value).success).toBe(false));

  it('bounds speaker names at 32, each at most 256 code units', () => {
    expect(MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX).toBe(32);
    expect(MEMORY_PRE_CAPTURE_SPEAKER_NAME_MAX).toBe(256);
  });
  it('keeps the speaker names a subscriber added (TASK-1146)', () =>
    expect(MemoryPreCapturePayloadSchema.parse({ conversationId: 'c', speakerNames: ['Vinay Pulim', 'UHTE83XE1'] }))
      .toEqual({ conversationId: 'c', speakerNames: ['Vinay Pulim', 'UHTE83XE1'] }));
  it('accepts 32 names of 256, and keeps all of them', () => {
    // `success` alone is not enough: a schema that stripped the key would pass too.
    const speakerNames = Array(32).fill('x'.repeat(256));
    const parsed = MemoryPreCapturePayloadSchema.safeParse({ conversationId: 'c', speakerNames });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.speakerNames).toHaveLength(32);
    expect(parsed.data?.speakerNames).toEqual(speakerNames);
  });
  it('accepts an empty list: a subscriber that adds no names is not an error', () =>
    expect(MemoryPreCapturePayloadSchema.parse({ conversationId: 'c', speakerNames: [] }))
      .toEqual({ conversationId: 'c', speakerNames: [] }));
  it.each([
    ['speakerNames that is not a list', { conversationId: 'c', speakerNames: 'vinay' }],
    ['a speaker name that is not a string', { conversationId: 'c', speakerNames: [7] }],
    ['an empty speaker name', { conversationId: 'c', speakerNames: [''] }],
    ['a speaker name over 256', { conversationId: 'c', speakerNames: ['x'.repeat(257)] }],
    // 129 astral characters are 258 UTF-16 code units: the bound counts units, not characters.
    ['a speaker name of 129 astral characters', { conversationId: 'c', speakerNames: ['\u{1F334}'.repeat(129)] }],
    ['33 speaker names', { conversationId: 'c', speakerNames: Array(33).fill('x') }],
  ])('refuses %s', (_l, value) => expect(MemoryPreCapturePayloadSchema.safeParse(value).success).toBe(false));
});
