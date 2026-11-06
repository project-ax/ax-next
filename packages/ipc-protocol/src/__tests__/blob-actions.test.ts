import { describe, it, expect } from 'vitest';
import {
  BlobPutResponseSchema,
  BlobGetRequestSchema,
  ArtifactPublishRequestSchema,
  ArtifactPublishResponseSchema,
  AttachmentsListRequestSchema,
  AttachmentsListResponseSchema,
  IPC_TIMEOUTS_MS,
} from '../index.js';

const VALID_SHA = 'a'.repeat(64);
const SHORT_SHA = 'a'.repeat(63);
const UPPER_SHA = 'A'.repeat(64);

describe('TASK-68 blob.* / metadata IPC schemas', () => {
  describe('BlobPutResponseSchema', () => {
    it('accepts a valid {sha256,size} envelope', () => {
      const r = BlobPutResponseSchema.safeParse({ sha256: VALID_SHA, size: 12 });
      expect(r.success).toBe(true);
    });
    it('rejects a non-hex / wrong-length sha256', () => {
      expect(BlobPutResponseSchema.safeParse({ sha256: SHORT_SHA, size: 1 }).success).toBe(false);
      expect(BlobPutResponseSchema.safeParse({ sha256: UPPER_SHA, size: 1 }).success).toBe(false);
    });
    it('rejects a negative size', () => {
      expect(BlobPutResponseSchema.safeParse({ sha256: VALID_SHA, size: -1 }).success).toBe(false);
    });
  });

  describe('BlobGetRequestSchema', () => {
    it('accepts a valid sha256 request', () => {
      expect(BlobGetRequestSchema.safeParse({ sha256: VALID_SHA }).success).toBe(true);
    });
    it('rejects a malformed sha256 (path-traversal defense at the wire)', () => {
      expect(BlobGetRequestSchema.safeParse({ sha256: '../../etc/passwd' }).success).toBe(false);
      expect(BlobGetRequestSchema.safeParse({ sha256: SHORT_SHA }).success).toBe(false);
    });
    it('is strict — rejects extra fields', () => {
      expect(
        BlobGetRequestSchema.safeParse({ sha256: VALID_SHA, bucket: 'x' }).success,
      ).toBe(false);
    });
  });

  describe('ArtifactPublishRequestSchema', () => {
    const valid = {
      conversationId: 'conv-1',
      sha256: VALID_SHA,
      path: 'reports/report.pdf',
      title: 'Report',
    };
    it('accepts {conversationId, sha256, path, title}', () => {
      expect(ArtifactPublishRequestSchema.safeParse(valid).success).toBe(true);
    });
    it('rejects a missing required field', () => {
      const { path: _omit, ...rest } = valid;
      expect(ArtifactPublishRequestSchema.safeParse(rest).success).toBe(false);
    });
    it('rejects a malformed sha256', () => {
      expect(
        ArtifactPublishRequestSchema.safeParse({ ...valid, sha256: SHORT_SHA }).success,
      ).toBe(false);
    });
    it('is strict — rejects backend-vocabulary leakage', () => {
      expect(
        ArtifactPublishRequestSchema.safeParse({ ...valid, oid: 'deadbeef' }).success,
      ).toBe(false);
    });
    // Media type and size are the host's to decide; the runner cannot send them.
    it('refuses mediaType and size', () => {
      expect(
        ArtifactPublishRequestSchema.safeParse({ ...valid, mediaType: 'text/html' }).success,
      ).toBe(false);
      expect(ArtifactPublishRequestSchema.safeParse({ ...valid, size: 1 }).success).toBe(false);
    });
  });

  describe('ArtifactPublishResponseSchema', () => {
    it('accepts {artifactId, version, title, kind, extension}', () => {
      expect(
        ArtifactPublishResponseSchema.safeParse({
          artifactId: 'abc123',
          version: 1,
          title: 'Report',
          kind: 'document',
          extension: 'PDF',
        }).success,
      ).toBe(true);
    });
    it('refuses an artifact id that is not an attachment id', () => {
      expect(
        ArtifactPublishResponseSchema.safeParse({
          artifactId: '../x',
          version: 1,
          title: 'Report',
          kind: 'document',
          extension: 'PDF',
        }).success,
      ).toBe(false);
    });
  });

  describe('AttachmentsListRequestSchema / ResponseSchema', () => {
    it('accepts a conversationId request', () => {
      expect(AttachmentsListRequestSchema.safeParse({ conversationId: 'c1' }).success).toBe(true);
    });
    it('rejects an empty conversationId', () => {
      expect(AttachmentsListRequestSchema.safeParse({ conversationId: '' }).success).toBe(false);
    });
    const entry = {
      attachmentId: '3f1c2b9e-7d4a-4c1e-9b8f-2a6d5e4c3b1a',
      filename: 'a.png',
      sha256: VALID_SHA,
      mediaType: 'image/png',
      sizeBytes: 99,
    };
    it('accepts a files list of id + filename + sha256 + display metadata', () => {
      const r = AttachmentsListResponseSchema.safeParse({ files: [entry] });
      expect(r.success).toBe(true);
      expect(r.success && r.data.files).toEqual([entry]);
    });
    it('accepts an empty files list', () => {
      expect(AttachmentsListResponseSchema.safeParse({ files: [] }).success).toBe(true);
    });
    it('rejects a file entry with a malformed sha256', () => {
      expect(
        AttachmentsListResponseSchema.safeParse({ files: [{ ...entry, sha256: SHORT_SHA }] }).success,
      ).toBe(false);
    });
    it.each(['../x', 'a/b', '', 'a'.repeat(129)])(
      'rejects a file entry whose attachmentId is %j',
      (attachmentId) => {
        expect(
          AttachmentsListResponseSchema.safeParse({ files: [{ ...entry, attachmentId }] }).success,
        ).toBe(false);
      },
    );
    it('rejects the old path-keyed entry', () => {
      expect(
        AttachmentsListResponseSchema.safeParse({
          files: [
            {
              path: '.ax/uploads/c1/t1/a.png',
              sha256: VALID_SHA,
              mediaType: 'image/png',
              displayName: 'a.png',
              sizeBytes: 99,
            },
          ],
        }).success,
      ).toBe(false);
    });
    it('rejects an empty filename', () => {
      expect(
        AttachmentsListResponseSchema.safeParse({ files: [{ ...entry, filename: '' }] }).success,
      ).toBe(false);
    });
  });

  describe('IPC_TIMEOUTS_MS registers the new actions', () => {
    it('has ceilings for blob.put / blob.get / artifact.publish / attachments.list', () => {
      expect(IPC_TIMEOUTS_MS['blob.put']).toBe(120_000);
      expect(IPC_TIMEOUTS_MS['blob.get']).toBe(120_000);
      expect(IPC_TIMEOUTS_MS['artifact.publish']).toBe(10_000);
      expect(IPC_TIMEOUTS_MS['attachments.list']).toBe(10_000);
    });
  });
});
