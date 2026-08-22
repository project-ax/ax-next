import { describe, expect, it } from 'vitest';
import { capabilityRows } from '../plugin.js';
import type { PolicyRule } from '../types.js';

const RULES: PolicyRule[] = [
  {
    id: 'z.deny',
    match: { tool: 'z' },
    verdict: 'deny',
    capability: 'delete anything',
    subject: 'agent',
  },
  {
    id: 'a.allow.second',
    match: { tool: 'a2' },
    verdict: 'allow',
    capability: 'search the web',
    subject: 'agent',
    provenance: 'catalog',
  },
  {
    id: 'b.hold',
    match: { tool: 'b' },
    verdict: 'hold',
    capability: 'write to a customer',
    subject: 'agent',
  },
  {
    id: 'a.allow.first',
    match: { tool: 'a1' },
    verdict: 'allow',
    capability: 'read a web page you name',
    subject: 'agent',
    provenance: 'catalog',
  },
];

describe('capabilityRows', () => {
  it('sorts allow → hold → deny (§4.3.2)', () => {
    expect(capabilityRows(RULES).map((r) => r.verdict)).toEqual([
      'allow',
      'allow',
      'hold',
      'deny',
    ]);
  });

  it('is stable inside a verdict group — authored order is reading order', () => {
    // `a.allow.second` is declared before `a.allow.first` in the table, so it
    // must stay first. A sort that reordered inside the group would make the
    // rail's reading order an accident.
    expect(capabilityRows(RULES).slice(0, 2).map((r) => r.source)).toEqual([
      'rule:a.allow.second',
      'rule:a.allow.first',
    ]);
  });

  it('stamps every built-in row described:true with a rule: source', () => {
    for (const row of capabilityRows(RULES)) {
      expect(row.described).toBe(true);
      expect(row.source.startsWith('rule:')).toBe(true);
      expect(row.theirDescription).toBeUndefined();
      expect(row.mechanicalLabel).toBeUndefined();
    }
  });

  it('carries provenance separately from the display source string', () => {
    const rows = capabilityRows(RULES);
    // The renderer switches on `provenance`; `source` is opaque display text
    // it must never parse (see the boundary review).
    expect(rows.find((r) => r.source === 'rule:a.allow.first')!.provenance).toBe('catalog');
    expect(rows.find((r) => r.source === 'rule:z.deny')!.provenance).toBe('rule');
  });

  it('does not mutate the rule table it was handed', () => {
    const before = JSON.stringify(RULES);
    capabilityRows(RULES);
    expect(JSON.stringify(RULES)).toBe(before);
  });
});
