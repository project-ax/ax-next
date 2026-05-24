import { describe, it, expect } from 'vitest';
import {
  GetMetadataOutputSchema,
  StoreRunnerSessionOutputSchema,
  type GetMetadataOutput,
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
});
