import { describe, expect, it } from 'vitest';
import { McpOAuthTokenBlobSchema, encodeTokenBlob, decodeTokenBlob } from '../types.js';

const legacyBlob = {
  accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer',
  expiresAt: 1000, scope: 'read', resource: 'https://mcp.example.com',
  authServerUrl: 'https://auth.example.com', tokenEndpoint: 'https://auth.example.com/token',
  clientKey: 'example|https://auth.example.com',
};

describe('McpOAuthTokenBlob', () => {
  it('round-trips through encode/decode', () => {
    expect(decodeTokenBlob(encodeTokenBlob(legacyBlob))).toEqual(legacyBlob);
  });

  it('a legacy blob (no client fields) decodes WITHOUT clientId/clientSecret keys', () => {
    const decoded = decodeTokenBlob(encodeTokenBlob(legacyBlob));
    expect('clientId' in decoded).toBe(false);
    expect('clientSecret' in decoded).toBe(false);
  });

  it('round-trips the client that issued the token (clientId + clientSecret)', () => {
    const blob = { ...legacyBlob, clientId: 'cid-issued', clientSecret: 'shh-issued' };
    const decoded = decodeTokenBlob(encodeTokenBlob(blob));
    expect(decoded).toEqual(blob);
    expect(decoded.clientId).toBe('cid-issued');
    expect(decoded.clientSecret).toBe('shh-issued');
  });

  it('round-trips a public client (clientId only, no clientSecret)', () => {
    const blob = { ...legacyBlob, clientId: 'cid-public' };
    const decoded = decodeTokenBlob(encodeTokenBlob(blob));
    expect(decoded.clientId).toBe('cid-public');
    expect('clientSecret' in decoded).toBe(false);
  });

  // Negative space: zod object schemas STRIP unknown keys, so a schema that
  // forgot the new fields would still "round-trip" (the fields would just vanish).
  // Assert on the ENCODED BYTES, not only on the decoded shape.
  it('the encoded bytes really carry clientId/clientSecret (the schema does not strip them)', () => {
    const bytes = encodeTokenBlob({ ...legacyBlob, clientId: 'cid-issued', clientSecret: 'shh-issued' });
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    expect(raw.clientId).toBe('cid-issued');
    expect(raw.clientSecret).toBe('shh-issued');
    expect(Object.keys(McpOAuthTokenBlobSchema.shape)).toEqual(
      expect.arrayContaining(['clientId', 'clientSecret']),
    );
  });

  it('rejects an empty clientId', () => {
    expect(() => encodeTokenBlob({ ...legacyBlob, clientId: '' })).toThrow();
  });

  it('rejects a blob missing the access token', () => {
    expect(() => McpOAuthTokenBlobSchema.parse({ tokenType: 'Bearer' })).toThrow();
  });
});
