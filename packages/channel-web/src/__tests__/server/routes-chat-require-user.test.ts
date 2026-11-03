// @vitest-environment node
/**
 * TASK-1030 — how the chat routes answer a failed `auth:require-user`.
 *
 * Only `unauthenticated` is a 401. `HookBus.call` wraps whatever a service
 * throws that is not a PluginError as `PluginError{code:'unknown', cause}`, so
 * a crashed session store used to read as "signed out" (the user was bounced
 * to sign-in, nothing was logged). It is now a logged generic 500.
 *
 * Docker-free: a bare HookBus with a RAW-throwing `auth:require-user` (the bus
 * does the wrapping), the handler factory called with fake req/res objects.
 * The four auth gates in routes-chat.ts: postMessage, postPermissionDecision,
 * postApproveAuthoredSkill and (via the shared `authOr401`) listAgents.
 */
import { describe, expect, it } from 'vitest';
import { HookBus, PluginError } from '@ax/core';
import {
  createChatRouteHandlers,
  type RouteRequest,
  type RouteResponse,
} from '../../server/routes-chat';
import { expectLoggedRequireUserFault, faultInitCtx, storeFault } from './require-user-fault';

function fakeReq(): RouteRequest {
  return {
    headers: {},
    body: Buffer.from('{}', 'utf8'),
    cookies: {},
    query: {},
    params: {},
    signedCookie: () => null,
  };
}

function fakeRes(): { res: RouteResponse; captured: { status?: number; json?: unknown } } {
  const captured: { status?: number; json?: unknown } = {};
  const res: RouteResponse = {
    status(n: number) {
      captured.status = n;
      return res;
    },
    json(v: unknown) {
      captured.json = v;
    },
    text() {},
    end() {},
  };
  return { res, captured };
}

type Gate = 'postMessage' | 'postPermissionDecision' | 'postApproveAuthoredSkill' | 'listAgents';

const GATES: ReadonlyArray<readonly [Gate, string]> = [
  ['postMessage', 'chat_post_message_require_user_failed'],
  ['postPermissionDecision', 'chat_permission_decision_require_user_failed'],
  ['postApproveAuthoredSkill', 'chat_approve_authored_skill_require_user_failed'],
  ['listAgents', 'chat_require_user_failed'],
];

describe('chat routes: auth:require-user failures', () => {
  it.each(GATES)('%s: unauthenticated → 401', async (gate) => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => {
      throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no session' });
    });
    const { ctx, logger } = faultInitCtx();
    const { res, captured } = fakeRes();
    await createChatRouteHandlers({ bus, initCtx: ctx })[gate](fakeReq(), res);
    expect(captured.status).toBe(401);
    expect(captured.json).toEqual({ error: 'unauthenticated' });
    expect(logger.errors).toEqual([]);
  });

  it.each(GATES)('%s: a session-store fault is a logged 500, not a 401', async (gate, event) => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => {
      throw storeFault();
    });
    const { ctx, logger } = faultInitCtx();
    const { res, captured } = fakeRes();
    await createChatRouteHandlers({ bus, initCtx: ctx })[gate](fakeReq(), res);
    expectLoggedRequireUserFault(logger, event, {
      status: captured.status ?? 0,
      body: captured.json,
    });
  });
});
