import { describe, it, expect } from 'vitest';
import {
  ArtifactsPublishBlobOutputSchema,
  AttachmentsListForConversationOutputSchema,
  CommitOutputSchema,
  DownloadOutputSchema,
  StoreTempOutputSchema,
  type ArtifactsPublishBlobOutput,
  type AttachmentsListForConversationOutput,
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

  // TASK-68 hooks.
  it('artifacts:publish-blob round-trips a fully-populated output', () => {
    const full: ArtifactsPublishBlobOutput = { artifactId: 'abc123' };
    expect(ArtifactsPublishBlobOutputSchema.parse(full)).toEqual(full);
  });

  it('attachments:list-for-conversation round-trips a fully-populated output', () => {
    const full: AttachmentsListForConversationOutput = {
      files: [
        {
          path: '.ax/uploads/c1/t1/a.png',
          sha256: 'a'.repeat(64),
          mediaType: 'image/png',
          displayName: 'a.png',
          sizeBytes: 99,
        },
      ],
    };
    expect(AttachmentsListForConversationOutputSchema.parse(full)).toEqual(full);
  });

  it('attachments:list-for-conversation accepts an empty file list', () => {
    expect(AttachmentsListForConversationOutputSchema.parse({ files: [] })).toEqual({ files: [] });
  });
});
