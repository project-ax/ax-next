import { describe, expect, it } from 'vitest';
import { McpOAuthTokenBlobSchema, encodeTokenBlob, decodeTokenBlob } from '../types.js';

describe('McpOAuthTokenBlob', () => {
  it('round-trips through encode/decode', () => {
    const blob = {
      accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer',
      expiresAt: 1000, scope: 'read', resource: 'https://mcp.example.com',
      authServerUrl: 'https://auth.example.com', tokenEndpoint: 'https://auth.example.com/token',
      clientKey: 'example|https://auth.example.com',
    };
    expect(decodeTokenBlob(encodeTokenBlob(blob))).toEqual(blob);
  });

  it('rejects a blob missing the access token', () => {
    expect(() => McpOAuthTokenBlobSchema.parse({ tokenType: 'Bearer' })).toThrow();
  });
});
