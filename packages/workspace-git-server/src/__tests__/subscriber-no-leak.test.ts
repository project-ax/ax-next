// Phase 2 boundary review: no oid (40-char hex SHA-1) may escape into a
// subscriber-visible payload beyond the opaque `before`/`after`
// `WorkspaceVersion` tokens. Subscribers treat versions as opaque strings
// they pass back to workspace hooks. A leak — say, a path field with an
// embedded oid, or a backend-specific `sha` field — would let a subscriber
// key off a git-shaped detail and break the day we swap in a non-git
// storage backend (Invariant 1: hook surface is transport- and storage-
// agnostic).
//
// What we pin here:
//
//   1. `JSON.stringify(delta)` with a parent contains AT MOST 2 forty-char
//      hex matches, and they appear ONLY at JSON keys named `before` and
//      `after`. (Lazy `contentBefore`/`contentAfter` fetchers are
//      functions — JSON.stringify drops them, which is fine: subscribers
//      that care about content reach for those fetchers explicitly, the
//      bytes themselves never round-trip through the JSON path.)
//
//   2. The initial-apply case (parent: null) has `delta.before === null`
//      and at most ONE 40-hex match (the `after`).
//
// Why JSON.stringify + grep + JSON.parse + walk: it's the same lens an
// operator's logger or a downstream subscriber's serializer would use.
// If we manually walk WorkspaceDelta's typed fields, we miss leaks added
// later (e.g., a future `metadata: Record<string, unknown>` field that
// inadvertently carries an oid). The string match catches anything that
// could survive a JSON round-trip.
//
// What we deliberately do NOT pin: the lazy `contentBefore`/`contentAfter`
// fetchers' BODIES. They're closures over commit oids by necessity (the
// engine reads `git cat-file blob <oid>:<path>`) and that's an internal
// implementation detail subscribers can't see — only the bytes the
// fetchers RETURN are visible to subscribers, and bytes are bytes.

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestHarness,
  type TestHarness,
} from '@ax/test-harness';
import type {
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
} from '@ax/core';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '../server/index.js';
import { createWorkspaceGitServerPlugin } from '../client/plugin.js';

const TOKEN = 'secret';
const HEX40 = /\b[a-f0-9]{40}\b/g;

interface Booted {
  server: WorkspaceGitServer;
  baseUrl: string;
  repoRoot: string;
  cacheRoot: string;
}

const booted: Booted[] = [];
let harness: TestHarness | null = null;

async function boot(): Promise<Booted> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-no-leak-repos-'));
  const cacheRoot = mkdtempSync(join(tmpdir(), 'ax-no-leak-cache-'));
  const server = await createWorkspaceGitServer({
    repoRoot,
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
  });
  const b: Booted = {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
    repoRoot,
    cacheRoot,
  };
  booted.push(b);
  return b;
}

afterEach(async () => {
  if (harness !== null) {
    await harness.close();
    harness = null;
  }
  await Promise.allSettled(booted.map((b) => b.server.close()));
  await Promise.allSettled(
    booted.flatMap((b) => [
      rm(b.repoRoot, { recursive: true, force: true }),
      rm(b.cacheRoot, { recursive: true, force: true }),
    ]),
  );
  booted.length = 0;
});

/**
 * Walk a parsed JSON value. For every string descendant, invoke `visit`
 * with the parent key (or `null` for top-level / array elements) and the
 * string value. Used to assert that 40-char hex strings only show up at
 * keys we expect.
 */
function walkStrings(
  value: unknown,
  visit: (key: string | null, value: string) => void,
  parentKey: string | null = null,
): void {
  if (typeof value === 'string') {
    visit(parentKey, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkStrings(item, visit, null);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      walkStrings(v, visit, k);
    }
  }
}

describe('subscriber-no-leak boundary', () => {
  it('initial apply (parent: null) emits at most one 40-hex string and only at delta.after', async () => {
    const b = await boot();
    harness = await createTestHarness({
      plugins: [
        createWorkspaceGitServerPlugin({
          baseUrl: b.baseUrl,
          token: TOKEN,
          cacheRoot: b.cacheRoot,
          // Fixed id so the workspaceId itself can't accidentally collide
          // with a 40-hex string.
          workspaceIdFor: () => 'ws-no-leak-initial',
        }),
      ],
    });

    const r = await harness.bus.call<
      WorkspaceApplyInput,
      WorkspaceApplyOutput
    >('workspace:apply', harness.ctx(), {
      changes: [
        {
          path: 'README.md',
          kind: 'put',
          content: new TextEncoder().encode('hello'),
        },
      ],
      parent: null,
    });

    expect(r.delta.before).toBeNull();

    const json = JSON.stringify(r.delta);
    const matches = json.match(HEX40) ?? [];
    expect(matches.length).toBeLessThanOrEqual(1);

    // The single hex match (if any) must equal the `after` token.
    if (matches.length === 1) {
      expect(matches[0]).toBe(r.delta.after);
    }

    // Walk the parsed structure: every 40-hex string must be the value at
    // an `after` key. (No `before` here; it's null.)
    const parsed = JSON.parse(json) as unknown;
    const offendingPaths: { key: string | null; value: string }[] = [];
    walkStrings(parsed, (key, val) => {
      if (HEX40.test(val)) {
        // Reset lastIndex on the global regex so the next test() doesn't
        // skip; cheaper than building a non-global regex per call.
        HEX40.lastIndex = 0;
        if (key !== 'after') {
          offendingPaths.push({ key, value: val });
        }
      }
    });
    expect(offendingPaths).toEqual([]);
  });

  it('second apply (parent: v1) emits at most two 40-hex strings, only at delta.before and delta.after', async () => {
    const b = await boot();
    harness = await createTestHarness({
      plugins: [
        createWorkspaceGitServerPlugin({
          baseUrl: b.baseUrl,
          token: TOKEN,
          cacheRoot: b.cacheRoot,
          workspaceIdFor: () => 'ws-no-leak-second',
        }),
      ],
    });

    const enc = new TextEncoder();
    const v1 = await harness.bus.call<
      WorkspaceApplyInput,
      WorkspaceApplyOutput
    >('workspace:apply', harness.ctx(), {
      changes: [
        { path: 'README.md', kind: 'put', content: enc.encode('hello') },
      ],
      parent: null,
    });

    const r = await harness.bus.call<
      WorkspaceApplyInput,
      WorkspaceApplyOutput
    >('workspace:apply', harness.ctx(), {
      changes: [
        { path: 'README.md', kind: 'put', content: enc.encode('world') },
      ],
      parent: v1.version,
    });

    expect(r.delta.before).toBe(v1.version);
    expect(r.delta.after).toBe(r.version);

    const json = JSON.stringify(r.delta);
    const matches = json.match(HEX40) ?? [];
    expect(matches.length).toBeLessThanOrEqual(2);

    // Both matches must be either the `before` or the `after` token.
    const allowed = new Set<string>([r.delta.before!, r.delta.after]);
    for (const m of matches) {
      expect(allowed.has(m)).toBe(true);
    }

    // Walk the parsed structure. Every 40-hex string must be at `before` or
    // `after` keys.
    const parsed = JSON.parse(json) as unknown;
    const offendingPaths: { key: string | null; value: string }[] = [];
    walkStrings(parsed, (key, val) => {
      // Build a fresh non-global regex per call to avoid stateful lastIndex.
      if (/^[a-f0-9]{40}$/.test(val)) {
        if (key !== 'before' && key !== 'after') {
          offendingPaths.push({ key, value: val });
        }
      }
    });
    expect(offendingPaths).toEqual([]);
  });

  it('apply with a path that itself looks like a 40-hex string still surfaces no extra leak (path is intentional, not a leak)', async () => {
    // Belt-and-suspenders: a subscriber walking the JSON might see the path
    // string "0123...abcdef" and worry it's a leaked oid. It's not — paths
    // are caller-supplied and intentional. We pin that the only hex strings
    // outside `before`/`after` are ones the CALLER put there via input.
    const b = await boot();
    harness = await createTestHarness({
      plugins: [
        createWorkspaceGitServerPlugin({
          baseUrl: b.baseUrl,
          token: TOKEN,
          cacheRoot: b.cacheRoot,
          workspaceIdFor: () => 'ws-no-leak-hexpath',
        }),
      ],
    });

    const hexPath = 'a'.repeat(40); // 40-char hex; technically valid path
    const r = await harness.bus.call<
      WorkspaceApplyInput,
      WorkspaceApplyOutput
    >('workspace:apply', harness.ctx(), {
      changes: [
        { path: hexPath, kind: 'put', content: new TextEncoder().encode('x') },
      ],
      parent: null,
    });

    const json = JSON.stringify(r.delta);
    const parsed = JSON.parse(json) as unknown;

    // Walk; collect every 40-hex match with its key.
    const matches: { key: string | null; value: string }[] = [];
    walkStrings(parsed, (key, val) => {
      if (/^[a-f0-9]{40}$/.test(val)) {
        matches.push({ key, value: val });
      }
    });

    // Allowed shapes: `after` (the version), and `path` (caller-supplied).
    // Every other key would be a leak.
    for (const m of matches) {
      expect(['after', 'before', 'path']).toContain(m.key);
    }

    // And specifically: the `path` match equals `hexPath`, the `after`
    // match equals `r.delta.after`. (`before` is null on initial apply.)
    const pathMatches = matches.filter((m) => m.key === 'path');
    expect(pathMatches.map((m) => m.value)).toEqual([hexPath]);
    const afterMatches = matches.filter((m) => m.key === 'after');
    expect(afterMatches.map((m) => m.value)).toEqual([r.delta.after]);
  });
});
