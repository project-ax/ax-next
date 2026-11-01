import { describe, expect, it } from 'vitest';
import * as templates from '../identity-templates.js';
import { BOOTSTRAP_TEMPLATE } from '../identity-templates.js';

describe('BOOTSTRAP_TEMPLATE (v2-adapted from openclaw canonical)', () => {
  it('opens conversationally — the agent wakes up and talks, no form', () => {
    const t = BOOTSTRAP_TEMPLATE.toLowerCase();
    expect(t).toContain('woke up');
    // Talk-first, not a checklist/form.
    expect(t).toMatch(/talk|conversation/);
    expect(t).toMatch(/do not.*(form|interrogat)|not.*(a form|robotic)/);
  });

  it('saves identity and soul with update_identity — never the v1 `write_file`', () => {
    expect(BOOTSTRAP_TEMPLATE).toContain('update_identity');
    expect(BOOTSTRAP_TEMPLATE).toContain('section: "identity"');
    expect(BOOTSTRAP_TEMPLATE).toContain('section: "soul"');
    // The v1/openclaw write tool name must be gone.
    expect(BOOTSTRAP_TEMPLATE).not.toContain('write_file');
  });

  it('finishes with complete_bootstrap and names no files or Write tool (TASK-989)', () => {
    expect(BOOTSTRAP_TEMPLATE).toContain('complete_bootstrap');
    expect(BOOTSTRAP_TEMPLATE).not.toMatch(/\.ax\//);
    expect(BOOTSTRAP_TEMPLATE).not.toContain('BOOTSTRAP.md');
    expect(BOOTSTRAP_TEMPLATE).not.toContain('`Write`');
  });

  it('adapts the memory section to @ax/memory (memory_note), not raw memory files', () => {
    expect(BOOTSTRAP_TEMPLATE).toContain('memory_note');
  });

  it('is trimmed of USER.md and channel-linking (out of scope this epic)', () => {
    expect(BOOTSTRAP_TEMPLATE).not.toContain('USER.md');
    const t = BOOTSTRAP_TEMPLATE.toLowerCase();
    expect(t).not.toContain('whatsapp');
    expect(t).not.toContain('telegram');
    expect(t).not.toContain('botfather');
    expect(t).not.toContain('qr code');
  });

  it('carries no security-first / canary framing (openclaw canonical, not the ax v1 fork)', () => {
    const t = BOOTSTRAP_TEMPLATE.toLowerCase();
    expect(t).not.toContain('canary');
    expect(t).not.toContain('paranoid');
    expect(t).not.toContain('taint');
  });
});

// The identity and soul stub scaffolds belonged to the file tier TASK-989
// retired: identity and soul are rows written through `update_identity`, and no
// runner writes a stub file (TASK-995).
describe('identity scaffolds', () => {
  it('are not re-exported to the runner', () => {
    expect(Object.keys(templates)).not.toContain('IDENTITY_SCAFFOLD');
    expect(Object.keys(templates)).not.toContain('SOUL_SCAFFOLD');
    // What the runner does use is still here.
    expect(Object.keys(templates).sort()).toEqual([
      'BOOTSTRAP_TEMPLATE',
      'bootstrapPreamble',
      'fallbackIdentityLine',
    ]);
  });
});
