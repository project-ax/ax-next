import type { AgentContext } from './context.js';
import { PluginError } from './errors.js';

/**
 * The service hook every HTTP route gate calls to turn a request into a
 * signed-in user. Named here so the gate helper below and its callers agree
 * on the one spelling.
 */
export const AUTH_REQUIRE_USER_HOOK = 'auth:require-user';

/**
 * Is this thrown value `auth:require-user` saying "nobody is signed in"?
 *
 * Only the hook's own refusal code counts. `HookBus.call` wraps every
 * non-PluginError a service throws as `PluginError{ code: 'unknown', cause }`,
 * and a bus-level `timeout` / `no-service` / `invalid-return` is the host
 * failing too. So a bare `instanceof PluginError` is also what a session-store
 * crash looks like once it has crossed the bus, and reading that as "signed
 * out" bounces the user to sign-in and hides the outage (TASK-1030).
 */
export function isUnauthenticated(err: unknown): boolean {
  return err instanceof PluginError && err.code === 'unauthenticated';
}

/** The slice of a route response the gate writes to. */
export interface StatusJsonResponse {
  status(code: number): { json(body: unknown): void };
}

/**
 * Answer a failed `auth:require-user` call on a route.
 *
 * - The hook's refusal (`unauthenticated`) → 401 `{ error: 'unauthenticated' }`.
 * - Anything else → `ctx.logger.error(event, { hook, err })` and 500
 *   `{ error: 'internal' }`. The body never echoes the error: the bus's wrap
 *   copies the inner message into its own, and that text can name a host,
 *   a table or a provider. The log line carries it (with code and one level
 *   of cause) for the operator.
 *
 * Both answers are closed: neither lets the request through. The difference
 * is only whether the person is told to sign in again (they are signed out)
 * or that something broke (they may well still be signed in).
 *
 * The caller still returns after this — it writes the response and nothing
 * else.
 */
export function answerRequireUserFailure(
  ctx: Pick<AgentContext, 'logger'>,
  res: StatusJsonResponse,
  err: unknown,
  event: string,
): void {
  if (isUnauthenticated(err)) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  ctx.logger.error(event, { hook: AUTH_REQUIRE_USER_HOOK, err });
  res.status(500).json({ error: 'internal' });
}
