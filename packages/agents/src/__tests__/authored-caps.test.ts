import { describe, it, expect } from 'vitest';
import { projectAuthoredBundle } from '../authored-caps.js';

// TASK-100 — a skill manifest declares no capabilities (its reach is the
// connectors it references), so the proposal∩approved intersect machinery
// (intersectProposalWithApproved + EMPTY_CAPABILITIES) was removed.
// projectAuthoredBundle now simply parses the cap-free manifest and surfaces its
// description + connector references.

describe('projectAuthoredBundle', () => {
  const MANIFEST =
    'name: linear\n' +
    'description: Query Linear issues\n' +
    'connectors:\n' +
    '  - linear\n';

  it('returns null for an unparseable manifest', () => {
    expect(projectAuthoredBundle(': not yaml : [')).toBeNull();
  });

  it('returns null for a manifest that still carries a capabilities block (parser rejects it)', () => {
    const withCaps =
      'name: linear\ndescription: x\ncapabilities:\n  allowedHosts:\n    - api.linear.app\n';
    expect(projectAuthoredBundle(withCaps)).toBeNull();
  });

  it('surfaces the description + connector references of a cap-free manifest', () => {
    const out = projectAuthoredBundle(MANIFEST);
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.description).toBe('Query Linear issues');
    expect(out.connectors).toEqual(['linear']);
    // The manifest is returned verbatim — it is already cap-free (the parser
    // rejects a capabilities block), so the materialized SKILL.md never carries one.
    expect(out.manifestYaml).toBe(MANIFEST);
    expect(out.manifestYaml).not.toContain('capabilities');
  });

  it('defaults connectors to [] for a skill that references none', () => {
    const out = projectAuthoredBundle('name: notes\ndescription: Note-taking.\nversion: 1\n');
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.connectors).toEqual([]);
  });
});
