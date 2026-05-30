import { describe, it, expect } from 'vitest';
import {
  AppendTranscriptOutputSchema,
  GetMetadataOutputSchema,
  GetTranscriptOutputSchema,
  ReplaceTranscriptOutputSchema,
  StoreRunnerSessionOutputSchema,
  type AppendTranscriptOutput,
  type GetMetadataOutput,
  type GetTranscriptOutput,
  type ReplaceTranscriptOutput,
} from '../types.js';

describe('conversations return schemas', () => {
  describe('GetMetadataOutputSchema', () => {
    const full: GetMetadataOutput = {
      conversationId: 'c1',
      userId: 'u1',
      agentId: 'a1',
      runnerType: 'claude-sdk',
      runnerSessionId: 'rs1',
      workspaceRef: 'v1',
      title: 'My chat',
      lastActivityAt: '2026-05-24T00:00:00.000Z',
      createdAt: '2026-05-23T00:00:00.000Z',
    };

    it('accepts a fully-populated value', () => {
      expect(GetMetadataOutputSchema.safeParse(full).success).toBe(true);
    });

    it('accepts the all-nullable-fields-null shape (pre-Phase-B row)', () => {
      expect(
        GetMetadataOutputSchema.safeParse({
          ...full,
          runnerType: null,
          runnerSessionId: null,
          workspaceRef: null,
          title: null,
          lastActivityAt: null,
        }).success,
      ).toBe(true);
    });

    it('rejects a missing required field', () => {
      const { conversationId: _omit, ...rest } = full;
      expect(GetMetadataOutputSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects a non-string createdAt', () => {
      expect(GetMetadataOutputSchema.safeParse({ ...full, createdAt: 123 }).success).toBe(
        false,
      );
    });

    // Drift guard: a fully-populated interface value round-trips without loss.
    it('round-trips a fully-populated value without stripping fields', () => {
      expect(GetMetadataOutputSchema.parse(full)).toEqual(full);
    });
  });

  describe('StoreRunnerSessionOutputSchema', () => {
    it('accepts undefined (void success)', () => {
      expect(StoreRunnerSessionOutputSchema.safeParse(undefined).success).toBe(true);
    });

    it('rejects a non-empty return (would signal a handler bug)', () => {
      expect(StoreRunnerSessionOutputSchema.safeParse({ ok: true }).success).toBe(false);
    });
  });

  // TASK-67 — resume transcript hooks.
  describe('AppendTranscriptOutputSchema', () => {
    const full: AppendTranscriptOutput = { outcome: 'appended', maxSeq: 7 };
    it('accepts both outcomes and round-trips', () => {
      expect(AppendTranscriptOutputSchema.safeParse(full).success).toBe(true);
      expect(
        AppendTranscriptOutputSchema.safeParse({
          outcome: 'resync-required',
          maxSeq: 0,
        }).success,
      ).toBe(true);
      expect(AppendTranscriptOutputSchema.parse(full)).toEqual(full);
    });
    it('rejects an unknown outcome', () => {
      expect(
        AppendTranscriptOutputSchema.safeParse({ outcome: 'nope', maxSeq: 1 })
          .success,
      ).toBe(false);
    });
    it('rejects a missing field', () => {
      expect(
        AppendTranscriptOutputSchema.safeParse({ outcome: 'appended' }).success,
      ).toBe(false);
    });
  });

  describe('ReplaceTranscriptOutputSchema', () => {
    const full: ReplaceTranscriptOutput = { maxSeq: 3 };
    it('round-trips without stripping fields', () => {
      expect(ReplaceTranscriptOutputSchema.parse(full)).toEqual(full);
    });
    it('rejects a non-number maxSeq', () => {
      expect(
        ReplaceTranscriptOutputSchema.safeParse({ maxSeq: 'x' }).success,
      ).toBe(false);
    });
  });

  describe('GetTranscriptOutputSchema', () => {
    const full: GetTranscriptOutput = { bytes: 'line1\nline2', maxSeq: 2 };
    it('round-trips without stripping fields', () => {
      expect(GetTranscriptOutputSchema.parse(full)).toEqual(full);
    });
    it('rejects a non-string bytes', () => {
      expect(
        GetTranscriptOutputSchema.safeParse({ bytes: 123, maxSeq: 0 }).success,
      ).toBe(false);
    });
  });
});
