import { describe, expect, it } from 'vitest';
import { ToolUseBlockSchema } from '../content-blocks.js';
import { EventStreamChunkSchema } from '../events.js';
import { sanitizeActivityPhrase } from '../activity-phrase.js';

describe('activityPhrase on the tool-call wire shape (TASK-271)', () => {
  it('tool_use block preserves a present phrase', () => {
    const parsed = ToolUseBlockSchema.parse({
      type: 'tool_use',
      id: 'u1',
      name: 'mcp__ax-sandbox-tools__artifact_publish',
      input: {},
      activityPhrase: 'Publishing a file',
    });
    expect(parsed.activityPhrase).toBe('Publishing a file');
  });

  it('tool_use block without a phrase parses as before (backward compat)', () => {
    const parsed = ToolUseBlockSchema.parse({
      type: 'tool_use',
      id: 'u1',
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(parsed.activityPhrase).toBeUndefined();
  });

  it('stream-chunk tool-use preserves a present phrase', () => {
    const parsed = EventStreamChunkSchema.parse({
      reqId: 'r1',
      kind: 'tool-use',
      toolCallId: 'c1',
      toolName: 'memory_search',
      input: { query: 'x' },
      activityPhrase: 'Searching memory',
    });
    expect(parsed.kind).toBe('tool-use');
    if (parsed.kind === 'tool-use') {
      expect(parsed.activityPhrase).toBe('Searching memory');
    }
  });

  it('stream-chunk tool-use without a phrase parses as before', () => {
    const parsed = EventStreamChunkSchema.parse({
      reqId: 'r1',
      kind: 'tool-use',
      toolCallId: 'c1',
      toolName: 'Bash',
      input: {},
    });
    if (parsed.kind === 'tool-use') {
      expect(parsed.activityPhrase).toBeUndefined();
    } else {
      expect.unreachable();
    }
  });
});

describe('sanitizeActivityPhrase', () => {
  it('passes a normal phrase through untouched', () => {
    expect(sanitizeActivityPhrase('Reading email')).toBe('Reading email');
  });

  it('rejects non-strings', () => {
    expect(sanitizeActivityPhrase(undefined)).toBeUndefined();
    expect(sanitizeActivityPhrase(42)).toBeUndefined();
    expect(sanitizeActivityPhrase({})).toBeUndefined();
  });

  it('drops empty and whitespace-only phrases', () => {
    expect(sanitizeActivityPhrase('')).toBeUndefined();
    expect(sanitizeActivityPhrase('   ')).toBeUndefined();
  });

  it('cuts at the first line break (single-line surface)', () => {
    expect(sanitizeActivityPhrase('Reading email\nsecond line')).toBe(
      'Reading email',
    );
    expect(sanitizeActivityPhrase('Reading email\r\nsecond')).toBe(
      'Reading email',
    );
  });

  it('strips ANSI escapes and control characters', () => {
    expect(
      sanitizeActivityPhrase('Reading \u001b[31memail\u001b[0m'),
    ).toBe('Reading email');
    expect(sanitizeActivityPhrase('Read\x00ing')).toBe('Reading');
    expect(sanitizeActivityPhrase('Read\ting')).toBe('Reading');
  });

  it('truncates overlong phrases at the display ceiling', () => {
    const long = 'x'.repeat(200);
    const out = sanitizeActivityPhrase(long);
    expect(out).toBe('x'.repeat(60));
  });

  it('treats shell metacharacters as inert text (no execution at this layer)', () => {
    expect(sanitizeActivityPhrase('"; rm -rf ~; echo "')).toBe(
      '"; rm -rf ~; echo "',
    );
  });
});
