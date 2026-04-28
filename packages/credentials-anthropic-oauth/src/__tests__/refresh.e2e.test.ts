// Real-Anthropic e2e for the refresh path. Gated on the
// AX_TEST_ANTHROPIC_OAUTH_REFRESH_TOKEN env var — if unset, the entire
// suite skips. CI doesn't have the var; local users can run it after a
// successful `ax-next credentials login anthropic`.
//
// What we exercise: a real refresh-token round-trip against
// https://console.anthropic.com/v1/oauth/token. We DO NOT use the SDK
// here — just the resolver function directly. The point is to catch
// drift in Anthropic's response shape (or a typo in our request body)
// before users do.

import { describe, it, expect } from 'vitest';
import { resolveAnthropicOauth } from '../refresh.js';

const refreshToken = process.env.AX_TEST_ANTHROPIC_OAUTH_REFRESH_TOKEN;
const skip = refreshToken === undefined || refreshToken === '';

describe.skipIf(skip)('anthropic-oauth refresh e2e (real Anthropic token endpoint)', () => {
  it('exchanges a real refresh token for a fresh access token', async () => {
    // Force the refresh path: set expiresAt in the past.
    const blob = new TextEncoder().encode(
      JSON.stringify({
        accessToken: 'placeholder-access-token-will-be-replaced',
        refreshToken,
        expiresAt: Date.now() - 1000,
      }),
    );
    const out = await resolveAnthropicOauth({ payload: blob });

    // The new access token comes back as a non-empty string. We don't
    // assert a prefix — Anthropic's tokens have rotated formats over time;
    // the only safe property is "non-empty + different from placeholder".
    expect(typeof out.value).toBe('string');
    expect(out.value.length).toBeGreaterThan(20);
    expect(out.value).not.toBe('placeholder-access-token-will-be-replaced');

    // refreshed blob is present iff a refresh actually happened.
    expect(out.refreshed).toBeDefined();
    if (out.refreshed) {
      expect(out.refreshed.expiresAt).toBeGreaterThan(Date.now());
      // Decode the new blob — should round-trip.
      const decoded = JSON.parse(new TextDecoder().decode(out.refreshed.payload)) as {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
      };
      expect(decoded.accessToken).toBe(out.value);
      expect(decoded.refreshToken).toBeTruthy();
    }
  });
});
