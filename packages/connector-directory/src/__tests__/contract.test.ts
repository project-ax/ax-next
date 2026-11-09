import { describe, expect, it } from 'vitest';
import {
  CURSOR_MAX,
  DIRECTORY_SEARCH_HOOK,
  DirectoryEntrySchema,
  DirectorySearchInputSchema,
  DirectorySearchOutputSchema,
  DIRECTORY_PROVENANCE_MARK_EDITED_HOOK,
  DIRECTORY_PROVENANCE_RECORD_HOOK,
  ProvenanceMarkEditedInputSchema,
  ProvenanceMarkEditedOutputSchema,
  ProvenanceRecordInputSchema,
  ProvenanceRecordOutputSchema,
  QUERY_MAX,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
} from '../index.js';

describe('connector-directory contract', () => {
  it('the hook is connectors:directory-search', () => {
    expect(DIRECTORY_SEARCH_HOOK).toBe('connectors:directory-search');
  });

  it('payload field names are exactly the contract, with no registry vocabulary', () => {
    const input = Object.keys(DirectorySearchInputSchema.shape).sort();
    const output = Object.keys(DirectorySearchOutputSchema.shape).sort();
    const entry = Object.keys(DirectoryEntrySchema.shape).sort();
    expect(input).toEqual(['cursor', 'limit', 'query']);
    expect(output).toEqual([
      'enabled',
      'entries',
      'nextCursor',
      'stale',
      'syncedAt',
      'verifiedOnly',
    ]);
    expect(entry).toEqual([
      'auth',
      'deprecated',
      'description',
      'id',
      'keyHeader',
      'publisher',
      'publisherProof',
      'title',
      'updatedAt',
      'url',
      'version',
    ]);
    for (const key of [...input, ...output, ...entry]) {
      expect(key).not.toMatch(/remote|package|_meta|github|latest/i);
    }
  });

  it('the provenance hooks and their field names are exactly the contract (TASK-1102)', () => {
    expect(DIRECTORY_PROVENANCE_RECORD_HOOK).toBe('connectors:directory-provenance-record');
    expect(DIRECTORY_PROVENANCE_MARK_EDITED_HOOK).toBe('connectors:directory-provenance-mark-edited');
    const recordIn = Object.keys(ProvenanceRecordInputSchema.shape).sort();
    const recordOut = Object.keys(ProvenanceRecordOutputSchema.shape).sort();
    const markIn = Object.keys(ProvenanceMarkEditedInputSchema.shape).sort();
    const markOut = Object.keys(ProvenanceMarkEditedOutputSchema.shape).sort();
    expect(recordIn).toEqual(['connectorId', 'directoryId', 'serverUrl', 'version']);
    expect(recordOut).toEqual(['recorded']);
    expect(markIn).toEqual(['connectorId']);
    expect(markOut).toEqual(['marked']);
    for (const key of [...recordIn, ...recordOut, ...markIn, ...markOut]) {
      expect(key).not.toMatch(/remote|package|_meta|github|latest/i);
    }
  });

  it('input is strict and bounded', () => {
    const S = DirectorySearchInputSchema;
    expect(S.safeParse({ query: 'x', extra: 1 }).success).toBe(false);
    expect(S.safeParse({ query: 'x'.repeat(QUERY_MAX + 1) }).success).toBe(false);
    expect(S.safeParse({ query: 'x', limit: 2.5 }).success).toBe(false);
    expect(S.safeParse({ query: 'x', cursor: 'c'.repeat(CURSOR_MAX + 1) }).success).toBe(false);
    expect(S.safeParse({ query: '' }).success).toBe(true);
    // Clamping is search's job, not the schema's.
    expect(S.safeParse({ query: 'a', limit: 500, cursor: 'abc' }).success).toBe(true);
  });

  it('entry enums are closed', () => {
    const base = {
      id: 'a.b/c',
      title: 't',
      description: 'd',
      publisher: 'b.a',
      publisherProof: 'domain',
      url: 'https://example.com/mcp',
      auth: 'none',
      version: '1.0.0',
      updatedAt: '2026-11-09T00:00:00.000Z',
    };
    expect(DirectoryEntrySchema.safeParse(base).success).toBe(true);
    expect(DirectoryEntrySchema.safeParse({ ...base, auth: 'oauth' }).success).toBe(false);
    expect(DirectoryEntrySchema.safeParse({ ...base, publisherProof: 'github' }).success).toBe(
      false,
    );
  });

  it('search limits are pinned', () => {
    expect({ SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, QUERY_MAX, CURSOR_MAX }).toEqual({
      SEARCH_LIMIT_DEFAULT: 20,
      SEARCH_LIMIT_MAX: 50,
      QUERY_MAX: 200,
      CURSOR_MAX: 64,
    });
  });
});
