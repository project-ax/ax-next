import { describe, expect, it } from 'vitest';
import { parseStored, pickDefault, serializeStored, validatePolicyInput } from '../policy.js';

const SONNET = 'anthropic/claude-sonnet-4-6';
const OPUS = 'anthropic/claude-opus-4-7';
const KIMI = 'openrouter/moonshotai/kimi-k3';

describe('validatePolicyInput', () => {
  it('accepts a normal selection and keeps its order', () => {
    expect(validatePolicyInput({ allowed: [KIMI, SONNET], default: SONNET })).toEqual({
      ok: true,
      value: { allowed: [KIMI, SONNET], default: SONNET },
    });
  });

  it.each([
    ['not an object', 'nope', 'invalid-payload'],
    ['null', null, 'invalid-payload'],
    ['an array', [], 'invalid-payload'],
    ['allowed missing', { default: SONNET }, 'invalid-payload'],
    ['allowed holding a non-string', { allowed: [SONNET, 3], default: SONNET }, 'invalid-payload'],
    ['an empty selection', { allowed: [], default: SONNET }, 'pick-at-least-one-model'],
    ['a bare id', { allowed: ['claude-sonnet-4-6'], default: 'claude-sonnet-4-6' }, 'invalid-model-ref'],
    ['whitespace in a ref', { allowed: ['anthropic/claude sonnet'], default: 'anthropic/claude sonnet' }, 'invalid-model-ref'],
    ['a duplicate', { allowed: [SONNET, SONNET], default: SONNET }, 'duplicate-model'],
    ['a Default that is not selected', { allowed: [SONNET], default: OPUS }, 'default-not-selected'],
    ['a missing Default', { allowed: [SONNET] }, 'default-not-selected'],
    ['a non-string Default', { allowed: [SONNET], default: 7 }, 'default-not-selected'],
  ])('rejects %s', (_label, input, code) => {
    const r = validatePolicyInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it('rejects more than 1000 models', () => {
    const allowed = Array.from({ length: 1001 }, (_, i) => `openrouter/vendor/model-${i}`);
    expect(validatePolicyInput({ allowed, default: allowed[0] })).toMatchObject({
      ok: false,
      code: 'too-many-models',
    });
  });

  it('accepts exactly 1000 models', () => {
    const allowed = Array.from({ length: 1000 }, (_, i) => `openrouter/vendor/model-${i}`);
    expect(validatePolicyInput({ allowed, default: allowed[0] }).ok).toBe(true);
  });

  it('rejects a ref longer than 200 characters', () => {
    const long = `openrouter/${'a'.repeat(200)}`;
    expect(validatePolicyInput({ allowed: [long], default: long })).toMatchObject({
      ok: false,
      code: 'invalid-model-ref',
    });
  });

  it('never echoes a hostile ref at full length in its message', () => {
    const r = validatePolicyInput({ allowed: ['x'.repeat(5000)], default: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeLessThan(200);
  });
});

describe('pickDefault', () => {
  it('honours a preferred default that is in the list', () => {
    expect(pickDefault([SONNET, OPUS], OPUS)).toBe(OPUS);
  });
  it('prefers Claude Sonnet when no preference is given', () => {
    expect(pickDefault([OPUS, SONNET])).toBe(SONNET);
  });
  it('falls back to the first entry', () => {
    expect(pickDefault([KIMI, OPUS])).toBe(KIMI);
  });
  it('ignores a preferred default that is not in the list', () => {
    expect(pickDefault([KIMI], OPUS)).toBe(KIMI);
  });
});

describe('parseStored / serializeStored', () => {
  const doc = {
    version: 3,
    allowed: [SONNET, KIMI],
    default: SONNET,
    updatedAt: '2026-09-30T18:00:00.000Z',
    updatedBy: 'usr_admin',
  };

  it('round-trips a valid document', () => {
    expect(parseStored(serializeStored(doc))).toEqual({ kind: 'ok', doc });
  });
  it('treats undefined and empty bytes as absent', () => {
    expect(parseStored(undefined)).toEqual({ kind: 'absent' });
    expect(parseStored(new Uint8Array())).toEqual({ kind: 'absent' });
  });
  it.each([
    ['invalid utf-8', new Uint8Array([0xff, 0xfe, 0xfd])],
    ['not json', new TextEncoder().encode('{nope')],
    ['the wrong shape', new TextEncoder().encode('{"hello":1}')],
    ['an unknown extra key', new TextEncoder().encode(JSON.stringify({ ...doc, extra: 1 }))],
    ['version 0', new TextEncoder().encode(JSON.stringify({ ...doc, version: 0 }))],
    ['a Default outside allowed', new TextEncoder().encode(JSON.stringify({ ...doc, default: OPUS }))],
    ['a bare id in allowed', new TextEncoder().encode(JSON.stringify({ ...doc, allowed: ['nope'], default: 'nope' }))],
  ])('reports %s as corrupt', (_label, bytes) => {
    expect(parseStored(bytes)).toEqual({ kind: 'corrupt' });
  });
});
