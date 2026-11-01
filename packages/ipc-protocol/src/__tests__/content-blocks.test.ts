import { describe, expect, it } from 'vitest';
import {
  AGENT_FILE_PATH_MAX,
  AgentFileBlockSchema,
  AgentFilePathSchema,
  AttachmentBlockSchema,
  ContentBlockSchema,
  agentFileBlock,
  attachmentBlockFromArtifact,
  isAgentFilePath,
} from '../content-blocks.js';

/**
 * A key exactly `n` UTF-16 units long whose every segment is a legal name
 * (99 units, then the remainder), so the only rule it can break is the
 * total length.
 */
function keyOfLength(n: number): string {
  const head = `${'k'.repeat(99)}/`.repeat(40);
  return head + 'k'.repeat(n - head.length);
}

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

  // TASK-1012: a file the agent created in its files, attached by its key
  // there. The key rule must match what the download route will accept
  // (channel-web's `workspaceFilePath`); the parity test lives in
  // channel-web because that function needs `node:path`.
  describe('agent_file variant', () => {
    const valid = {
      type: 'agent_file',
      path: 'docs/report.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 12,
    };

    it.each([
      'docs/report.pdf',
      '.gitignore',
      'reports/Q3 plan #1 (50%).pdf',
      '📊 chart.png',
    ])('accepts the key %j', (path) => {
      expect(AgentFileBlockSchema.parse({ ...valid, path })).toStrictEqual({ ...valid, path });
      expect(isAgentFilePath(path)).toBe(true);
    });

    it.each([
      ['an empty key', ''],
      ['an absolute path', '/etc/passwd'],
      ['a leading traversal', '../x'],
      ['an inner traversal', 'a/../b'],
      ['an empty segment', 'a//b'],
      ['a trailing slash', 'a/'],
      ['a leading dot segment', './a'],
      ['an inner dot segment', 'a/./b'],
      ['a backslash', 'a\\b'],
      ['a colon', 'a:b'],
      ['a double dot inside a name', 'a..b'],
      ['a NUL byte', 'a\u0000b'],
      ['a leading space', ' a'],
      ['a trailing dot', 'a.'],
      ['a trailing space', 'a '],
      ['a lone high surrogate', 'a\uD800b'],
      ['a lone low surrogate', 'a\uDC00b'],
      ['a 256-unit segment', 's'.repeat(256)],
      ['a 4097-unit key', keyOfLength(AGENT_FILE_PATH_MAX + 1)],
    ])('refuses a key with %s', (_label, path) => {
      expect(isAgentFilePath(path)).toBe(false);
      expect(AgentFilePathSchema.safeParse(path).success).toBe(false);
      expect(AgentFileBlockSchema.safeParse({ ...valid, path }).success).toBe(false);
      expect(ContentBlockSchema.safeParse({ ...valid, path }).success).toBe(false);
    });

    it('accepts a key at the limits: a 255-unit segment and a 4096-unit key', () => {
      expect(AGENT_FILE_PATH_MAX).toBe(4096);
      for (const path of ['s'.repeat(255), `d/${'s'.repeat(255)}`, keyOfLength(AGENT_FILE_PATH_MAX)]) {
        expect(isAgentFilePath(path)).toBe(true);
        expect(AgentFileBlockSchema.safeParse({ ...valid, path }).success).toBe(true);
      }
    });

    it('refuses extra fields rather than stripping them (.strict())', () => {
      // No `filename`: the label is derived on the host from the key, so a
      // chip cannot show one name and download another.
      expect(AgentFileBlockSchema.safeParse({ ...valid, filename: 'report.pdf' }).success).toBe(false);
      expect(AgentFileBlockSchema.safeParse({ ...valid, attachmentId: '0123456789abcdef' }).success).toBe(false);
      expect(ContentBlockSchema.safeParse({ ...valid, filename: 'report.pdf' }).success).toBe(false);
    });

    it.each([
      ['an empty mediaType', { mediaType: '' }],
      ['a 256-character mediaType', { mediaType: 'm'.repeat(256) }],
      ['a negative sizeBytes', { sizeBytes: -1 }],
      ['a fractional sizeBytes', { sizeBytes: 1.5 }],
      ['a string sizeBytes', { sizeBytes: '12' }],
      ['a missing path', { path: undefined }],
      ['a missing mediaType', { mediaType: undefined }],
      ['a missing sizeBytes', { sizeBytes: undefined }],
    ])('refuses %s', (_label, patch) => {
      expect(AgentFileBlockSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
    });

    it('accepts a 255-character mediaType and a zero sizeBytes', () => {
      expect(
        AgentFileBlockSchema.safeParse({ ...valid, mediaType: 'm'.repeat(255), sizeBytes: 0 }).success,
      ).toBe(true);
    });

    it('parses through ContentBlockSchema', () => {
      expect(ContentBlockSchema.safeParse(valid).success).toBe(true);
      expect(ContentBlockSchema.parse(valid)).toStrictEqual(valid);
    });
  });

  describe('agentFileBlock', () => {
    it('builds the block from its fields', () => {
      expect(
        agentFileBlock({ path: 'reports/q3.pdf', mediaType: 'application/pdf', sizeBytes: 7 }),
      ).toStrictEqual({ type: 'agent_file', path: 'reports/q3.pdf', mediaType: 'application/pdf', sizeBytes: 7 });
    });

    it.each([
      ['a name the Files tab cannot address', { path: 'a:b', mediaType: 'text/plain', sizeBytes: 1 }],
      ['a traversal', { path: '../x', mediaType: 'text/plain', sizeBytes: 1 }],
      ['a non-string path', { path: 42, mediaType: 'text/plain', sizeBytes: 1 }],
      ['an empty mediaType', { path: 'a.txt', mediaType: '', sizeBytes: 1 }],
      ['a negative size', { path: 'a.txt', mediaType: 'text/plain', sizeBytes: -1 }],
    ])('returns null for %s', (_label, value) => {
      expect(agentFileBlock(value)).toBeNull();
    });
  });
});
