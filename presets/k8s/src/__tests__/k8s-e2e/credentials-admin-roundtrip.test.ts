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
    let deleteAsserted = false;

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
      const listAfterCreate = await listAdminCredentials(cookie);
      const found = listAfterCreate.find((c) => c.ref === ref);
      expect(
        found,
        `seeded credential not in list: ${JSON.stringify(listAfterCreate)}`,
      ).toBeDefined();
      expect(found).toMatchObject({
        scope: 'global',
        ownerId: null,
        ref,
        kind: 'api-key',
      });
      // Sanity: the response must never contain the secret bytes.
      expect(JSON.stringify(listAfterCreate)).not.toContain(payload);

      // DELETE is part of the round-trip assertion, not just cleanup.
      // We need to know the row actually went away — a finally-only
      // delete would silently mask a "delete returns 204 but doesn't
      // remove the row" regression on the live cluster.
      await deleteAdminCredential(cookie, {
        scope: 'global',
        ownerId: null,
        ref,
      });
      const listAfterDelete = await listAdminCredentials(cookie);
      expect(
        listAfterDelete.find((c) => c.ref === ref),
        `credential survived DELETE: ${JSON.stringify(listAfterDelete)}`,
      ).toBeUndefined();
      deleteAsserted = true;
    } finally {
      // Cleanup-on-failure only. If an assertion above threw before the
      // DELETE step landed, make sure we don't leave a stray global
      // api-key around — a collision with a real ANTHROPIC_API_KEY ref
      // could intercept a production proxy lookup. Guarded with
      // try/catch so a failed cleanup doesn't shadow the original
      // assertion failure (the test's actual signal).
      if (!deleteAsserted) {
        try {
          await deleteAdminCredential(cookie, {
            scope: 'global',
            ownerId: null,
            ref,
          });
        } catch {
          // best-effort cleanup; the original failure is what matters
        }
      }
    }
  });
});
