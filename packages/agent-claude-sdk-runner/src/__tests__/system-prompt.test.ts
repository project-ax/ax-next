import { describe, expect, it } from 'vitest';
import {
  buildFallbackPrompt,
  capabilityHandoffNote,
  ephemeralScratchNote,
  pythonVenvNote,
  skillAuthoringNote,
  workspaceNote,
} from '../system-prompt.js';

const WS = '/permanent';

describe('workspaceNote', () => {
  it('names the workspace root and steers attachment paths away from home dirs', () => {
    const note = workspaceNote(WS);
    expect(note).toContain('`/permanent`');
    expect(note).toContain('.ax/uploads');
    // The load-bearing instruction: resolve workspace-relative paths under the
    // workspace root, NOT a home directory (the bug this note prevents).
    expect(note).toMatch(/home directory|\/home|~/);
  });
});

describe('buildFallbackPrompt', () => {
  describe('workspace note (always present)', () => {
    it('appends the workspace note onto a custom string prompt', () => {
      const result = buildFallbackPrompt('You are a helpful agent.', WS, undefined);
      expect(typeof result).toBe('string');
      const text = result as string;
      expect(text.startsWith('You are a helpful agent.\n\n')).toBe(true);
      expect(text).toContain(workspaceNote(WS));
    });

    it('uses the preset append carrying the workspace note for an empty prompt', () => {
      expect(buildFallbackPrompt('', WS, undefined)).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: `${workspaceNote(WS)}\n\n${capabilityHandoffNote()}\n\n${skillAuthoringNote()}`,
      });
    });
  });

  describe('with an ephemeral root', () => {
    it('concatenates workspace + scratch notes onto a custom string prompt', () => {
      // The SDK preset `append` is a no-op on a string systemPrompt, so the
      // helper must concatenate the notes itself.
      const result = buildFallbackPrompt('Custom prompt.', WS, '/ephemeral');
      expect(typeof result).toBe('string');
      const text = result as string;
      expect(text.startsWith('Custom prompt.\n\n')).toBe(true);
      expect(text).toContain(workspaceNote(WS));
      expect(text).toContain(ephemeralScratchNote('/ephemeral'));
    });

    it('uses the preset append (workspace + scratch) for an empty prompt', () => {
      const result = buildFallbackPrompt('', WS, '/tmp/ax-scratch');
      expect(result).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: `${workspaceNote(WS)}\n\n${ephemeralScratchNote('/tmp/ax-scratch')}\n\n${capabilityHandoffNote()}\n\n${skillAuthoringNote()}`,
      });
    });

    it('interpolates the actual root path into the scratch note (subprocess tempdir)', () => {
      const root = '/var/folders/xx/ax-ipc-abc123/ephemeral';
      const note = ephemeralScratchNote(root);
      expect(note).toContain(`\`${root}\``);
      expect(note.toLowerCase()).toContain('discarded');
      expect(note.toLowerCase()).toContain('scratch');
    });
  });

  describe('JIT capability-handoff note (always present)', () => {
    it('includes the continue-automatically guidance for an empty prompt', () => {
      const out = buildFallbackPrompt('', WS, undefined);
      const text = typeof out === 'string' ? out : (out.append ?? '');
      expect(text.toLowerCase()).toContain('continue automatically');
    });

    it('appends the handoff note onto a custom string prompt', () => {
      const out = buildFallbackPrompt('You are helpful.', WS, undefined);
      const text = out as string;
      expect(text).toContain(capabilityHandoffNote());
      expect(text.toLowerCase()).toContain('continue automatically');
    });

    it('the note steers away from narrating the handoff or re-asking', () => {
      const note = capabilityHandoffNote().toLowerCase();
      expect(note).toContain('do not narrate');
      expect(note).toContain('re-ask');
    });

    // TASK-56 (design §13): when a needed capability isn't in the catalog yet,
    // the broker has filed an admit request — the agent should narrate
    // "I've asked your admin to add it" (approval-pending), NOT surface an error.
    it('the note narrates cold-start as an admin request, not an error', () => {
      const note = capabilityHandoffNote().toLowerCase();
      expect(note).toContain('asked your admin');
      expect(note).toContain('not an error');
    });

    it('carries the cold-start narration on the empty-prompt preset append', () => {
      const out = buildFallbackPrompt('', WS, undefined);
      const text = typeof out === 'string' ? out : (out.append ?? '');
      expect(text.toLowerCase()).toContain('asked your admin');
    });
  });

  describe('skill-authoring note (always present, TASK-74 §D6)', () => {
    it('states proposed skills are available next turn and not invokable now', () => {
      const note = skillAuthoringNote().toLowerCase();
      expect(note).toContain('skill_propose');
      expect(note).toMatch(/next message|next turn/);
      expect(note).toContain('do not try to invoke');
    });

    it('is appended to a custom string prompt', () => {
      const out = buildFallbackPrompt('You are helpful.', WS, undefined) as string;
      expect(out).toContain(skillAuthoringNote());
    });

    it('rides the empty-prompt preset append', () => {
      const out = buildFallbackPrompt('', WS, undefined);
      const append = typeof out === 'string' ? out : (out.append ?? '');
      expect(append).toContain(skillAuthoringNote());
    });
  });

  describe('python venv note', () => {
    it('omits the python note when the venv is not active', () => {
      const result = buildFallbackPrompt('Custom prompt.', WS, '/ephemeral', false);
      const text = typeof result === 'string' ? result : (result.append ?? '');
      expect(text).not.toContain(pythonVenvNote());
    });

    it('appends the python note onto a custom string prompt when active', () => {
      const result = buildFallbackPrompt('Custom prompt.', WS, '/ephemeral', true);
      expect(typeof result).toBe('string');
      const text = result as string;
      expect(text).toContain(pythonVenvNote());
      expect(text).toContain(ephemeralScratchNote('/ephemeral'));
      expect(text).toContain(workspaceNote(WS));
    });

    it('uses the preset append for an empty prompt when active', () => {
      const result = buildFallbackPrompt('', WS, '/ephemeral', true);
      expect(typeof result).toBe('object');
      const append = (result as { append?: string }).append ?? '';
      expect(append).toContain(pythonVenvNote());
    });

    it('can emit the python note even without an ephemeral scratch note', () => {
      const result = buildFallbackPrompt('Custom.', WS, undefined, true);
      const text = result as string;
      expect(text).toContain(pythonVenvNote());
      expect(text).toContain(workspaceNote(WS));
    });

    it('defaults pythonVenvActive to false (3-arg call)', () => {
      const result = buildFallbackPrompt('Custom.', WS, '/ephemeral');
      const text = result as string;
      expect(text).not.toContain(pythonVenvNote());
    });
  });
});
