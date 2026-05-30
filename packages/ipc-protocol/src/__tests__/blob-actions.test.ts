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
      path: 'workspace/report.pdf',
      displayName: 'report.pdf',
      mediaType: 'application/pdf',
      size: 1024,
    };
    it('accepts a full metadata envelope', () => {
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
  });

  describe('ArtifactPublishResponseSchema', () => {
    it('accepts {artifactId, downloadUrl}', () => {
      expect(
        ArtifactPublishResponseSchema.safeParse({
          artifactId: 'abc123',
          downloadUrl: 'ax://artifact/abc123',
        }).success,
      ).toBe(true);
    });
  });

  describe('AttachmentsListRequestSchema / ResponseSchema', () => {
    it('accepts a conversationId request', () => {
      expect(AttachmentsListRequestSchema.safeParse({ conversationId: 'c1' }).success).toBe(true);
    });
    it('rejects an empty conversationId', () => {
      expect(AttachmentsListRequestSchema.safeParse({ conversationId: '' }).success).toBe(false);
    });
    it('accepts a files list with sha256 + display metadata', () => {
      const r = AttachmentsListResponseSchema.safeParse({
        files: [
          {
            path: '.ax/uploads/c1/t1/a.png',
            sha256: VALID_SHA,
            mediaType: 'image/png',
            displayName: 'a.png',
            sizeBytes: 99,
          },
        ],
      });
      expect(r.success).toBe(true);
    });
    it('accepts an empty files list', () => {
      expect(AttachmentsListResponseSchema.safeParse({ files: [] }).success).toBe(true);
    });
    it('rejects a file entry with a malformed sha256', () => {
      const r = AttachmentsListResponseSchema.safeParse({
        files: [
          { path: 'x', sha256: SHORT_SHA, mediaType: 'image/png', displayName: 'a', sizeBytes: 1 },
        ],
      });
      expect(r.success).toBe(false);
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
