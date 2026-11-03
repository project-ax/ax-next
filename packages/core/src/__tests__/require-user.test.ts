import { describe, it, expect } from 'vitest';
import { HookBus } from '../hook-bus.js';
import { makeAgentContext, type Logger } from '../context.js';
import { PluginError } from '../errors.js';
import {
  AUTH_REQUIRE_USER_HOOK,
  answerRequireUserFailure,
  isUnauthenticated,
} from '../require-user.js';

const FAULT = 'pg down at 10.0.0.7';

function captureLogger(): { logger: Logger; errors: Array<{ msg: string; b?: Record<string, unknown> }> } {
  const errors: Array<{ msg: string; b?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg, b) => {
      errors.push(b === undefined ? { msg } : { msg, b });
    },
    child: () => logger,
  };
  return { logger, errors };
}

function captureRes(): {
  res: { status(code: number): { json(body: unknown): void } };
  sent: { status?: number; body?: unknown };
} {
  const sent: { status?: number; body?: unknown } = {};
  return {
    sent,
    res: {
      status(code: number) {
        sent.status = code;
        return {
          json(body: unknown) {
            sent.body = body;
          },
        };
      },
    },
  };
}

/** Throw through the REAL bus, so the wrap is the one routes actually see. */
async function throwThroughBus(thrown: unknown): Promise<unknown> {
  const bus = new HookBus();
  bus.registerService(AUTH_REQUIRE_USER_HOOK, 'fake-auth', async () => {
    throw thrown;
  });
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
  try {
    await bus.call(AUTH_REQUIRE_USER_HOOK, ctx, { req: {} });
  } catch (err) {
    return err;
  }
  throw new Error('bus.call did not throw');
}

describe('isUnauthenticated', () => {
  it('is true only for the hook refusal code', async () => {
    const refusal = await throwThroughBus(
      new PluginError({ code: 'unauthenticated', plugin: 'fake-auth', message: 'no session cookie' }),
    );
    expect(isUnauthenticated(refusal)).toBe(true);
  });

  it('is false for a store fault the bus wrapped', async () => {
    const wrapped = await throwThroughBus(new Error(FAULT));
    // Guard the premise: this IS a PluginError, which is why instanceof alone was wrong.
    expect(wrapped).toBeInstanceOf(PluginError);
    expect((wrapped as PluginError).code).toBe('unknown');
    expect(isUnauthenticated(wrapped)).toBe(false);
  });

  it('is false for other PluginError codes and non-errors', () => {
    for (const code of ['timeout', 'no-service', 'invalid-return', 'forbidden']) {
      expect(isUnauthenticated(new PluginError({ code, plugin: 'x', message: 'm' }))).toBe(false);
    }
    expect(isUnauthenticated({ rejected: true, reason: 'no' })).toBe(false);
    expect(isUnauthenticated(new Error('unauthenticated'))).toBe(false);
    expect(isUnauthenticated(undefined)).toBe(false);
  });
});

describe('answerRequireUserFailure', () => {
  it('answers the refusal with 401 and logs nothing', async () => {
    const err = await throwThroughBus(
      new PluginError({ code: 'unauthenticated', plugin: 'fake-auth', message: 'session unknown or expired' }),
    );
    const { logger, errors } = captureLogger();
    const { res, sent } = captureRes();
    answerRequireUserFailure({ logger }, res, err, 'test_require_user_failed');
    expect(sent).toEqual({ status: 401, body: { error: 'unauthenticated' } });
    expect(errors).toEqual([]);
  });

  it('answers a wrapped store fault with a logged 500 that does not echo the message', async () => {
    const err = await throwThroughBus(new Error(FAULT));
    const { logger, errors } = captureLogger();
    const { res, sent } = captureRes();
    answerRequireUserFailure({ logger }, res, err, 'test_require_user_failed');

    expect(sent).toEqual({ status: 500, body: { error: 'internal' } });
    expect(JSON.stringify(sent.body)).not.toContain(FAULT);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toBe('test_require_user_failed');
    expect(errors[0]!.b!.hook).toBe('auth:require-user');
    const logged = errors[0]!.b!.err as PluginError;
    expect(logged).toBe(err);
    expect(logged.code).toBe('unknown');
    expect((logged.cause as Error).message).toBe(FAULT);
  });

  it('treats a bus timeout as a fault, not as signed out', () => {
    const { logger, errors } = captureLogger();
    const { res, sent } = captureRes();
    answerRequireUserFailure(
      { logger },
      res,
      new PluginError({ code: 'timeout', plugin: 'fake-auth', message: 'exceeded' }),
      'ev',
    );
    expect(sent.status).toBe(500);
    expect(errors).toHaveLength(1);
  });
});
