import { describe, expect, it } from 'vitest';
import {
  ContentBlockSchema,
  formatAttachmentMention,
  parseAttachmentMention,
} from '../content-blocks.js';

describe('ContentBlock schema', () => {
  it('parses a text block', () => {
    expect(ContentBlockSchema.parse({ type: 'text', text: 'hi' })).toEqual({
      type: 'text',
      text: 'hi',
    });
  });

  it('parses a thinking block (J4 — stored)', () => {
    expect(
      ContentBlockSchema.parse({ type: 'thinking', thinking: 'reasoning...' }),
    ).toMatchObject({ type: 'thinking' });
  });

  it('parses a thinking block with signature', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'thinking',
        thinking: 'r',
        signature: 's',
      }),
    ).toMatchObject({ type: 'thinking', signature: 's' });
  });

  it('parses a redacted_thinking block', () => {
    // Anthropic emits this when extended-thinking is flagged and the
    // cleartext is suppressed. Replay (Task 15) MUST preserve the opaque
    // `data` blob verbatim or the model detects a transcript gap.
    expect(
      ContentBlockSchema.parse({ type: 'redacted_thinking', data: 'opaque-blob' }),
    ).toMatchObject({ type: 'redacted_thinking', data: 'opaque-blob' });
  });

  it('parses a tool_use block', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'tool_use',
        id: 'abc',
        name: 'Bash',
        input: { command: 'ls' },
      }),
    ).toMatchObject({ type: 'tool_use', id: 'abc', name: 'Bash' });
  });

  it('parses a tool_result block (string content)', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'tool_result',
        tool_use_id: 'abc',
        content: 'file1\nfile2',
      }),
    ).toMatchObject({ tool_use_id: 'abc' });
  });

  it('parses a tool_result block (array content)', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'tool_result',
        tool_use_id: 'abc',
        content: [{ type: 'text', text: 'ok' }],
      }),
    ).toMatchObject({ tool_use_id: 'abc' });
  });

  it('parses a tool_result block (is_error true)', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'tool_result',
        tool_use_id: 'abc',
        content: 'boom',
        is_error: true,
      }),
    ).toMatchObject({ tool_use_id: 'abc', is_error: true });
  });

  it('parses an image block (base64 source)', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      }),
    ).toMatchObject({ type: 'image' });
  });

  it('parses an image block (url source)', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'image',
        source: { type: 'url', url: 'https://example.com/img.png' },
      }),
    ).toMatchObject({ type: 'image' });
  });

  it('rejects an image block with a malformed url', () => {
    // The url variant uses z.string().url() so a non-URL string is
    // refused at the protocol boundary — keeps clearly-broken values
    // from reaching downstream handlers.
    expect(() =>
      ContentBlockSchema.parse({
        type: 'image',
        source: { type: 'url', url: 'not-a-url' },
      }),
    ).toThrow();
  });

  it('rejects an unknown discriminant', () => {
    expect(() => ContentBlockSchema.parse({ type: 'banana' })).toThrow();
  });

  it('rejects a thinking block missing the thinking field', () => {
    // Catches the ContentBlockShim → canonical regression: the old shim
    // accepted any object; the canonical schema requires `thinking: string`.
    expect(() =>
      ContentBlockSchema.parse({ type: 'thinking', text: 'hmm' }),
    ).toThrow();
  });

  describe('attachment_ref variant', () => {
    it('parses a valid attachment_ref block', () => {
      const block = { type: 'attachment_ref', attachmentId: 'a-123' };
      const parsed = ContentBlockSchema.parse(block);
      expect(parsed).toEqual(block);
    });

    it('rejects attachment_ref without attachmentId', () => {
      const block = { type: 'attachment_ref' };
      expect(() => ContentBlockSchema.parse(block)).toThrow();
    });
  });

  describe('attachment variant', () => {
    it('parses a valid attachment block', () => {
      const block = {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/report.pdf',
        displayName: 'Q4 Report.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 482113,
      };
      const parsed = ContentBlockSchema.parse(block);
      expect(parsed).toEqual(block);
    });

    it('rejects attachment with negative sizeBytes', () => {
      const block = {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/report.pdf',
        displayName: 'Q4 Report.pdf',
        mediaType: 'application/pdf',
        sizeBytes: -1,
      };
      expect(() => ContentBlockSchema.parse(block)).toThrow();
    });

    it('rejects attachment missing displayName', () => {
      const block = {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/report.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 100,
      };
      expect(() => ContentBlockSchema.parse(block)).toThrow();
    });

    it.each([
      '/etc/passwd',
      '\\windows\\system32',
      'C:\\Users\\foo.txt',
      '../escape',
      'a/../b',
      'a/b/..',
      'foo\0bar',
    ])('rejects non-workspace-relative path %j', (badPath) => {
      const block = {
        type: 'attachment',
        path: badPath,
        displayName: 'x',
        mediaType: 'application/octet-stream',
        sizeBytes: 1,
      };
      expect(() => ContentBlockSchema.parse(block)).toThrow();
    });
  });

  describe('attachment mention format/parse', () => {
    it('round-trips a plain mention', () => {
      const fields = {
        displayName: 'Disaster Recovery Plan - v3.pdf',
        path: '.ax/uploads/cnv_abc/req-def/a60d__Disaster_Recovery_Plan_-_v3.pdf',
        mediaType: 'application/pdf',
      };
      const text = formatAttachmentMention(fields);
      expect(text).toBe(
        "User attached 'Disaster Recovery Plan - v3.pdf' at " +
          '.ax/uploads/cnv_abc/req-def/a60d__Disaster_Recovery_Plan_-_v3.pdf ' +
          '(application/pdf)',
      );
      expect(parseAttachmentMention(text)).toEqual(fields);
    });

    it("round-trips a displayName containing ' at '", () => {
      const fields = {
        displayName: "dinner at 8 pm.txt",
        path: '.ax/uploads/cnv_x/req-y/h__dinner_at_8_pm.txt',
        mediaType: 'text/plain',
      };
      const parsed = parseAttachmentMention(formatAttachmentMention(fields));
      expect(parsed).toEqual(fields);
    });

    it('round-trips a path containing spaces (paths may contain whitespace)', () => {
      // isWorkspaceRelativePath permits spaces, so the parser must too —
      // the greedy path capture backtracks to the final " (mediaType)".
      const fields = {
        displayName: 'Q4 Report.pdf',
        path: '.ax/uploads/cnv_x/req-y/ab12__Q4 Report (final).pdf',
        mediaType: 'application/pdf',
      };
      const parsed = parseAttachmentMention(formatAttachmentMention(fields));
      expect(parsed).toEqual(fields);
    });

    it('returns null for unrelated text', () => {
      expect(parseAttachmentMention('Summarize this file')).toBeNull();
      expect(parseAttachmentMention('')).toBeNull();
      expect(
        parseAttachmentMention("User attached 'x' at /abs/path"),
      ).toBeNull();
    });

    it('returns null when the mention is not the whole string (multi-line)', () => {
      // A merged "user-text\nmention" block must be split by the caller; the
      // anchored, single-line regex refuses embedded newlines so the prefix
      // text never gets folded into the displayName.
      const mention = formatAttachmentMention({
        displayName: 'f.pdf',
        path: '.ax/uploads/c/t/h__f.pdf',
        mediaType: 'application/pdf',
      });
      expect(parseAttachmentMention(`Summarize this file\n${mention}`)).toBeNull();
      expect(parseAttachmentMention(mention)).not.toBeNull();
    });
  });
});
