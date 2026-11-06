import { describe, it, expect } from 'vitest';
import {
  ArtifactsDeleteOutputSchema,
  ArtifactsGetOutputSchema,
  ArtifactsListOutputSchema,
  ArtifactsPublishOutputSchema,
  ArtifactsReadOutputSchema,
  ArtifactsSummaryOutputSchema,
  type ArtifactSummary,
  type ArtifactsGetOutput,
  type ArtifactsPublishOutput,
  type ArtifactsReadOutput,
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
      attachmentId: '3f1c2b9e-7d4a-4c1e-9b8f-2a6d5e4c3b1a',
      filename: 'screenshot.png',
      sha256: 'a'.repeat(64),
      mediaType: 'image/png',
      sizeBytes: 4096,
    };
    expect(CommitOutputSchema.parse(full)).toEqual(full);
  });

  it('attachments:commit rejects an attachmentId that is not an attachment id', () => {
    // The id lands in the transcript block verbatim; a path-shaped one would
    // make a block no reader accepts.
    expect(
      CommitOutputSchema.safeParse({
        attachmentId: '.ax/uploads/c/t/x.png',
        filename: 'x.png',
        sha256: 'a'.repeat(64),
        mediaType: 'image/png',
        sizeBytes: 1,
      }).success,
    ).toBe(false);
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
        attachmentId: 'a-1',
        filename: 'x',
        mediaType: 'image/png',
        sizeBytes: 1,
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
          attachmentId: '3f1c2b9e-7d4a-4c1e-9b8f-2a6d5e4c3b1a',
          filename: 'a.png',
          sha256: 'a'.repeat(64),
          mediaType: 'image/png',
          sizeBytes: 99,
        },
      ],
    };
    expect(AttachmentsListForConversationOutputSchema.parse(full)).toEqual(full);
  });

  it('attachments:list-for-conversation rejects an entry keyed by path, not id', () => {
    expect(
      AttachmentsListForConversationOutputSchema.safeParse({
        files: [
          {
            path: '.ax/uploads/c1/t1/a.png',
            sha256: 'a'.repeat(64),
            mediaType: 'image/png',
            displayName: 'a.png',
            sizeBytes: 99,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('attachments:list-for-conversation accepts an empty file list', () => {
    expect(AttachmentsListForConversationOutputSchema.parse({ files: [] })).toEqual({ files: [] });
  });
});

describe('artifact owner hook return schemas', () => {
  const summary: ArtifactSummary = {
    artifactId: '0123456789abcdef0123456789abcdef',
    agentId: 'agt-1',
    title: 'Q3 pipeline report',
    mediaType: 'application/pdf',
    kind: 'document',
    preview: 'pdf',
    extension: 'PDF',
    currentVersion: 2,
    sizeBytes: 2048,
    linkOn: true,
    createdAt: '2026-11-04T10:00:00.000Z',
    updatedAt: '2026-11-05T10:00:00.000Z',
  };

  it('artifacts:publish round-trips a fully-populated output', () => {
    const full: ArtifactsPublishOutput = {
      artifactId: summary.artifactId,
      version: 1,
      title: 'Q3',
      kind: 'web',
      extension: 'HTML',
    };
    expect(ArtifactsPublishOutputSchema.parse(full)).toEqual(full);
  });

  it('artifacts:list, rename and restore round-trip a summary', () => {
    expect(ArtifactsListOutputSchema.parse({ artifacts: [summary] })).toEqual({ artifacts: [summary] });
    expect(ArtifactsSummaryOutputSchema.parse({ artifact: summary })).toEqual({ artifact: summary });
  });

  it('artifacts:get round-trips a detail with its versions', () => {
    const full: ArtifactsGetOutput = {
      artifact: {
        ...summary,
        versions: [
          { version: 2, mediaType: 'application/pdf', sizeBytes: 2048, createdAt: summary.updatedAt },
          { version: 1, mediaType: 'application/pdf', sizeBytes: 1024, createdAt: summary.createdAt },
        ],
      },
    };
    expect(ArtifactsGetOutputSchema.parse(full)).toEqual(full);
  });

  it('artifacts:read keeps the bytes by reference', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const full: ArtifactsReadOutput = {
      bytes,
      mediaType: 'text/html',
      preview: 'html',
      sizeBytes: 3,
      filename: 'Page.html',
      version: 1,
    };
    const parsed = ArtifactsReadOutputSchema.parse(full);
    expect(parsed.bytes).toBe(bytes);
    expect(parsed).toEqual(full);
  });

  it('artifacts:delete answers only deleted: true', () => {
    expect(ArtifactsDeleteOutputSchema.parse({ deleted: true })).toEqual({ deleted: true });
    expect(ArtifactsDeleteOutputSchema.safeParse({ deleted: false }).success).toBe(false);
  });

  it('strips a share code or a source path a handler leaked, rather than shipping it', () => {
    const leaky = { ...summary, shareCode: 'Z'.repeat(32), sourcePath: 'reports/q3.pdf' };
    expect(ArtifactsSummaryOutputSchema.parse({ artifact: leaky })).toEqual({ artifact: summary });
  });

  it('refuses a kind outside the one list', () => {
    expect(ArtifactsListOutputSchema.safeParse({ artifacts: [{ ...summary, kind: 'video' }] }).success).toBe(false);
  });
});
