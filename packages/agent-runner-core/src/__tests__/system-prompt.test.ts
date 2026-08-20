import { describe, expect, it } from 'vitest';
import {
  capabilityHandoffNote,
  clarifyingQuestionsNote,
  communicationNote,
  ephemeralScratchNote,
  operationalNotes,
  pythonVenvNote,
  skillAuthoringNote,
  userFilesNote,
  workPolicyNote,
  workspaceNote,
} from '../system-prompt.js';

const WS = '/agent';

/** Collapse the hard-wrapped prose to one line so phrase assertions don't turn
 * into line-wrap assertions — where a bullet wraps is not behavior. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('workspaceNote', () => {
  it('names the workspace root and steers attachment paths away from home dirs', () => {
    const note = workspaceNote(WS);
    expect(note).toContain('`/agent`');
    expect(note).toContain('.ax/uploads');
    // The load-bearing instruction: resolve workspace-relative paths under the
    // workspace root, NOT a home directory (the bug this note prevents).
    expect(note).toMatch(/home directory|\/home|~/);
  });

  it('keeps the single-root prose when cwd equals the workspace root', () => {
    // Default cwd === workspaceRoot: byte-identical to the no-cwd form (today).
    expect(workspaceNote(WS, WS)).toBe(workspaceNote(WS));
  });

  it('states BOTH the cwd and the governed root when they differ (Plan 2)', () => {
    // TASK-164: cwd moved to /workspace; attachments still live under /agent.
    const note = workspaceNote('/agent', '/workspace');
    expect(note).toContain('`/workspace`'); // the working directory
    expect(note).toContain('`/agent`'); // the governed root attachments live under
    expect(note).toContain('.ax/uploads');
    // It must resolve a shared file under the GOVERNED root, not the cwd.
    expect(note).toContain('`/agent/.ax/uploads/…`');
    // And still steer away from home dirs.
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

describe('skill-authoring note (TASK-74 §D6; TASK-165 dynamic prefix)', () => {
  it('states proposed skills are available next turn and not invokable now', () => {
    const note = skillAuthoringNote().toLowerCase();
    expect(note).toContain('skill_propose');
    expect(note).toMatch(/next message|next turn/);
    expect(note).toContain('do not try to invoke');
  });

  it('interpolates the durable draft root into the draft-dir path (TASK-165)', () => {
    const note = skillAuthoringNote('/workspace');
    expect(note).toContain('/workspace/.skill-draft/<id>/');
    // Must NOT bake in the ephemeral root when a durable mount is the active root.
    expect(note).not.toContain('/ephemeral/.skill-draft');
  });

  it('interpolates the ephemeral root when that is the active draft root', () => {
    const note = skillAuthoringNote('/ephemeral');
    expect(note).toContain('/ephemeral/.skill-draft/<id>/');
  });

  it('falls back to a generic .skill-draft/<id>/ phrasing when no tier is wired', () => {
    const note = skillAuthoringNote(undefined);
    expect(note).toContain('.skill-draft/<id>/');
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

describe('user-files note (filestore-user-files Phase 1)', () => {
  it('interpolates the durable root and frames it as persistent, unversioned storage', () => {
    const note = userFilesNote('/workspace');
    expect(note).toContain('/workspace');
    expect(note).toMatch(/persist|durable/i);
    // Phase 1 steers the agent to use it BY PATH (cwd/HOME aren't re-rooted yet).
    expect(note).toContain('/workspace/…');
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

  it('includes the user-files note when a durable mount is provided (filestore Phase 1)', () => {
    const notes = operationalNotes(WS, undefined, false, '/workspace');
    expect(notes).toContain(userFilesNote('/workspace'));
    expect(notes).toContain(workspaceNote(WS));
  });

  it('omits the user-files note when no durable mount is wired', () => {
    const notes = operationalNotes(WS, '/ephemeral', false, undefined);
    expect(notes).not.toContain(userFilesNote('/workspace'));
  });

  it('routes the skill-authoring draft prefix to userFilesRoot ?? ephemeralRoot (TASK-165)', () => {
    // Durable mount wired: drafts advertised under /workspace.
    const durable = operationalNotes(WS, '/ephemeral', false, '/workspace');
    expect(durable).toContain(skillAuthoringNote('/workspace'));
    expect(durable).not.toContain(skillAuthoringNote('/ephemeral'));
    // No durable mount: drafts advertised under the ephemeral scratch tier.
    const fallback = operationalNotes(WS, '/ephemeral', false, undefined);
    expect(fallback).toContain(skillAuthoringNote('/ephemeral'));
  });

  it('threads cwd into the workspace note (Plan 2 — cwd=/workspace)', () => {
    // TASK-164: when cwd differs from the governed root, the assembled notes use
    // the dual-root workspace prose (working dir + governed root).
    const notes = operationalNotes('/agent', '/ephemeral', false, '/workspace', '/workspace');
    expect(notes).toContain(workspaceNote('/agent', '/workspace'));
    // The single-root form is NOT present (cwd != workspaceRoot).
    expect(notes).not.toContain(workspaceNote('/agent', '/agent'));
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
    // The active draft root here is `undefined ?? '/ephemeral'` = '/ephemeral'.
    const iSkill = notes.indexOf(skillAuthoringNote('/ephemeral'));
    const iClarify = notes.indexOf(clarifyingQuestionsNote());
    expect(iWs).toBeLessThan(iScratch);
    expect(iScratch).toBeLessThan(iVenv);
    expect(iVenv).toBeLessThan(iHandoff);
    expect(iHandoff).toBeLessThan(iSkill);
    expect(iSkill).toBeLessThan(iClarify);
  });
});

describe('workPolicyNote (default operating behavior)', () => {
  it('requires evidence before claiming work is done, fixed, or tested', () => {
    // The single most load-bearing line: a model with no harness training will
    // otherwise report success it never observed.
    const note = flat(workPolicyNote());
    expect(note).toMatch(/done, fixed, tested/i);
    expect(note).toMatch(/tool output/i);
  });

  it('separates action requests from questions, so a question does not trigger edits', () => {
    expect(flat(workPolicyNote())).toMatch(/unsolicited/i);
  });

  it('holds requirements open until done, superseded, or blocked — never silently dropped', () => {
    const note = flat(workPolicyNote());
    expect(note).toMatch(/blocked/i);
    expect(note).toMatch(/quietly dropping|silently dropping/i);
  });

  it('steers file work to the dedicated tools and off shell equivalents', () => {
    const note = flat(workPolicyNote());
    expect(note).toContain('`Read`');
    expect(note).toContain('`Edit`');
    expect(note).toContain('`Bash`');
    expect(note).toMatch(/cat|sed/);
    // Never narrate to the user through the shell.
    expect(note).toMatch(/echo/);
  });

  it('names AGENTS.md as the override layer and the floor as non-overridable', () => {
    const note = flat(workPolicyNote());
    expect(note).toContain('.ax/AGENTS.md');
    expect(note).toMatch(/floor/i);
  });

  it('stays bounded — a policy block, not a wall of rules', () => {
    // Same intent as the safety-floor length guard: everything endlessly
    // customizable belongs in AGENTS.md, not in runner-authored prose.
    expect(workPolicyNote().length).toBeLessThan(2000);
  });
});

describe('communicationNote (default reply style)', () => {
  it('writes for a reader who has not seen the tool calls', () => {
    const note = flat(communicationNote());
    expect(note).toMatch(/has not seen|hasn't seen/i);
    expect(note).toMatch(/tool calls/i);
  });

  it('leads with the answer and does not bounce a clarifying question back when answerable', () => {
    const note = flat(communicationNote());
    expect(note).toMatch(/lead with the answer/i);
    expect(note).toMatch(/clarifying question/i);
  });

  it('requires the final message to stand alone', () => {
    expect(flat(communicationNote())).toMatch(/stand alone/i);
  });

  it('states the GitHub-flavored markdown rendering contract and the nested-fence rule', () => {
    const note = flat(communicationNote());
    expect(note).toMatch(/markdown/i);
    expect(note).toMatch(/fence/i);
  });

  it('does NOT flatten agent personality', () => {
    // Deliberate divergence from the upstream prompt: its "never coin
    // acronyms / state facts literally / no metaphors" clauses would fight
    // the agent-authored SOUL.md that gives an agent its voice. Style is the
    // agent's; structure is ours.
    const note = flat(communicationNote()).toLowerCase();
    expect(note).not.toContain('metaphor');
    expect(note).not.toContain('acronym');
  });

  it('names AGENTS.md as the override layer', () => {
    expect(flat(communicationNote())).toContain('.ax/AGENTS.md');
  });

  it('stays bounded', () => {
    expect(communicationNote().length).toBeLessThan(2000);
  });
});
