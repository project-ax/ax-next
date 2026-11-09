/**
 * TASK-1101 — test helpers for the MCP directory client. Not a test file
 * (vitest only runs `*.test.{ts,tsx}`); tests across channel-web import it.
 *
 * The default listing is well formed, domain-proven and declares no key. It
 * has NO `keyHeader` and NO `deprecated`: under `exactOptionalPropertyTypes`
 * an override can add an optional field but can't set one to `undefined`, so
 * tests add them rather than remove them. A key listing is
 * `directoryEntry({ auth: 'key', keyHeader: 'X-API-Key' })`.
 */
import type { DirectoryEntry, DirectoryPage } from '../connector-directory';

export function directoryEntry(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
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

/** A synced page with no rows, last synced 12 minutes ago. */
export function directoryPage(overrides: Partial<DirectoryPage> = {}): DirectoryPage {
  return {
    enabled: true,
    entries: [],
    syncedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    stale: false,
    verifiedOnly: false,
    ...overrides,
  };
}
