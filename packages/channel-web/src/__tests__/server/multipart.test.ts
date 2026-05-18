// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseSingleFileMultipart } from '../../server/multipart';

function buildMultipart(parts: Array<{
  name: string;
  filename?: string;
  contentType?: string;
  body: Buffer | string;
}>, boundary = '----test-boundary'): { buf: Buffer; contentType: string } {
  const enc = (s: string) => Buffer.from(s, 'utf8');
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(enc(`--${boundary}\r\n`));
    let disp = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) disp += `; filename="${p.filename}"`;
    chunks.push(enc(disp + '\r\n'));
    if (p.contentType !== undefined) {
      chunks.push(enc(`Content-Type: ${p.contentType}\r\n`));
    }
    chunks.push(enc('\r\n'));
    chunks.push(typeof p.body === 'string' ? enc(p.body) : p.body);
    chunks.push(enc('\r\n'));
  }
  chunks.push(enc(`--${boundary}--\r\n`));
  return {
    buf: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('parseSingleFileMultipart', () => {
  it('parses a single file part with filename + mimeType', async () => {
    const { buf, contentType } = buildMultipart([
      { name: 'file', filename: 'hello.txt', contentType: 'text/plain', body: 'hi there' },
    ]);
    const result = await parseSingleFileMultipart(buf, contentType);
    expect(result.filename).toBe('hello.txt');
    expect(result.mimeType).toBe('text/plain');
    expect(result.bytes.toString('utf8')).toBe('hi there');
  });

  it('rejects when no file part is present', async () => {
    const { buf, contentType } = buildMultipart([
      { name: 'other', body: 'hi' },
    ]);
    await expect(parseSingleFileMultipart(buf, contentType)).rejects.toThrow(/no file part/);
  });

  it('rejects when the "file" part has no filename', async () => {
    const { buf, contentType } = buildMultipart([
      { name: 'file', contentType: 'text/plain', body: 'hi' },
    ]);
    await expect(parseSingleFileMultipart(buf, contentType)).rejects.toThrow(/filename/);
  });

  it('rejects when more than one file part is present', async () => {
    const { buf, contentType } = buildMultipart([
      { name: 'file', filename: 'a.txt', contentType: 'text/plain', body: 'a' },
      { name: 'file', filename: 'b.txt', contentType: 'text/plain', body: 'b' },
    ]);
    await expect(parseSingleFileMultipart(buf, contentType)).rejects.toThrow(/multiple file parts/);
  });

  it('rejects on missing content-type header', async () => {
    const { buf } = buildMultipart([
      { name: 'file', filename: 'a.txt', contentType: 'text/plain', body: 'a' },
    ]);
    await expect(parseSingleFileMultipart(buf, '')).rejects.toThrow(/content-type/i);
  });

  it('rejects multipart/* subtypes other than form-data', async () => {
    const { buf } = buildMultipart([
      { name: 'file', filename: 'a.txt', contentType: 'text/plain', body: 'a' },
    ]);
    await expect(
      parseSingleFileMultipart(buf, 'multipart/mixed; boundary=----test-boundary'),
    ).rejects.toThrow(/multipart\/form-data/i);
  });

  it('defaults mimeType to application/octet-stream when the part omits it', async () => {
    const { buf, contentType } = buildMultipart([
      { name: 'file', filename: 'blob.bin', body: Buffer.from([0x00, 0x01, 0x02]) },
    ]);
    const result = await parseSingleFileMultipart(buf, contentType);
    expect(result.mimeType).toBe('application/octet-stream');
    expect(result.bytes.length).toBe(3);
  });
});
