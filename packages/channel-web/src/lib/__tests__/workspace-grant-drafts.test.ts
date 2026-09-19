/**
 * The grant draft store (TASK-389) — the primitive `GrantRow` reads/writes to
 * survive unmounting. See the module doc for why this exists and isn't a
 * second copy of the grant.
 */
import { afterEach, describe, expect, test } from 'vitest';
import {
  clearGrantDraft,
  getGrantDraft,
  resetGrantDraftsForTest,
  setGrantDraftValue,
} from '../workspace-grant-drafts';

afterEach(() => {
  resetGrantDraftsForTest();
});

describe('workspace-grant-drafts', () => {
  test('an unknown key has no draft', () => {
    expect(getGrantDraft('skill:linear-issues')).toEqual({});
  });

  test('a set value round-trips', () => {
    setGrantDraftValue('skill:linear-issues', 'api_key', 'lin_123');
    expect(getGrantDraft('skill:linear-issues')).toEqual({ api_key: 'lin_123' });
  });

  test('setting a second slot keeps the first', () => {
    setGrantDraftValue('connector:linear', 'client_id', 'abc');
    setGrantDraftValue('connector:linear', 'client_secret', 'xyz');
    expect(getGrantDraft('connector:linear')).toEqual({
      client_id: 'abc',
      client_secret: 'xyz',
    });
  });

  test('overwriting a slot replaces only that slot', () => {
    setGrantDraftValue('skill:linear-issues', 'api_key', 'lin_1');
    setGrantDraftValue('skill:linear-issues', 'api_key', 'lin_12');
    expect(getGrantDraft('skill:linear-issues')).toEqual({ api_key: 'lin_12' });
  });

  test('drafts are isolated per key', () => {
    setGrantDraftValue('skill:linear-issues', 'api_key', 'lin_1');
    setGrantDraftValue('skill:other', 'api_key', 'oth_1');
    expect(getGrantDraft('skill:linear-issues')).toEqual({ api_key: 'lin_1' });
    expect(getGrantDraft('skill:other')).toEqual({ api_key: 'oth_1' });
  });

  test('clearing a draft removes it, and only it', () => {
    setGrantDraftValue('skill:linear-issues', 'api_key', 'lin_1');
    setGrantDraftValue('skill:other', 'api_key', 'oth_1');

    clearGrantDraft('skill:linear-issues');

    expect(getGrantDraft('skill:linear-issues')).toEqual({});
    expect(getGrantDraft('skill:other')).toEqual({ api_key: 'oth_1' });
  });

  test('clearing an already-empty key is a no-op, not a throw', () => {
    expect(() => clearGrantDraft('never-set')).not.toThrow();
  });
});
