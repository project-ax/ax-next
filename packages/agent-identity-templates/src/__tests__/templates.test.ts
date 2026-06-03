import { describe, it, expect } from 'vitest';
import {
  BOOTSTRAP_TEMPLATE,
  IDENTITY_SCAFFOLD,
  SOUL_SCAFFOLD,
  fallbackIdentityLine,
} from '../index.js';

describe('agent-identity-templates', () => {
  it('BOOTSTRAP_TEMPLATE names its own deletable path and uses the Write tool', () => {
    expect(BOOTSTRAP_TEMPLATE).toContain('.ax/BOOTSTRAP.md');
    expect(BOOTSTRAP_TEMPLATE).toContain('`Write`');
    expect(BOOTSTRAP_TEMPLATE).toContain('.ax/IDENTITY.md');
    expect(BOOTSTRAP_TEMPLATE).toContain('.ax/SOUL.md');
    // Conversational, not a form (the openclaw canonical posture).
    expect(BOOTSTRAP_TEMPLATE).toContain('Talk first');
  });

  it('scaffolds are non-empty markdown', () => {
    expect(IDENTITY_SCAFFOLD).toContain('# Identity');
    expect(SOUL_SCAFFOLD).toContain('# Soul');
  });

  it('fallbackIdentityLine names the agent', () => {
    expect(fallbackIdentityLine('Ada')).toBe('You are Ada, a helpful personal assistant.');
    expect(fallbackIdentityLine('Sol the Helper')).toBe(
      'You are Sol the Helper, a helpful personal assistant.',
    );
  });
});
