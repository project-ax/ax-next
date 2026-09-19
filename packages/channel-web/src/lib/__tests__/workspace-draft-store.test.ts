/**
 * The composer draft store (TASK-393) — the primitive `AgentConversation`
 * reads/writes to survive an agent switch remounting it. See the module doc
 * for why this exists and isn't a second copy of anything.
 */
import { afterEach, describe, expect, test } from 'vitest';
import {
  clearDraft,
  getDraft,
  resetDraftsForTest,
  setDraft,
} from '../workspace-draft-store';

afterEach(() => {
  resetDraftsForTest();
});

describe('workspace-draft-store', () => {
  test('an unknown agent has no draft', () => {
    expect(getDraft('a-quill')).toBe('');
  });

  test('a set value round-trips', () => {
    setDraft('a-quill', 'hello there');
    expect(getDraft('a-quill')).toBe('hello there');
  });

  test('drafts are isolated per agent', () => {
    setDraft('a-quill', 'for quill');
    setDraft('a-tern', 'for tern');
    expect(getDraft('a-quill')).toBe('for quill');
    expect(getDraft('a-tern')).toBe('for tern');
  });

  test('setting an empty string clears the draft rather than storing it', () => {
    setDraft('a-quill', 'partial');
    setDraft('a-quill', '');
    expect(getDraft('a-quill')).toBe('');
  });

  test('clearing a draft removes it, and only it', () => {
    setDraft('a-quill', 'for quill');
    setDraft('a-tern', 'for tern');

    clearDraft('a-quill');

    expect(getDraft('a-quill')).toBe('');
    expect(getDraft('a-tern')).toBe('for tern');
  });

  test('clearing an already-empty agent is a no-op, not a throw', () => {
    expect(() => clearDraft('never-typed')).not.toThrow();
  });
});
