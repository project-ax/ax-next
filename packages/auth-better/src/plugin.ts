import type { Plugin } from '@ax/core';

/**
 * Config surface for `@ax/auth-better`. Reserved fields land in Task
 * 1.4 (hook surface) and Task 1.5 (provider CRUD); kept as a typed
 * interface today so call-sites can adopt the type without churn.
 */
export interface AuthBetterConfig {
  /**
   * Optional override for the cookie name better-auth uses to track
   * the HTTP login session. Filled in by Task 1.4 — left as a typed
   * placeholder so consumers can wire `createAuthBetterPlugin({...})`
   * forward-compatibly.
   */
  sessionCookieName?: string;
}

const PLUGIN_NAME = '@ax/auth-better';

/**
 * Plugin factory. Skeleton in Task 1.3 — `init()` is intentionally a
 * no-op until Task 1.4 lights up the hook surface (`auth:require-user`,
 * `auth:get-user`, `auth:create-bootstrap-user`) and Task 1.5 wires
 * provider CRUD plus the hot-reload path through `auth:providers-changed`.
 *
 * The manifest declares the registers/calls/subscribes UP FRONT — this
 * is honest about what's coming so reviewers can scan the boundary
 * surface in one place. The kernel may flag the gap as a half-wired
 * plugin until Task 1.4 lands; that's expected. The Phase 1 PR notes
 * track this under "half-wired window: OPEN — closed in Phase 3."
 */
export function createAuthBetterPlugin(_config: AuthBetterConfig = {}): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'auth:require-user',
        'auth:get-user',
        'auth:create-bootstrap-user',
      ],
      calls: [
        'database:get-instance',
        'http:register-route',
        'credentials:envelope-encrypt',
        'credentials:envelope-decrypt',
      ],
      subscribes: ['auth:providers-changed'],
    },
    async init(_ctx) {
      // Intentionally empty. Task 1.4 fills in the hook surface; Task
      // 1.5 attaches the provider-CRUD subscriber and the rebuild seam.
    },
  };
}
