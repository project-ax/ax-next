import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One box per `/auth/*` request. plugin.ts's forwardToBetterAuth creates it and
 * runs the better-auth call inside sessionTokenALS.run(box, ...). Nothing in it
 * is read from the request, so a client can't forge any field.
 *
 * - `malformedHost`: set by forwardToBetterAuth when the Host header wasn't a
 *   bare `host[:port]`. handler.ts's refuse plugin answers it with a 400.
 * - `refused`: set by that plugin when it actually served the 400 (a request
 *   over the rate limit gets Better Auth's 429 instead), so forwardToBetterAuth
 *   logs only refusals that happened.
 * - `token`: the session token better-auth mints during a sign-in flow, written
 *   by handler.ts's databaseHooks.session.create.after. forwardToBetterAuth
 *   re-issues it as the http-server-signed ax_auth_session cookie, keeping
 *   auth_better_v1_sessions + ax_auth_session the single source of truth even
 *   though better-auth would set its own cookie.
 */
export interface AuthRequestBox {
  token?: string;
  malformedHost?: boolean;
  refused?: boolean;
}

export const sessionTokenALS = new AsyncLocalStorage<AuthRequestBox>();
