import { PluginError } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { mapPluginError } from '../errors.js';

// BUG-W2 follow-up: authored-skill validation errors must surface their message
// to the runner (→ the model), while every other code stays collapsed to the
// generic 500 (I9: no info leak). These pin both halves.

describe('mapPluginError — authored-skill validation message surfacing', () => {
  it('surfaces authored-skill-invalid message verbatim (422 VALIDATION)', () => {
    const err = new PluginError({
      code: 'authored-skill-invalid',
      plugin: '@ax/agents',
      message: "the authored skill 'linear' at .ax/skills/linear/SKILL.md has invalid frontmatter: \"description\" must be ≤ 240 characters, got 578. Fix the file and call install_authored_skill again.",
    });
    const out = mapPluginError(err);
    expect(out.status).toBe(422);
    expect(out.body.error.code).toBe('VALIDATION');
    expect(out.body.error.message).toContain('≤ 240 characters');
    expect(out.body.error.message).toContain('install_authored_skill again');
  });

  it('surfaces authored-skill-not-found message verbatim', () => {
    const err = new PluginError({
      code: 'authored-skill-not-found',
      plugin: '@ax/agents',
      message: "no authored skill 'linear' in the workspace",
    });
    const out = mapPluginError(err);
    expect(out.status).toBe(422);
    expect(out.body.error.message).toBe("no authored skill 'linear' in the workspace");
  });

  it('redacts authored-skill codes from a FOREIGN plugin to a generic 500 (codes are open strings)', () => {
    // A third-party plugin could reuse the authored-skill codes to try to
    // paint an arbitrary message onto the wire. The verbatim passthrough is
    // gated on the owning plugin (@ax/agents), so a foreign producer collapses
    // to the redacted 500 like any other code.
    const err = new PluginError({
      code: 'authored-skill-invalid',
      plugin: '@ax/evil-third-party',
      message: 'leaked: db password is hunter2',
    });
    const out = mapPluginError(err);
    expect(out.status).toBe(500);
    expect(out.body.error.code).toBe('INTERNAL');
    expect(out.body.error.message).toBe('internal server error');
    expect(out.body.error.message).not.toContain('hunter2');
  });

  it('still collapses unrelated codes to a generic 500 (no info leak)', () => {
    const err = new PluginError({
      code: 'timeout',
      plugin: '@ax/secret-thing',
      message: 'connected to internal-host:5432 with password hunter2',
    });
    const out = mapPluginError(err);
    expect(out.status).toBe(500);
    expect(out.body.error.message).toBe('internal server error');
    expect(out.body.error.message).not.toContain('hunter2');
  });
});
