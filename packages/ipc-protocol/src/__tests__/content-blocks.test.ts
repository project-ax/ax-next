import { describe, expect, it } from 'vitest';
import {
  AttachmentBlockSchema,
  ContentBlockSchema,
  attachmentBlockFromArtifact,
  formatAttachmentInline,
  formatAttachmentMention,
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
    // An upload (store-temp UUID) and a published artifact (hex id) — the two
    // id shapes the system mints today.
    const UPLOAD_ID = '3f1c2b9e-7d4a-4c1e-9b8f-2a6d5e4c3b1a';
    const ARTIFACT_ID = '0123456789abcdef';
    const valid = {
      type: 'attachment',
      attachmentId: UPLOAD_ID,
      filename: 'a.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 10,
    };

    it('parses an id-addressed upload block', () => {
      expect(ContentBlockSchema.parse(valid)).toEqual(valid);
    });

    it('parses an id-addressed artifact block', () => {
      const block = { ...valid, attachmentId: ARTIFACT_ID, filename: 'r.png', mediaType: 'image/png' };
      expect(ContentBlockSchema.parse(block)).toEqual(block);
    });

    it('rejects the same block plus a path (no sandbox or workspace path on the wire)', () => {
      expect(ContentBlockSchema.safeParse({ ...valid, path: '.ax/uploads/c/t/a.pdf' }).success).toBe(false);
      expect(AttachmentBlockSchema.safeParse({ ...valid, path: 'a.pdf' }).success).toBe(false);
    });

    it('rejects the legacy path-shaped block', () => {
      const legacy = {
        type: 'attachment',
        path: '.ax/uploads/c/t/x__a.pdf',
        displayName: 'a.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 10,
      };
      expect(ContentBlockSchema.safeParse(legacy).success).toBe(false);
    });

    it.each([
      ['a traversal', '../x'],
      ['a slash', 'a/b'],
      ['a backslash', 'a\\b'],
      ['an empty id', ''],
      ['a NUL byte', 'a\0b'],
      ['a space', 'a b'],
      ['129 characters', 'a'.repeat(129)],
    ])('rejects an attachmentId with %s', (_label, attachmentId) => {
      expect(ContentBlockSchema.safeParse({ ...valid, attachmentId }).success).toBe(false);
    });

    it('accepts a 128-character attachmentId', () => {
      expect(ContentBlockSchema.safeParse({ ...valid, attachmentId: 'a'.repeat(128) }).success).toBe(true);
    });

    it.each([
      ['an empty filename', { filename: '' }],
      ['a 1025-character filename', { filename: 'f'.repeat(1025) }],
      ['an empty mediaType', { mediaType: '' }],
      ['a 256-character mediaType', { mediaType: 'm'.repeat(256) }],
      ['a negative sizeBytes', { sizeBytes: -1 }],
      ['a fractional sizeBytes', { sizeBytes: 1.5 }],
      ['a missing filename', { filename: undefined }],
    ])('rejects %s', (_label, patch) => {
      expect(ContentBlockSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
    });

    it('accepts a 1024-character filename and a 255-character mediaType', () => {
      expect(
        ContentBlockSchema.safeParse({ ...valid, filename: 'f'.repeat(1024), mediaType: 'm'.repeat(255) }).success,
      ).toBe(true);
    });
  });

  describe('attachmentBlockFromArtifact', () => {
    it('maps an artifact_publish result to an id-addressed block, dropping its path', () => {
      expect(
        attachmentBlockFromArtifact({
          artifactId: '0123456789abcdef',
          downloadUrl: 'ax://artifact/0123456789abcdef',
          displayName: 'r.pdf',
          mediaType: 'application/pdf',
          sizeBytes: 3,
          sha256: 'a'.repeat(64),
          path: 'r.pdf',
        }),
      ).toStrictEqual({
        type: 'attachment',
        attachmentId: '0123456789abcdef',
        filename: 'r.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 3,
      });
    });

    it.each([
      ['an empty object', {}],
      ['null', null],
      ['a string', 'r.pdf'],
      ['an array', [{ artifactId: '0123456789abcdef' }]],
      ['a traversal id', { artifactId: '../x', displayName: 'r.pdf', mediaType: 'application/pdf', sizeBytes: 3 }],
      ['a missing displayName', { artifactId: '0123456789abcdef', mediaType: 'application/pdf', sizeBytes: 3 }],
      ['a string sizeBytes', { artifactId: '0123456789abcdef', displayName: 'r.pdf', mediaType: 'application/pdf', sizeBytes: '3' }],
    ])('returns null for %s', (_label, value) => {
      expect(attachmentBlockFromArtifact(value)).toBeNull();
    });
  });

  describe('attachment mention format', () => {
    it('renders the one-line, model-facing mention', () => {
      expect(
        formatAttachmentMention({
          displayName: 'Disaster Recovery Plan - v3.pdf',
          path: '/tmp/uploads/Disaster Recovery Plan - v3.pdf',
          mediaType: 'application/pdf',
        }),
      ).toBe(
        "User attached 'Disaster Recovery Plan - v3.pdf' at " +
          '/tmp/uploads/Disaster Recovery Plan - v3.pdf (application/pdf)',
      );
    });
  });

  describe('inlined-attachment format', () => {
    const fields = {
      displayName: 'qa-marker.txt',
      path: '/tmp/uploads/qa-marker.txt',
      mediaType: 'text/plain',
    };

    it('puts the mention on the first line, then a blank line, then content', () => {
      const content = 'line one\nline two';
      const out = formatAttachmentInline(fields, content);
      const lines = out.split('\n');
      expect(lines[0]).toBe(
        "User attached 'qa-marker.txt' at /tmp/uploads/qa-marker.txt (text/plain)",
      );
      expect(lines[1]).toBe('');
      expect(out.endsWith(content)).toBe(true);
    });

    it('preserves content that itself contains newlines and a stray "User attached" line', () => {
      // Adversarial content: a file whose body mimics a mention. The first
      // line is still the genuine preamble; the body is just content.
      const content =
        "User attached 'fake.txt' at /tmp/uploads/other.txt (text/plain)\nreal body";
      const out = formatAttachmentInline(fields, content);
      expect(out.split('\n')[0]).toBe(formatAttachmentMention(fields));
      expect(out).toContain('real body');
    });
  });
});
