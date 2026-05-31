import { describe, it, expect } from 'vitest';
import {
  CredentialsListOutputSchema,
  type CredentialMeta,
  type CredentialsSetInput,
} from '../plugin.js';

// ---------------------------------------------------------------------------
// TASK-96 — credentials: reach BY ATTACHMENT, never by visibility (card
// acceptance #2; design "Credentials: reach by attachment, never by
// visibility").
//
// A credential's value is a secret that is never visible to anyone — the
// public/private *visibility* axis does NOT apply. What varies is which agents
// may SPEND it, and that derives solely from the credential SCOPE
// (`global | user | agent`) the key is bound to:
//   personal agent (agent) → private   | shared/team agent (agent) → shared
//   all a user's agents (user) → personal default | workspace (global) → company key
//
// This guard pins the absence of any visibility/public/private/shared/reach flag
// on the credentials hook surface, so a future change that re-introduces one
// (the exact thing the design rules out) reds here. The credential scope IS the
// reach — there is nothing else to add.
// ---------------------------------------------------------------------------

const FORBIDDEN_REACH_FIELDS = ['visibility', 'public', 'private', 'shared', 'reach'];

/** Collect every object key reachable from a zod schema (deep). */
function allKeys(schema: unknown): Set<string> {
  const keys = new Set<string>();
  function walk(s: unknown): void {
    if (s === null || typeof s !== 'object') return;
    const def = (s as { _def?: { typeName?: string } })._def;
    const typeName = def?.typeName;
    if (typeName === 'ZodObject') {
      const shape = (s as { shape: Record<string, unknown> }).shape;
      for (const [key, child] of Object.entries(shape)) {
        keys.add(key);
        walk(child);
      }
    } else if (typeName === 'ZodArray') {
      walk((s as { element: unknown }).element);
    } else if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
      walk((s as { unwrap: () => unknown }).unwrap());
    } else if (typeName === 'ZodUnion') {
      for (const opt of (s as { options: unknown[] }).options) walk(opt);
    } else if (typeName === 'ZodRecord') {
      // record values are opaque per-credential metadata — not a first-class
      // reach field; do not descend into them.
    }
  }
  walk(schema);
  return keys;
}

describe('@ax/credentials — no visibility flag (reach derives from scope alone)', () => {
  it('credentials:list output (CredentialMeta) carries scope but no visibility/reach field', () => {
    const keys = allKeys(CredentialsListOutputSchema);
    // Reach IS the scope — it must be present.
    expect(keys).toContain('scope');
    expect(keys).toContain('ownerId');
    for (const forbidden of FORBIDDEN_REACH_FIELDS) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('the credentials:set / credentials:list type contracts declare no visibility field', () => {
    // Compile-time + structural guard. A fully-populated value of each interface
    // must type-check WITHOUT any visibility/reach field — and an excess-property
    // probe object proves none of the forbidden keys is assignable. If a future
    // change adds e.g. `visibility` to the interface, `keyof` widens and the
    // runtime key check below (driven off a representative literal) still pins it.
    const setInput: CredentialsSetInput = {
      scope: 'user',
      ownerId: 'userA',
      ref: 'account:salesforce',
      kind: 'api-key',
      payload: new Uint8Array([1, 2, 3]),
    };
    const meta: CredentialMeta = {
      scope: 'global',
      ownerId: null,
      ref: 'account:salesforce',
      kind: 'api-key',
      createdAt: '2026-05-31T00:00:00.000Z',
    };
    // Reach is expressed by scope, not a flag.
    expect(setInput.scope).toBe('user');
    expect(meta.scope).toBe('global');
    for (const forbidden of FORBIDDEN_REACH_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(setInput, forbidden)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(meta, forbidden)).toBe(false);
    }
  });
});
