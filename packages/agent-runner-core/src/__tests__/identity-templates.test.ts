import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_TEMPLATE,
  IDENTITY_SCAFFOLD,
  SOUL_SCAFFOLD,
} from '../identity-templates.js';

describe('BOOTSTRAP_TEMPLATE (v2-adapted from openclaw canonical)', () => {
  it('opens conversationally — the agent wakes up and talks, no form', () => {
    const t = BOOTSTRAP_TEMPLATE.toLowerCase();
    expect(t).toContain('woke up');
    // Talk-first, not a checklist/form.
    expect(t).toMatch(/talk|conversation/);
    expect(t).toMatch(/do not.*(form|interrogat)|not.*(a form|robotic)/);
  });

  it('uses the v2 `Write` tool and `.ax/` paths — never the v1 `write_file`', () => {
    expect(BOOTSTRAP_TEMPLATE).toContain('Write');
    expect(BOOTSTRAP_TEMPLATE).toContain('.ax/IDENTITY.md');
    expect(BOOTSTRAP_TEMPLATE).toContain('.ax/SOUL.md');
    // The v1/openclaw write tool name must be gone.
    expect(BOOTSTRAP_TEMPLATE).not.toContain('write_file');
  });

  it('names its own path so the completion ritual self-deletes the bootstrap script', () => {
    expect(BOOTSTRAP_TEMPLATE).toContain('.ax/BOOTSTRAP.md');
    const t = BOOTSTRAP_TEMPLATE.toLowerCase();
    expect(t).toContain('delete');
  });

  it('adapts the memory section to @ax/memory-strata (memory_note), not raw memory files', () => {
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

describe('identity scaffolds', () => {
  it('IDENTITY_SCAFFOLD is a short markdown stub', () => {
    expect(IDENTITY_SCAFFOLD).toContain('#');
    expect(IDENTITY_SCAFFOLD.length).toBeGreaterThan(0);
  });

  it('SOUL_SCAFFOLD is a short markdown stub', () => {
    expect(SOUL_SCAFFOLD).toContain('#');
    expect(SOUL_SCAFFOLD.length).toBeGreaterThan(0);
  });
});
