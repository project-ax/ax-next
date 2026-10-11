import { describe, expect, it } from 'vitest';
import { HookBus, createLogger, makeAgentContext, PluginError, SafeToolError, safeToolMessage, type SafeToolCode, type SafeToolField } from '@ax/core';
import { toolExecuteHostHandler } from '../tool-execute-host.js';
async function dispatch(error: Error) {
  const bus = new HookBus();
  bus.registerService('tool:execute:example', '@ax/test-host-tool', async () => { throw error; });
  return toolExecuteHostHandler({ call: { id: 'call1', name: 'example', input: {} } }, makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: createLogger({ reqId: 'safe-tool-test', writer: () => {} }) }), bus);
}
describe('safe host tool failures', () => {
  it.each([['validation', 400, 'VALIDATION'], ['revision-conflict', 409, 'HOOK_REJECTED'], ['webhook-path-conflict', 409, 'HOOK_REJECTED'], ['request-conflict', 409, 'HOOK_REJECTED'], ['approval-required', 403, 'HOOK_REJECTED'], ['not-found', 404, 'NOT_FOUND'], ['forbidden', 403, 'HOOK_REJECTED'], ['disabled', 409, 'HOOK_REJECTED'], ['cleanup-pending', 409, 'HOOK_REJECTED'], ['unavailable', 503, 'INTERNAL']] as const)('maps %s to actionable wire status', async (code, status, wireCode) => {
    expect(await dispatch(new SafeToolError(code, 'input'))).toEqual({ status, body: { error: { code: wireCode, message: safeToolMessage(code, 'input') } } });
  });
  it('recomputes the closed message even if error.message was mutated', async () => {
    const error = new SafeToolError('revision-conflict', 'expectedRevision');
    error.message = 'private bearer secret';
    expect(await dispatch(error)).toEqual({ status: 409, body: { error: { code: 'HOOK_REJECTED', message: safeToolMessage('revision-conflict', 'expectedRevision') } } });
  });
  it('checks mutated code and field before mapping or messaging', async () => {
    const error = new SafeToolError('validation', 'name');
    Object.assign(error, { toolCode: 'secret' as SafeToolCode, field: 'private bearer secret' as SafeToolField });
    expect(await dispatch(error)).toEqual({ status: 503, body: { error: { code: 'INTERNAL', message: safeToolMessage('unavailable', 'input') } } });
  });
  it.each(['invalid-payload', 'validation', 'revision-conflict'])('redacts ordinary PluginError with safe-looking code %s', async (code) => {
    const result = await dispatch(new PluginError({ code, plugin: '@ax/core', message: 'private bearer secret' }));
    expect(JSON.stringify(result)).not.toContain('private bearer secret');
  });
  it('keeps infrastructure errors generic', async () => {
    expect(await dispatch(new Error('SQL private bearer secret'))).toEqual({ status: 500, body: { error: { code: 'INTERNAL', message: 'internal server error' } } });
  });
});
