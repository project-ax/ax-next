import { describe, it, expect } from 'vitest';
import {
  PROVIDER_ENDPOINTS,
  providerEndpointFor,
  type ProviderEndpoint,
} from '../providers.js';
import { parseModelRef } from '../model-ref.js';

const entries = Object.entries(PROVIDER_ENDPOINTS) as [string, ProviderEndpoint][];

describe('PROVIDER_ENDPOINTS', () => {
  it('has at least one entry', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s: egressHost matches the baseUrl host', (_key, ep) => {
    expect(ep.egressHost).toBe(new URL(ep.baseUrl).host);
  });

  it.each(entries)('%s: credentialRef is provider:<id>', (_key, ep) => {
    expect(ep.credentialRef).toBe(`provider:${ep.id}`);
  });

  it.each(entries)('%s: record key equals the entry id', (key, ep) => {
    expect(ep.id).toBe(key);
  });

  it.each(entries)(
    '%s: credentialEnvVar is SCREAMING_SNAKE_CASE',
    (_key, ep) => {
      expect(ep.credentialEnvVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
    },
  );

  it.each(entries)('%s: baseUrl is https', (_key, ep) => {
    expect(new URL(ep.baseUrl).protocol).toBe('https:');
  });

  it.each(entries)(
    '%s: id is a valid provider half of a model ref',
    (_key, ep) => {
      expect(parseModelRef(`${ep.id}/x`).provider).toBe(ep.id);
    },
  );

  it.each(entries)('%s: name and description are non-empty', (_key, ep) => {
    expect(ep.name.length).toBeGreaterThan(0);
    expect(ep.description.length).toBeGreaterThan(0);
  });

  it('anthropic description matches the orchestrator KNOWN_PROVIDERS wording', () => {
    expect(PROVIDER_ENDPOINTS.anthropic.description).toBe(
      'API key from console.anthropic.com.',
    );
  });
});

describe('providerEndpointFor', () => {
  it('returns the matching entry for a known provider', () => {
    expect(providerEndpointFor('anthropic')).toBe(PROVIDER_ENDPOINTS.anthropic);
  });

  it('returns undefined for an unknown provider', () => {
    expect(providerEndpointFor('nope')).toBeUndefined();
  });

  it('returns undefined for "constructor" (prototype-pollution guard)', () => {
    expect(providerEndpointFor('constructor')).toBeUndefined();
  });

  it('returns undefined for "__proto__" (prototype-pollution guard)', () => {
    expect(providerEndpointFor('__proto__')).toBeUndefined();
  });

  it('returns undefined for "toString" (another Object.prototype member)', () => {
    expect(providerEndpointFor('toString')).toBeUndefined();
  });
});
