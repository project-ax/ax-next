import { describe, it, expect } from 'vitest';
import { OptionalCallSchema } from '@ax/core';
import { DISPATCHER_DEPENDENCIES } from '../dependencies.js';

// ---------------------------------------------------------------------------
// DISPATCHER_DEPENDENCIES — the dispatcher package's single source of truth
// for the service hooks it transitively invokes. Both @ax/ipc-http and
// @ax/ipc-server spread it into their manifests; the in-sync test
// (dependency-sync.test.ts) keeps it honest against the handler source.
//
// These tests assert the shape + internal consistency of the const itself —
// well-formed, contradiction-free, and parseable against the @ax/core schema
// the transports stamp it into.
// ---------------------------------------------------------------------------

describe('DISPATCHER_DEPENDENCIES', () => {
  it('requiredCalls are non-empty unique hook strings', () => {
    const required = DISPATCHER_DEPENDENCIES.requiredCalls;
    expect(required.length).toBeGreaterThan(0);
    for (const hook of required) {
      expect(typeof hook).toBe('string');
      expect(hook.length).toBeGreaterThan(0);
    }
    expect(new Set(required).size).toBe(required.length);
  });

  it('optionalCalls each parse against OptionalCallSchema (hook + degradation)', () => {
    expect(DISPATCHER_DEPENDENCIES.optionalCalls.length).toBeGreaterThan(0);
    for (const oc of DISPATCHER_DEPENDENCIES.optionalCalls) {
      // The transports stamp these straight into manifest.optionalCalls, so
      // each must satisfy the schema @ax/core validates manifests against.
      expect(() => OptionalCallSchema.parse(oc)).not.toThrow();
    }
  });

  it('optionalCalls hooks are unique', () => {
    const hooks = DISPATCHER_DEPENDENCIES.optionalCalls.map((oc) => oc.hook);
    expect(new Set(hooks).size).toBe(hooks.length);
  });

  it('required and optional hook sets are disjoint (a hook is one or the other)', () => {
    const required = new Set(DISPATCHER_DEPENDENCIES.requiredCalls);
    const overlap = DISPATCHER_DEPENDENCIES.optionalCalls
      .map((oc) => oc.hook)
      .filter((h) => required.has(h));
    // @ax/core's PluginManifestSchema superRefine rejects this contradiction;
    // catch it here at the source so the manifest spread can't trip it.
    expect(overlap).toEqual([]);
  });

  it('dynamicCallPatterns are non-empty prefix strings', () => {
    expect(DISPATCHER_DEPENDENCIES.dynamicCallPatterns.length).toBeGreaterThan(0);
    for (const pattern of DISPATCHER_DEPENDENCIES.dynamicCallPatterns) {
      expect(typeof pattern).toBe('string');
      expect(pattern.length).toBeGreaterThan(0);
    }
  });

  it('exposes tool:execute: as a dynamic pattern (resolved by hasService at dispatch time)', () => {
    expect(DISPATCHER_DEPENDENCIES.dynamicCallPatterns).toContain('tool:execute:');
  });

  it('does NOT list any dynamic-pattern hook in requiredCalls or optionalCalls', () => {
    // tool:execute:<name> can't be enumerated at manifest time; it must live
    // in dynamicCallPatterns only, never in the named-hook lists (verifyCalls
    // only enforces named hooks).
    const named = [
      ...DISPATCHER_DEPENDENCIES.requiredCalls,
      ...DISPATCHER_DEPENDENCIES.optionalCalls.map((oc) => oc.hook),
    ];
    for (const pattern of DISPATCHER_DEPENDENCIES.dynamicCallPatterns) {
      expect(named.some((h) => h.startsWith(pattern))).toBe(false);
    }
  });
});
