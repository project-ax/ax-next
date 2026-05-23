import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  ephemeralScratchNote,
  pythonVenvNote,
} from '../system-prompt.js';

describe('buildSystemPrompt', () => {
  describe('without an ephemeral root', () => {
    it('passes a custom string prompt through verbatim', () => {
      expect(buildSystemPrompt('You are a helpful agent.', undefined)).toBe(
        'You are a helpful agent.',
      );
    });

    it('falls back to the claude_code preset with no append for an empty prompt', () => {
      expect(buildSystemPrompt('', undefined)).toEqual({
        type: 'preset',
        preset: 'claude_code',
      });
    });
  });

  describe('with an ephemeral root', () => {
    it('concatenates the scratch note onto a custom string prompt', () => {
      // The SDK preset `append` is a no-op on a string systemPrompt, so the
      // helper must concatenate the note itself.
      const result = buildSystemPrompt('Custom prompt.', '/ephemeral');
      expect(typeof result).toBe('string');
      const text = result as string;
      expect(text.startsWith('Custom prompt.\n\n')).toBe(true);
      expect(text).toContain('`/ephemeral`');
      expect(text).toContain(ephemeralScratchNote('/ephemeral'));
    });

    it('uses the preset append for an empty prompt', () => {
      const result = buildSystemPrompt('', '/tmp/ax-scratch');
      expect(result).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: ephemeralScratchNote('/tmp/ax-scratch'),
      });
    });

    it('interpolates the actual root path into the note (subprocess tempdir)', () => {
      // Subprocess provides a per-session tempdir, not the fixed /ephemeral.
      const root = '/var/folders/xx/ax-ipc-abc123/ephemeral';
      const note = ephemeralScratchNote(root);
      expect(note).toContain(`\`${root}\``);
      // The note tells the agent the dir is throwaway, distinct from cwd.
      expect(note.toLowerCase()).toContain('discarded');
      expect(note.toLowerCase()).toContain('scratch');
    });
  });

  describe('python venv note', () => {
    it('omits the python note when the venv is not active', () => {
      const result = buildSystemPrompt('Custom prompt.', '/ephemeral', false);
      const text = typeof result === 'string' ? result : (result.append ?? '');
      expect(text).not.toContain(pythonVenvNote());
    });

    it('appends the python note onto a custom string prompt when active', () => {
      const result = buildSystemPrompt('Custom prompt.', '/ephemeral', true);
      expect(typeof result).toBe('string');
      const text = result as string;
      expect(text).toContain(pythonVenvNote());
      // Both notes coexist — scratch + venv.
      expect(text).toContain(ephemeralScratchNote('/ephemeral'));
    });

    it('uses the preset append for an empty prompt when active', () => {
      const result = buildSystemPrompt('', '/ephemeral', true);
      expect(typeof result).toBe('object');
      const append = (result as { append?: string }).append ?? '';
      expect(append).toContain(pythonVenvNote());
    });

    it('can emit the python note even without an ephemeral scratch note', () => {
      // venv active but (hypothetically) no scratch root → only the python note.
      const result = buildSystemPrompt('Custom.', undefined, true);
      const text = result as string;
      expect(text).toContain(pythonVenvNote());
    });

    it('defaults pythonVenvActive to false (back-compat 2-arg call)', () => {
      const result = buildSystemPrompt('Custom.', '/ephemeral');
      const text = result as string;
      expect(text).not.toContain(pythonVenvNote());
    });
  });
});
