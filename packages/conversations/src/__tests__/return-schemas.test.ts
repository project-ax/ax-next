import { describe, it, expect } from 'vitest';
import {
  AppendTranscriptOutputSchema,
  CONVERSATION_ORIGINS,
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
      title: 'My chat',
      lastActivityAt: '2026-05-24T00:00:00.000Z',
      createdAt: '2026-05-23T00:00:00.000Z',
      // AW-6. The drift guard below is what stops these two from being
      // dropped from the schema: a `z.object` strips undeclared keys silently,
      // and an attendance read that always saw `undefined` would fall to its
      // unattended fail-safe for every conversation with nothing failing.
      origin: 'web',
      activeSessionId: 'sess-1',
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
          title: null,
          lastActivityAt: null,
          activeSessionId: null,
        }).success,
      ).toBe(true);
    });

    // TASK-995: workspaceRef left the projection. A stray one (a stale
    // build's row, a mock) is stripped at the bus boundary, so no caller of
    // conversations:get-metadata can come to rely on it again.
    it('strips a workspaceRef from the projection', () => {
      const parsed = GetMetadataOutputSchema.parse({ ...full, workspaceRef: 'v1' });
      expect(parsed).not.toHaveProperty('workspaceRef');
      expect(parsed.conversationId).toBe('c1');
    });

    // TASK-1093. The schema and the store's list are one list: a channel the
    // store can return must not be refused (invalid-return) on the way out.
    it('accepts every origin the store can return, and nothing else', () => {
      expect([...CONVERSATION_ORIGINS]).toEqual(['web', 'routine', 'slack']);
      for (const origin of ['web', 'routine', 'slack']) {
        expect(GetMetadataOutputSchema.safeParse({ ...full, origin }).success, origin).toBe(true);
      }
      for (const origin of ['Slack', 'carrier-pigeon', '', null]) {
        expect(GetMetadataOutputSchema.safeParse({ ...full, origin }).success, String(origin)).toBe(
          false,
        );
      }
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
