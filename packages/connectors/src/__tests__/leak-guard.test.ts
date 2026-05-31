import { describe, expect, it } from 'vitest';
import {
  DeleteOutputSchema,
  GetOutputSchema,
  ListDefaultsOutputSchema,
  ListOutputSchema,
  ResolveOutputSchema,
  UpsertOutputSchema,
} from '../types.js';

// ---------------------------------------------------------------------------
// Boundary-review-as-a-test (Invariant I1 + the design's boundary review).
//
// The connector's BACKING mechanism (MCP over http/stdio, a CLI package, a
// direct API) must live ONLY inside the `capabilities` spec object — never as a
// FIRST-CLASS field on a hook payload. This test pins that: a regression that
// hoisted `transport` / `command` / `stdio` / `url` / `mcp` (or `mcpServers`)
// to a top-level hook field would fail here. `keyMode` / `visibility` /
// `usageNote` are storage-agnostic and explicitly allowed.
// ---------------------------------------------------------------------------

const LEAKY_FIRST_CLASS_FIELDS = [
  'transport',
  'command',
  'stdio',
  'url',
  'mcp',
  'mcpServers',
  'packages',
  'allowedHosts',
  'credentials',
];

/** Collect every object key reachable from a zod schema EXCEPT keys that sit
 *  inside a `capabilities` subtree (those are the allowed home for mechanism
 *  vocabulary). */
function topLevelKeysOutsideCapabilities(shape: Record<string, unknown>): string[] {
  const keys: string[] = [];
  function walk(s: unknown): void {
    if (s === null || typeof s !== 'object') return;
    // A zod object exposes its shape via .shape (zod v3). We duck-type it.
    const def = (s as { _def?: { typeName?: string } })._def;
    const typeName = def?.typeName;
    if (typeName === 'ZodObject') {
      const objShape = (s as { shape: Record<string, unknown> }).shape;
      for (const [key, child] of Object.entries(objShape)) {
        keys.push(key);
        // Do NOT descend into the `capabilities` subtree — that's where the
        // mechanism vocabulary is allowed to live.
        if (key === 'capabilities') continue;
        walk(child);
      }
    } else if (typeName === 'ZodArray') {
      walk((s as { element: unknown }).element);
    } else if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
      walk((s as { unwrap: () => unknown }).unwrap());
    } else if (typeName === 'ZodUnion') {
      for (const opt of (s as { options: unknown[] }).options) walk(opt);
    }
  }
  walk(shape);
  return keys;
}

describe('@ax/connectors hook surface — no leaked backing-mechanism fields', () => {
  const schemas = {
    'connectors:list': ListOutputSchema,
    'connectors:list-defaults': ListDefaultsOutputSchema,
    'connectors:get': GetOutputSchema,
    'connectors:upsert': UpsertOutputSchema,
    'connectors:delete': DeleteOutputSchema,
    'connectors:resolve': ResolveOutputSchema,
  };

  for (const [hook, schema] of Object.entries(schemas)) {
    it(`${hook} return shape has no first-class mechanism field outside capabilities`, () => {
      const keys = topLevelKeysOutsideCapabilities(schema);
      for (const leaky of LEAKY_FIRST_CLASS_FIELDS) {
        expect(keys).not.toContain(leaky);
      }
    });
  }

  it('the storage-agnostic fields ARE present on the connector get shape', () => {
    const keys = topLevelKeysOutsideCapabilities(GetOutputSchema);
    // keyMode / visibility / usageNote are fine (design: storage-agnostic).
    expect(keys).toContain('keyMode');
    expect(keys).toContain('visibility');
    expect(keys).toContain('usageNote');
    // capabilities IS a top-level key (it just isn't descended into).
    expect(keys).toContain('capabilities');
  });

  it('the resolve credential plan + consent gate are storage-agnostic (TASK-96)', () => {
    // The derived credentialPlan exposes only neutral fields — slot / scope / ref
    // — and the consent gate is a boolean. `scope` carries the neutral
    // credential-scope contract (`user`/`global`), NOT backend vocabulary, so it
    // is NOT in the leaky-field list above. The plan never surfaces a backing
    // mechanism (transport/command/url/mcp) — that already lives only inside
    // capabilities, which the walk above pins for the resolve shape too.
    const keys = topLevelKeysOutsideCapabilities(ResolveOutputSchema);
    expect(keys).toContain('credentialPlan');
    expect(keys).toContain('requiresSharedKeyConsent');
    expect(keys).toContain('slot');
    expect(keys).toContain('scope');
    expect(keys).toContain('ref');
  });
});
