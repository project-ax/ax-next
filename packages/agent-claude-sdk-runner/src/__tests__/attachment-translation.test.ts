import { describe, it, expect, vi } from 'vitest';
import type { ContentBlock } from '@ax/ipc-protocol';
import { translateContentBlocks } from '../attachment-translation.js';

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

  it('maps non-image non-PDF attachments to a text mention (no byte fetch)', async () => {
    const reader = fakeReader({});
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
      readWorkspace: reader,
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
    expect(reader).not.toHaveBeenCalled();
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
});
