import { describe, it, expect } from 'vitest';
import * as templates from '../index.js';
import { BOOTSTRAP_TEMPLATE, fallbackIdentityLine } from '../index.js';

describe('agent-identity-templates', () => {
  it('the bootstrap script saves with update_identity and finishes with complete_bootstrap', () => {
    expect(BOOTSTRAP_TEMPLATE).toContain('update_identity');
    expect(BOOTSTRAP_TEMPLATE).toContain('section: "identity"');
    expect(BOOTSTRAP_TEMPLATE).toContain('section: "soul"');
    expect(BOOTSTRAP_TEMPLATE).toContain('complete_bootstrap');
    expect(BOOTSTRAP_TEMPLATE).toContain('memory_note');
    // Conversational, not a form (the openclaw canonical posture).
    expect(BOOTSTRAP_TEMPLATE).toContain('Talk first');
  });

  it('it names no files and no Write tool', () => {
    expect(BOOTSTRAP_TEMPLATE).not.toMatch(/\.ax\//);
    expect(BOOTSTRAP_TEMPLATE).not.toContain('BOOTSTRAP.md');
    expect(BOOTSTRAP_TEMPLATE).not.toContain('`Write`');
  });

  // Identity and soul are rows the agent writes with `update_identity`
  // (TASK-989), so there is no file for a stub to start (TASK-995).
  it('exports no identity or soul file scaffolds', () => {
    expect(Object.keys(templates)).not.toContain('IDENTITY_SCAFFOLD');
    expect(Object.keys(templates)).not.toContain('SOUL_SCAFFOLD');
    expect(Object.keys(templates).sort()).toEqual([
      'BOOTSTRAP_TEMPLATE',
      'bootstrapPreamble',
      'fallbackIdentityLine',
    ]);
  });

  it('fallbackIdentityLine names the agent', () => {
    expect(fallbackIdentityLine('Ada')).toBe('You are Ada, a helpful personal assistant.');
    expect(fallbackIdentityLine('Sol the Helper')).toBe(
      'You are Sol the Helper, a helpful personal assistant.',
    );
  });
});
