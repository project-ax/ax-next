import { PluginError } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { mapPluginError } from '../errors.js';
import { validateEventChatEnd } from '../handlers/event-chat-end.js';
import { EventChatEndSchema } from '@ax/ipc-protocol';
import { vi } from 'vitest';

it('a validation refusal never reads ZodError.message', () => {
  const parsed = EventChatEndSchema.safeParse({});
  if (parsed.success) throw new Error('expected an invalid fixture');
  const message = vi.spyOn(Object.getPrototypeOf(parsed.error), 'message', 'get').mockImplementation(() => { throw new Error('unbounded serialization'); });
  try {
    expect(validateEventChatEnd({ outcome: { kind: 'invalid' } })).toMatchObject({ status: 400 });
  } finally { message.mockRestore(); }
});

it('bounds a refusal and omits invalid values from the summary', () => {
  const out = validateEventChatEnd({ outcome: { kind: 'PRIVATE_'.repeat(10_000) } });
  expect(out).toMatchObject({ status: 400 });
  if ('body' in out) {
    expect(out.body.error.message.length).toBeLessThanOrEqual(1024);
    expect(out.body.error.message).not.toContain('PRIVATE_');
  }
});

// Security review: the GENERIC `mapPluginError` — reachable from every dispatch
// path — must NOT special-case a PluginError's message onto the wire.
// `PluginError.code`/`.plugin` are plugin-supplied (the bus re-throws thrown
// PluginErrors verbatim), so doing so would let any plugin (incl. untrusted
// third-party code, invariant #5) forge a code to bypass I9 redaction. These
// pin that any unmapped code — even one carrying a secret message — redacts to
// a generic 500.

describe('mapPluginError — unmapped codes redact to a generic 500 (no info leak)', () => {
  it('redacts a FORGED code (spoofed plugin + secret message) to 500', () => {
    // A third-party plugin reusing an unmapped code with a spoofed `plugin`
    // field and a secret in the message must not leak through the generic mapper.
    const err = new PluginError({
      code: 'subscriber-failed',
      plugin: '@ax/agents', // spoofed — codes/plugin are plugin-supplied
      message: 'leaked: db password is hunter2',
    });
    const out = mapPluginError(err);
    expect(out.status).toBe(500);
    expect(out.body.error.code).toBe('INTERNAL');
    expect(out.body.error.message).toBe('internal server error');
    expect(out.body.error.message).not.toContain('hunter2');
  });

  it('collapses unrelated codes to a generic 500 (no info leak)', () => {
    const err = new PluginError({
      code: 'timeout',
      plugin: '@ax/secret-thing',
      message: 'connected to internal-host:5432 with password hunter2',
    });
    const out = mapPluginError(err);
    expect(out.status).toBe(500);
    expect(out.body.error.message).toBe('internal server error');
    expect(out.body.error.message).not.toContain('hunter2');
  });
});
