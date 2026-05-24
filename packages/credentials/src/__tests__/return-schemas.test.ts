import { describe, it, expect } from 'vitest';
import {
  CredentialsGetOutputSchema,
  CredentialsResolveOutputSchema,
  CredentialsListOutputSchema,
  CredentialsListKindsOutputSchema,
  type CredentialsResolveOutput,
  type CredentialsListOutput,
  type CredentialsListKindsOutput,
} from '../plugin.js';

describe('credentials return schemas', () => {
  it('CredentialsGetOutputSchema accepts a string and rejects a non-string', () => {
    expect(CredentialsGetOutputSchema.safeParse('secret').success).toBe(true);
    expect(CredentialsGetOutputSchema.safeParse(undefined).success).toBe(false);
    expect(CredentialsGetOutputSchema.safeParse({}).success).toBe(false);
  });

  it('CredentialsResolveOutputSchema requires a string value, allows optional refreshed', () => {
    expect(CredentialsResolveOutputSchema.safeParse({ value: 'v' }).success).toBe(true);
    expect(
      CredentialsResolveOutputSchema.safeParse({ value: 'v', refreshed: { payload: new Uint8Array([1]) } }).success,
    ).toBe(true);
    expect(CredentialsResolveOutputSchema.safeParse({}).success).toBe(false);
    expect(CredentialsResolveOutputSchema.safeParse({ value: 5 }).success).toBe(false);
  });

  // Drift guard: the schema hand-mirrors the CredentialsResolveOutput interface.
  // `full` is typed as the interface, so a new *required* interface field fails
  // this test at compile time; a new optional field fails at runtime because the
  // schema would strip it and the round-trip `toEqual` would diverge. Either way,
  // adding a field to the interface without updating the schema breaks the build.
  it('round-trips a fully-populated interface value without stripping fields', () => {
    const full: CredentialsResolveOutput = {
      value: 'secret',
      refreshed: {
        payload: new Uint8Array([1, 2, 3]),
        expiresAt: 123,
        metadata: { rotated: true },
      },
    };
    const parsed = CredentialsResolveOutputSchema.parse(full);
    expect(parsed).toEqual(full);
  });

  it('CredentialsListOutputSchema accepts metadata-only entries, rejects junk', () => {
    expect(
      CredentialsListOutputSchema.safeParse({
        credentials: [
          {
            scope: 'user',
            ownerId: 'u1',
            ref: 'provider:anthropic',
            kind: 'api-key',
            createdAt: '2026-05-24T00:00:00.000Z',
          },
        ],
      }).success,
    ).toBe(true);
    expect(CredentialsListOutputSchema.safeParse({ credentials: 'nope' }).success).toBe(false);
    // an invalid scope is rejected
    expect(
      CredentialsListOutputSchema.safeParse({
        credentials: [{ scope: 'bogus', ownerId: null, ref: 'r', kind: 'k', createdAt: 't' }],
      }).success,
    ).toBe(false);
  });

  it('CredentialsListOutputSchema round-trips a fully-populated entry without stripping', () => {
    const full: CredentialsListOutput = {
      credentials: [
        {
          scope: 'agent',
          ownerId: null,
          ref: 'skill:s1:slotA',
          kind: 'oauth',
          createdAt: '2026-05-24T00:00:00.000Z',
          expiresAt: '2026-06-24T00:00:00.000Z',
          metadata: { issuer: 'acme' },
        },
      ],
    };
    expect(CredentialsListOutputSchema.parse(full)).toEqual(full);
  });

  it('CredentialsListKindsOutputSchema validates kind/flow and round-trips', () => {
    const full: CredentialsListKindsOutput = {
      kinds: [
        { kind: 'api-key', flow: 'paste' },
        { kind: 'anthropic', flow: 'oauth' },
      ],
    };
    expect(CredentialsListKindsOutputSchema.parse(full)).toEqual(full);
    expect(
      CredentialsListKindsOutputSchema.safeParse({
        kinds: [{ kind: 'x', flow: 'magic' }],
      }).success,
    ).toBe(false);
  });
});
