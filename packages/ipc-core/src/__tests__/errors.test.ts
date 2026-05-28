import { PluginError } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { mapPluginError } from '../errors.js';

// BUG-W2 follow-up + security review: the SKILL.md validation message
// (`authored-skill-invalid` / `-not-found`) is surfaced to the agent ONLY at
// the verified single-registrant `install_authored_skill` tool path (see
// tool-execute-host.ts + its dispatcher tests). The GENERIC `mapPluginError`
// — reachable from every dispatch path — must NOT special-case these codes:
// `PluginError.code`/`.plugin` are plugin-supplied (the bus re-throws thrown
// PluginErrors verbatim), so doing so would let any plugin (incl. untrusted
// third-party code, invariant #5) forge the codes to bypass I9 redaction.
// These pin that the generic mapper redacts them like every other code.

describe('mapPluginError — authored-skill codes are redacted (surfacing is gated elsewhere)', () => {
  it('redacts authored-skill-invalid to a generic 500 — even from @ax/agents', () => {
    // @ax/agents is the genuine producer, but the message must NOT be surfaced
    // here: the generic mapper can't verify the producer (codes/plugin are
    // spoofable), so it redacts. Surfacing happens at the tool path instead.
    const err = new PluginError({
      code: 'authored-skill-invalid',
      plugin: '@ax/agents',
      message: "the authored skill 'linear' has invalid frontmatter: \"description\" must be ≤ 240 characters, got 578.",
    });
    const out = mapPluginError(err);
    expect(out.status).toBe(500);
    expect(out.body.error.code).toBe('INTERNAL');
    expect(out.body.error.message).toBe('internal server error');
  });

  it('redacts a FORGED authored-skill-invalid (spoofed plugin + secret message) to 500', () => {
    // A third-party plugin reusing the code with a spoofed `plugin` field and a
    // secret in the message must not leak through the generic mapper.
    const err = new PluginError({
      code: 'authored-skill-invalid',
      plugin: '@ax/agents', // spoofed — codes/plugin are plugin-supplied
      message: 'leaked: db password is hunter2',
    });
    const out = mapPluginError(err);
    expect(out.status).toBe(500);
    expect(out.body.error.message).toBe('internal server error');
    expect(out.body.error.message).not.toContain('hunter2');
  });

  it('redacts authored-skill-not-found to 500', () => {
    const err = new PluginError({
      code: 'authored-skill-not-found',
      plugin: '@ax/agents',
      message: "no authored skill 'linear' in the workspace",
    });
    const out = mapPluginError(err);
    expect(out.status).toBe(500);
    expect(out.body.error.message).toBe('internal server error');
  });

  it('collapses unrelated codes to a generic 500 (no info leak)', () => {
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
