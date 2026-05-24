import { describe, it, expect } from 'vitest';
import {
  CommitOutputSchema,
  DownloadOutputSchema,
  StoreTempOutputSchema,
  type CommitOutput,
  type DownloadOutput,
  type StoreTempOutput,
} from '../types.js';

// ARCH-13 drift guard for the `attachments:*` returns schemas. DownloadOutput
// carries a Node Buffer (a Uint8Array subclass) which must survive by
// reference.

describe('attachments return schemas', () => {
  it('attachments:store-temp round-trips a fully-populated StoreTempOutput', () => {
    const full: StoreTempOutput = {
      attachmentId: 'att-123',
      sizeBytes: 4096,
      expiresAt: '2026-01-01T00:10:00.000Z',
    };
    expect(StoreTempOutputSchema.parse(full)).toEqual(full);
  });

  it('attachments:commit round-trips a fully-populated CommitOutput', () => {
    const full: CommitOutput = {
      path: '.ax/attachments/abc.png',
      sha256: 'deadbeef',
      mediaType: 'image/png',
      sizeBytes: 4096,
      displayName: 'screenshot.png',
    };
    expect(CommitOutputSchema.parse(full)).toEqual(full);
  });

  it('attachments:download preserves the Buffer bytes by reference', () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const full: DownloadOutput = {
      bytes,
      mediaType: 'application/pdf',
      sizeBytes: bytes.length,
      displayName: 'doc.pdf',
    };
    const parsed = DownloadOutputSchema.parse(full);
    expect(parsed.bytes).toBe(bytes);
    expect(parsed).toEqual(full);
  });

  it('attachments:store-temp rejects a non-string expiresAt', () => {
    expect(
      StoreTempOutputSchema.safeParse({ attachmentId: 'a', sizeBytes: 1, expiresAt: 123 }).success,
    ).toBe(false);
  });

  it('attachments:download rejects non-Uint8Array bytes', () => {
    expect(
      DownloadOutputSchema.safeParse({
        bytes: 'not-bytes',
        mediaType: 'text/plain',
        sizeBytes: 9,
        displayName: 'x.txt',
      }).success,
    ).toBe(false);
  });

  it('attachments:commit rejects a missing sha256', () => {
    expect(
      CommitOutputSchema.safeParse({
        path: 'p',
        mediaType: 'image/png',
        sizeBytes: 1,
        displayName: 'x',
      }).success,
    ).toBe(false);
  });
});
