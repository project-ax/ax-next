import { describe, it, expect, vi } from 'vitest';
import { parseAttachmentMention, type ContentBlock } from '@ax/ipc-protocol';
import {
  MAX_INLINE_BYTES,
  translateContentBlocks,
} from '../attachment-translation.js';

function fakeReader(map: Record<string, Buffer>) {
  return vi.fn(async (path: string) => {
    const bytes = map[path];
    if (bytes === undefined) return { found: false as const };
    return { found: true as const, bytesBase64: bytes.toString('base64') };
  });
}

describe('translateContentBlocks', () => {
  it('passes through plain text blocks unchanged', async () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hello' }];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({}),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('maps image attachments to Anthropic image blocks (base64 source)', async () => {
    const png = Buffer.from('fake-png-bytes');
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'see' },
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/img.png',
        displayName: 'img.png',
        mediaType: 'image/png',
        sizeBytes: png.length,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({ '.ax/uploads/c1/t1/img.png': png }),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      { type: 'text', text: 'see' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: png.toString('base64'),
        },
      },
    ]);
  });

  it('falls back to a text mention when the reader throws (IPC failure)', async () => {
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/img.png',
        displayName: 'img.png',
        mediaType: 'image/png',
        sizeBytes: 1,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: vi.fn(async () => {
        throw new Error('IPC connection refused');
      }),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /User attached 'img\.png' at \.ax\/uploads\/c1\/t1\/img\.png \(image\/png\)/,
        ),
      },
    ]);
  });

  it('falls back to a text mention when the image is missing from the workspace', async () => {
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/missing.png',
        displayName: 'missing.png',
        mediaType: 'image/png',
        sizeBytes: 1,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({}),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /User attached 'missing\.png' at \.ax\/uploads\/c1\/t1\/missing\.png \(image\/png\)/,
        ),
      },
    ]);
  });

  it('maps PDF attachments to document blocks when SDK supports them', async () => {
    const pdf = Buffer.from('%PDF-');
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/x.pdf',
        displayName: 'X.pdf',
        mediaType: 'application/pdf',
        sizeBytes: pdf.length,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({ '.ax/uploads/c1/t1/x.pdf': pdf }),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: pdf.toString('base64'),
        },
      },
    ]);
  });

  it('falls back to a text mention for PDFs when SDK does not support document blocks', async () => {
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/x.pdf',
        displayName: 'X.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 5,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({ '.ax/uploads/c1/t1/x.pdf': Buffer.from('%PDF-') }),
      supportsDocumentBlocks: false,
    });
    expect(out).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /User attached 'X\.pdf' at \.ax\/uploads\/c1\/t1\/x\.pdf \(application\/pdf\)/,
        ),
      },
    ]);
  });

  it('inlines small text/plain attachment content with the canonical path-bearing mention preamble', async () => {
    const body = Buffer.from('hello, this is the file content');
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/notes.txt',
        displayName: 'notes.txt',
        mediaType: 'text/plain',
        sizeBytes: body.length,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({ '.ax/uploads/c1/t1/notes.txt': body }),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      {
        type: 'text',
        // The preamble is the canonical mention (carries the path) so the
        // read path can rebuild the chip + strip this block on reload.
        text:
          `User attached 'notes.txt' at .ax/uploads/c1/t1/notes.txt (text/plain)\n\n` +
          body.toString('utf8'),
      },
    ]);
  });

  it("the inlined preamble's first line round-trips through parseAttachmentMention (path preserved)", async () => {
    const body = Buffer.from('the body');
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/notes.txt',
        displayName: 'notes.txt',
        mediaType: 'text/plain',
        sizeBytes: body.length,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({ '.ax/uploads/c1/t1/notes.txt': body }),
      supportsDocumentBlocks: true,
    });
    const block = out[0] as { type: string; text: string };
    const firstLine = block.text.split('\n', 1)[0]!;
    expect(parseAttachmentMention(firstLine)).toEqual({
      displayName: 'notes.txt',
      path: '.ax/uploads/c1/t1/notes.txt',
      mediaType: 'text/plain',
    });
    expect(block.text).toContain('the body');
  });

  it.each([
    ['text/markdown', '# heading\n\nbody'],
    ['text/csv', 'col1,col2\n1,2'],
    ['application/json', '{"hello":"world"}'],
    ['application/xml', '<root><a>1</a></root>'],
    ['application/yaml', 'foo: bar\n'],
    ['application/x-yaml', 'foo: bar\n'],
  ])('inlines small %s attachment content', async (mediaType, content) => {
    const body = Buffer.from(content);
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: `.ax/uploads/c1/t1/file`,
        displayName: 'file',
        mediaType,
        sizeBytes: body.length,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({ '.ax/uploads/c1/t1/file': body }),
      supportsDocumentBlocks: true,
    });
    expect(out).toHaveLength(1);
    const block = out[0] as { type: string; text: string };
    expect(block.type).toBe('text');
    expect(block.text).toContain(content);
    expect(block.text).toContain(mediaType);
    // First line is the canonical path-bearing mention.
    expect(block.text.split('\n', 1)[0]).toBe(
      `User attached 'file' at .ax/uploads/c1/t1/file (${mediaType})`,
    );
  });

  it('falls back to a text mention for text content exceeding MAX_INLINE_BYTES', async () => {
    // Size threshold check is on `sizeBytes` from the block — we don't even
    // need real bytes for the test, just the metadata over the cap.
    const reader = fakeReader({});
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/big.csv',
        displayName: 'big.csv',
        mediaType: 'text/csv',
        sizeBytes: MAX_INLINE_BYTES + 1,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: reader,
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /User attached 'big\.csv' at \.ax\/uploads\/c1\/t1\/big\.csv \(text\/csv\)/,
        ),
      },
    ]);
    // Critical: oversized text MUST NOT trigger an IPC fetch — wasted
    // bandwidth and a step toward OOM on a malicious mediaType claim.
    expect(reader).not.toHaveBeenCalled();
  });

  it('falls back to a text mention for binary types we can not inline (zip, mp4)', async () => {
    const reader = fakeReader({});
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/archive.zip',
        displayName: 'archive.zip',
        mediaType: 'application/zip',
        sizeBytes: 1024,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: reader,
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /User attached 'archive\.zip' at \.ax\/uploads\/c1\/t1\/archive\.zip \(application\/zip\)/,
        ),
      },
    ]);
    expect(reader).not.toHaveBeenCalled();
  });

  it('falls back to a text mention when an inlineable file is missing from the workspace', async () => {
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/notes.txt',
        displayName: 'notes.txt',
        mediaType: 'text/plain',
        sizeBytes: 12,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({}),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /User attached 'notes\.txt' at \.ax\/uploads\/c1\/t1\/notes\.txt \(text\/plain\)/,
        ),
      },
    ]);
  });

  it('decodes invalid UTF-8 in a text-claimed attachment with replacement chars (no throw)', async () => {
    // A file mis-labeled as text/plain that contains binary bytes. Node's
    // Buffer.toString('utf8') replaces invalid sequences with U+FFFD. The
    // model sees noisy output but the turn completes — same posture the
    // design takes on MIME-spoofing.
    const body = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01]);
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/lying.txt',
        displayName: 'lying.txt',
        mediaType: 'text/plain',
        sizeBytes: body.length,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({ '.ax/uploads/c1/t1/lying.txt': body }),
      supportsDocumentBlocks: true,
    });
    const block = out[0] as { type: string; text: string };
    expect(block.type).toBe('text');
    expect(block.text).toContain('User attached');
    // Replacement char appears for invalid sequences.
    expect(block.text).toContain('�');
  });

  it('passes through other ContentBlock variants (tool_use, thinking) unchanged', async () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'toolu_1', name: 'foo', input: {} },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({}),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'foo', input: {} }]);
  });

  it('emits a defensive text mention when an attachment_ref reaches the runner', async () => {
    // attachment_ref is a transit-only variant — Phase 3's chat-messages
    // handler is supposed to resolve them to `attachment` blocks before
    // the runner sees the user message. If one slips through (host bug,
    // schema drift) the runner emits a provenance-preserving text block
    // rather than crashing the turn. This exercises that fallback path.
    const blocks: ContentBlock[] = [
      { type: 'attachment_ref', attachmentId: 'att_123abc' },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({}),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      {
        type: 'text',
        text: '[runner: attachment_ref att_123abc not committed]',
      },
    ]);
  });
});
