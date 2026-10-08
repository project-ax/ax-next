/**
 * Phase F credentials-admin canaries — wire-layer + ACL coverage on the
 * live kind cluster.
 *
 * Gated on `AX_K8S_E2E=1` and the local kind cluster `ax-next-dev`
 * already running (same posture as runner-owned-sessions-k8s-gap.test.ts
 * — see vitest.config.k8s-e2e.ts for the project wiring).
 *
 * COVERED by this file (Phase 6 of credentials-admin-ui plan):
 *   1. Round-trip canary — POST → GET → DELETE for a global api-key.
 *      Proves the plugin loads, admin gate accepts dev-bootstrap, and
 *      the encrypted blob never echoes in list responses.
 *   2. Scope coexistence — global + agent-scoped same `ref` are both
 *      listed and distinguishable by (scope, ownerId).
 *
 * (A third canary — /settings/credentials pinning scope=user — was deleted
 * in SIGNINS-7: that per-person route is gone, and connector credentials
 * are never stored per person.)
 *
 * (A previous OAuth /start canary lived here. Removed when I12 — provider
 * credentials are API-key-only — landed. The OAuth code paths
 * themselves were removed in the credentials UX redesign + this
 * cleanup; the /admin/credentials/oauth/* routes no longer exist.)
 *
 * NOT COVERED here (deferred to follow-ups):
 *   - Chat-turn-resolution proof: that a credential seeded via the admin
 *     path actually flows through credential-proxy at proxy:open-session
 *     time and lands in the Anthropic API call. The live host uses real
 *     Anthropic, so the only way to prove this is either (a) test-only
 *     code in the production preset (violates Phase 6 constraint) or
 *     (b) brittle log-scraping for plaintext from credential-proxy. The
 *     unit-level scope-precedence.test.ts covers the resolution chain
 *     (user > agent > global) on the same plugin set; this canary's job
 *     is the wire layer + ACL, not the chat turn.
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

describeIfE2E('Phase F: credentials-admin canaries', () => {
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

  // -------------------------------------------------------------------------
  // (b) Scope coexistence — a global and an agent-scoped credential at the
  // same `ref` must coexist on the storage tier and be distinguishable in
  // /admin/credentials by (scope, ownerId).
  //
  // Why this matters: the unit-level scope-precedence.test.ts proves that
  // `credentials:get` resolves user > agent > global at the bus level. This
  // canary proves the LIST surface — the read-back path admins use — does
  // not collapse the two rows into one (a regression that would silently
  // hide an agent override behind a global of the same ref). It also proves
  // the v2 storage key shape (which keys on (scope, ownerId, ref)) round-
  // trips through the live postgres backend, not just the in-memory sqlite
  // the unit tests use.
  // -------------------------------------------------------------------------
  it('global + agent-scoped credentials at the same ref coexist and are distinguishable', async () => {
    const { cookie } = await signIn();
    const ref = `phase-f-coexist-${Date.now()}`;
    const globalPayload = 'sk-global-do-not-leak';
    const agentPayload = 'sk-agent-do-not-leak';
    const agentOwner = `agent-canary-${Date.now()}`;
    const seeded = {
      global: false,
      agent: false,
    };

    try {
      // Seed global first, then agent — order shouldn't matter, but a
      // conflicting (scope, ownerId, ref) bug would surface as a 409 on the
      // second POST.
      await seedAdminCredential(cookie, {
        scope: 'global',
        ownerId: null,
        ref,
        kind: 'api-key',
        payload: globalPayload,
      });
      seeded.global = true;
      await seedAdminCredential(cookie, {
        scope: 'agent',
        ownerId: agentOwner,
        ref,
        kind: 'api-key',
        payload: agentPayload,
      });
      seeded.agent = true;

      const list = await listAdminCredentials(cookie);
      const matches = list.filter((c) => c.ref === ref);
      // Exactly two entries — same ref, distinct scope tuples. A
      // collapsed-list bug would give us 1; an unrelated stale row from a
      // failed prior run would give us 3+ (we randomize the ref above to
      // avoid that, but assert the upper bound too).
      expect(matches).toHaveLength(2);
      const globalEntry = matches.find((c) => c.scope === 'global');
      const agentEntry = matches.find((c) => c.scope === 'agent');
      expect(globalEntry).toMatchObject({
        scope: 'global',
        ownerId: null,
        ref,
        kind: 'api-key',
      });
      expect(agentEntry).toMatchObject({
        scope: 'agent',
        ownerId: agentOwner,
        ref,
        kind: 'api-key',
      });
      // Neither plaintext is in the response body — the metadata-only
      // contract (Phase 1) holds for both rows.
      expect(JSON.stringify(list)).not.toContain(globalPayload);
      expect(JSON.stringify(list)).not.toContain(agentPayload);

      // Delete both as part of the test (not just cleanup) so a "DELETE
      // hits the wrong row" regression at the live storage layer surfaces
      // here, not in a finally-block silent failure.
      await deleteAdminCredential(cookie, {
        scope: 'global',
        ownerId: null,
        ref,
      });
      seeded.global = false;
      await deleteAdminCredential(cookie, {
        scope: 'agent',
        ownerId: agentOwner,
        ref,
      });
      seeded.agent = false;

      const after = await listAdminCredentials(cookie);
      expect(after.find((c) => c.ref === ref)).toBeUndefined();
    } finally {
      // Best-effort cleanup of whatever's still seeded. Same try/catch
      // shape as the round-trip canary above.
      if (seeded.global) {
        try {
          await deleteAdminCredential(cookie, {
            scope: 'global',
            ownerId: null,
            ref,
          });
        } catch {
          // best-effort
        }
      }
      if (seeded.agent) {
        try {
          await deleteAdminCredential(cookie, {
            scope: 'agent',
            ownerId: agentOwner,
            ref,
          });
        } catch {
          // best-effort
        }
      }
    }
  });
});
