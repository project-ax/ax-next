import { describe, expect, it } from 'vitest';
import {
  capabilityHandoffNote,
  clarifyingQuestionsNote,
  ephemeralScratchNote,
  operationalNotes,
  pythonVenvNote,
  skillAuthoringNote,
  workspaceNote,
} from '../system-prompt.js';

const WS = '/agent';

describe('workspaceNote', () => {
  it('names the workspace root and steers attachment paths away from home dirs', () => {
    const note = workspaceNote(WS);
    expect(note).toContain('`/agent`');
    expect(note).toContain('.ax/uploads');
    // The load-bearing instruction: resolve workspace-relative paths under the
    // workspace root, NOT a home directory (the bug this note prevents).
    expect(note).toMatch(/home directory|\/home|~/);
  });
});

describe('JIT capability-handoff note', () => {
  it('steers away from narrating the handoff or re-asking', () => {
    const note = capabilityHandoffNote().toLowerCase();
    expect(note).toContain('do not narrate');
    expect(note).toContain('re-ask');
    expect(note).toContain('continue automatically');
  });

  // TASK-56 (design §13): a needed-capability cold-start narrates "I've asked
  // your admin to add it" (approval-pending), NOT an error.
  it('narrates cold-start as an admin request, not an error', () => {
    const note = capabilityHandoffNote().toLowerCase();
    expect(note).toContain('asked your admin');
    expect(note).toContain('not an error');
  });
});

describe('skill-authoring note (TASK-74 §D6)', () => {
  it('states proposed skills are available next turn and not invokable now', () => {
    const note = skillAuthoringNote().toLowerCase();
    expect(note).toContain('skill_propose');
    expect(note).toMatch(/next message|next turn/);
    expect(note).toContain('do not try to invoke');
  });
});

describe('clarifying-questions note', () => {
  it('steers the model to ask the user directly in chat and wait', () => {
    const note = clarifyingQuestionsNote().toLowerCase();
    // The load-bearing behavior now that AskUserQuestion is disabled: ask in
    // the reply itself, then stop and wait for the user's answer.
    expect(note).toContain('ask');
    expect(note).toMatch(/in your reply|in chat|directly/);
    expect(note).toMatch(/wait for (their|the user'?s) answer|wait for them/);
    // No separate question/menu tool exists — the model must use plain chat.
    expect(note).toMatch(/no (separate )?(question|menu).*tool|chat itself/);
  });
});

describe('ephemeral scratch note', () => {
  it('interpolates the actual root path into the scratch note (subprocess tempdir)', () => {
    const root = '/var/folders/xx/ax-ipc-abc123/ephemeral';
    const note = ephemeralScratchNote(root);
    expect(note).toContain(`\`${root}\``);
    expect(note.toLowerCase()).toContain('discarded');
    expect(note.toLowerCase()).toContain('scratch');
  });
});

describe('operationalNotes — the single assembly point', () => {
  it('always includes the workspace + handoff + skill-authoring + clarifying-questions notes (workspace root is always known)', () => {
    const notes = operationalNotes(WS, undefined);
    expect(notes).toContain(workspaceNote(WS));
    expect(notes).toContain(capabilityHandoffNote());
    expect(notes).toContain(skillAuthoringNote());
    expect(notes).toContain(clarifyingQuestionsNote());
    // No scratch / venv notes when the sandbox provides neither.
    expect(notes).not.toContain(ephemeralScratchNote('/ephemeral'));
    expect(notes).not.toContain(pythonVenvNote());
  });

  it('includes the ephemeral-scratch note when a scratch tier is provided', () => {
    const notes = operationalNotes(WS, '/ephemeral');
    expect(notes).toContain(ephemeralScratchNote('/ephemeral'));
    expect(notes).toContain(workspaceNote(WS));
  });

  it('includes the python-venv note only when the venv is active', () => {
    expect(operationalNotes(WS, '/ephemeral', false)).not.toContain(pythonVenvNote());
    const withVenv = operationalNotes(WS, '/ephemeral', true);
    expect(withVenv).toContain(pythonVenvNote());
    expect(withVenv).toContain(ephemeralScratchNote('/ephemeral'));
  });

  it('can emit the python-venv note even without an ephemeral scratch tier', () => {
    const notes = operationalNotes(WS, undefined, true);
    expect(notes).toContain(pythonVenvNote());
    expect(notes).toContain(workspaceNote(WS));
    expect(notes).not.toContain(ephemeralScratchNote('/ephemeral'));
  });

  it('defaults pythonVenvActive to false (2-arg call)', () => {
    expect(operationalNotes(WS, '/ephemeral')).not.toContain(pythonVenvNote());
  });

  it('orders workspace → scratch → venv → handoff → skill-authoring → clarifying-questions', () => {
    const notes = operationalNotes(WS, '/ephemeral', true);
    const iWs = notes.indexOf(workspaceNote(WS));
    const iScratch = notes.indexOf(ephemeralScratchNote('/ephemeral'));
    const iVenv = notes.indexOf(pythonVenvNote());
    const iHandoff = notes.indexOf(capabilityHandoffNote());
    const iSkill = notes.indexOf(skillAuthoringNote());
    const iClarify = notes.indexOf(clarifyingQuestionsNote());
    expect(iWs).toBeLessThan(iScratch);
    expect(iScratch).toBeLessThan(iVenv);
    expect(iVenv).toBeLessThan(iHandoff);
    expect(iHandoff).toBeLessThan(iSkill);
    expect(iSkill).toBeLessThan(iClarify);
  });
});
