/**
 * Phase F canary — admin can round-trip a credential through
 * /admin/credentials.
 *
 * Gated on `AX_K8S_E2E=1` and the local kind cluster `ax-next-dev`
 * already running (same posture as runner-owned-sessions-k8s-gap.test.ts
 * — see vitest.config.k8s-e2e.ts for the project wiring).
 *
 * What this proves:
 *   - The host pod loaded @ax/credentials-admin-routes
 *     (i.e., AX_CREDENTIALS_ADMIN_ENABLED=true reached the preset, which
 *     pushed the plugin, which mounted the routes).
 *   - The route's admin gate accepts a dev-bootstrap admin session.
 *   - POST → GET → DELETE round-trip works end-to-end against the real
 *     credentials facade and storage backend (postgres, not the in-
 *     memory sqlite the unit tests use).
 *   - Listing returns metadata only — the seeded plaintext never appears
 *     in the response body.
 *
 * What this does NOT prove:
 *   - That a session created via this admin path actually flows through
 *     to the credential-proxy at proxy:open-session time. That's the
 *     "admin can seed → chat works" loop and lands in Phase 6 once the
 *     UI Phase 4 is in place.
 */
import { describe, it, expect } from 'vitest';
import {
  signIn,
  seedAdminCredential,
  listAdminCredentials,
  deleteAdminCredential,
} from './helpers.js';

const SHOULD_RUN = process.env.AX_K8S_E2E === '1';
const describeIfE2E = SHOULD_RUN ? describe : describe.skip;

describeIfE2E('Phase F: admin /admin/credentials round-trip', () => {
  it('admin POST → GET → DELETE a global api-key', async () => {
    const { cookie } = await signIn();
    const ref = `phase-f-canary-${Date.now()}`;
    const payload = 'sk-canary-do-not-leak';

    try {
      // POST. The route forces admin-only and validates payload shape;
      // a 200/201 here means @ax/credentials-admin-routes is mounted.
      await seedAdminCredential(cookie, {
        scope: 'global',
        ownerId: null,
        ref,
        kind: 'api-key',
        payload,
      });

      // GET — metadata only. The seeded plaintext must NOT be visible.
      const list = await listAdminCredentials(cookie);
      const found = list.find((c) => c.ref === ref);
      expect(found, `seeded credential not in list: ${JSON.stringify(list)}`).toBeDefined();
      expect(found).toMatchObject({
        scope: 'global',
        ownerId: null,
        ref,
        kind: 'api-key',
      });
      // Sanity: the response must never contain the secret bytes.
      expect(JSON.stringify(list)).not.toContain(payload);
    } finally {
      // Always clean up — leaving a global api-key around between test
      // runs would either confuse later canaries or, worse, intercept a
      // real ANTHROPIC_API_KEY proxy lookup if the ref happens to
      // collide with a production seed.
      await deleteAdminCredential(cookie, {
        scope: 'global',
        ownerId: null,
        ref,
      });
    }
  });
});
