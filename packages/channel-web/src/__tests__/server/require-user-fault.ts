// Shared helpers for the "auth:require-user store fault" tests (TASK-1030).
//
// Only `unauthenticated` is a 401; any other failure of the session store is
// a logged generic 500 (never a silent sign-out). Each route family's test
// registers a RAW-throwing `auth:require-user` on a REAL HookBus (the bus
// wraps it as PluginError 'unknown'), then asserts through these helpers.

import { expect } from 'vitest';
import { makeAgentContext, PluginError, type AgentContext, type Logger } from '@ax/core';

/** A distinctive message so a leak into the response body is unmissable. */
export const STORE_FAULT_MESSAGE = 'pg down at 10.0.0.7';

export interface CapturingLogger extends Logger {
  errors: Array<{ event: string; fields: Record<string, unknown> | undefined }>;
}

export function capturingLogger(): CapturingLogger {
  const errors: CapturingLogger['errors'] = [];
  const logger: CapturingLogger = {
    errors,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (event, fields) => {
      errors.push({ event, fields });
    },
    child: () => logger,
  };
  return logger;
}

/** An init ctx whose logger records `error` calls. */
export function faultInitCtx(): { ctx: AgentContext; logger: CapturingLogger } {
  const logger = capturingLogger();
  const ctx = makeAgentContext({ sessionId: 'init', agentId: 'test', userId: 'system', logger });
  return { ctx, logger };
}

/** The raw error a crashing session store would throw (the bus wraps it). */
export function storeFault(): Error {
  return new Error(STORE_FAULT_MESSAGE);
}

/**
 * Assert the fault was logged exactly once under `event`, with the bus-wrapped
 * error (`code: 'unknown'`, `cause` = the raw store error), and that the
 * response carried a generic 500 that does not leak the fault message.
 */
export function expectLoggedRequireUserFault(
  logger: CapturingLogger,
  event: string,
  response: { status: number; body: unknown },
): void {
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: 'internal' });
  expect(JSON.stringify(response.body)).not.toContain(STORE_FAULT_MESSAGE);
  expect(logger.errors).toHaveLength(1);
  const entry = logger.errors[0]!;
  expect(entry.event).toBe(event);
  expect(entry.fields?.hook).toBe('auth:require-user');
  const err = entry.fields?.err;
  expect(err).toBeInstanceOf(PluginError);
  expect((err as PluginError).code).toBe('unknown');
  expect((err as PluginError).cause).toBeInstanceOf(Error);
  expect(((err as PluginError).cause as Error).message).toBe(STORE_FAULT_MESSAGE);
}
