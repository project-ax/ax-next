import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_CURSOR_RE as SERVER_CURSOR_RE,
  DIRECTORY_QUERY_MAX as SERVER_QUERY_MAX,
  shapeDirectoryBody,
  type DirectoryEntryLike,
} from '@ax/connectors';
import {
  DIRECTORY_CURSOR_RE as CLIENT_CURSOR_RE,
  DIRECTORY_QUERY_MAX as CLIENT_QUERY_MAX,
  normalizeDirectoryPage,
} from '../lib/connector-directory';

// ---------------------------------------------------------------------------
// TASK-1101 contract: the admin directory client (lib/connector-directory.ts)
// mirrors the route's query cap, cursor rule and body field names
// (@ax/connectors directory-route.ts) instead of importing them.
//
// WHY IT LIVES HERE. Invariant 2 keeps channel-web from importing @ax/connectors
// at runtime, so the client runs a copy. This file (test-only, which the
// no-restricted-imports block exempts) is the only thing that compares them,
// as connector-retarget-contract.test.ts does for the retarget rule.
//
// THE INPUT IS WHAT THE ROUTE SENDS. Every body goes through the server's own
// `shapeDirectoryBody`, so a renamed or dropped field on either side shows up
// as a listing the client silently loses or changes.
// ---------------------------------------------------------------------------

function entry(overrides: Partial<DirectoryEntryLike> = {}): DirectoryEntryLike {
  return {
    id: 'app.linear/linear',
    title: 'Linear',
    description: 'Find, create and update Linear issues.',
    publisher: 'linear.app',
    publisherProof: 'domain',
    url: 'https://mcp.linear.app/mcp',
    auth: 'none',
    version: '1.4.0',
    updatedAt: '2026-11-03T12:00:00.000Z',
    ...overrides,
  };
}

describe('directory route contract', () => {
  it('the client caps the query where the route does', () => {
    expect(CLIENT_QUERY_MAX).toBe(SERVER_QUERY_MAX);
  });

  it('the client accepts the cursors the route issues, and only those', () => {
    expect(CLIENT_CURSOR_RE.source).toBe(SERVER_CURSOR_RE.source);
    expect(CLIENT_CURSOR_RE.flags).toBe(SERVER_CURSOR_RE.flags);
  });

  it('a body the route shapes reaches the client unchanged', () => {
    const body = shapeDirectoryBody({
      enabled: true,
      entries: [
        entry({ auth: 'key', keyHeader: 'X-API-Key' }),
        entry({
          id: 'io.github.quickmcp/notes',
          title: 'Quick Notes',
          publisher: 'quickmcp',
          publisherProof: 'account',
          url: 'https://notes.quickmcp.dev/mcp',
          auth: 'signin',
          deprecated: true,
        }),
        entry({ id: 'com.example/docs', title: 'Docs', url: 'https://docs.example.com/mcp' }),
      ],
      syncedAt: '2026-11-09T10:00:00.000Z',
      stale: true,
      verifiedOnly: true,
      nextCursor: 'eyJvIjoyMH0',
    });
    expect(normalizeDirectoryPage(body)).toStrictEqual(body);
  });

  it('the turned-off body, with no cursor, reaches the client unchanged', () => {
    const off = shapeDirectoryBody({
      enabled: false,
      entries: [],
      syncedAt: null,
      stale: false,
      verifiedOnly: false,
    });
    expect(normalizeDirectoryPage(off)).toStrictEqual(off);
  });
});
