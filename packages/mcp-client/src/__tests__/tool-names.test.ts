// ---------------------------------------------------------------------------
// Tool-name namespacing tests (Task 12).
//
// MCP servers advertise tools with arbitrary names, which may collide with
// each other or with built-in AX tools. We namespace every MCP-sourced tool
// as `mcp.${serverId}.${sanitizedRemoteName}` so the dispatcher's catalog
// stays collision-free, and we preserve a reverse map back to the original
// name so `callTool()` can still address the remote tool correctly.
//
// The dispatcher's TOOL_NAME_RE is `/^[a-z][a-z0-9_.-]{0,63}$/`. Every output
// name must match it. These tests verify:
//   - lowercase pass-through
//   - sanitization of upper-case and disallowed chars
//   - deterministic collision resolution (hash suffix on every colliding entry)
//   - length-cap handling (truncate + hash when total > 64)
//   - description/inputSchema preservation + executesIn:'host'
//   - nameMap round-trip for every descriptor
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildNamespacedName, namespaceTools } from '../tool-names.js';
import type { McpToolDescriptor } from '../connection.js';

// Dispatcher's regex — tests assert every generated name matches this so
// a registration never fails catalog validation.
const TOOL_NAME_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

function shortHash(serverId: string, remoteName: string): string {
  return createHash('sha256').update(`${serverId}:${remoteName}`).digest('hex').slice(0, 6);
}

function tool(name: string, extras: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    name,
    inputSchema: extras.inputSchema ?? { type: 'object', properties: {} },
    ...(extras.description !== undefined ? { description: extras.description } : {}),
  };
}

describe('buildNamespacedName', () => {
  it('produces mcp.<server>.<tool> for clean inputs', () => {
    expect(buildNamespacedName('fs', 'read_file')).toBe('mcp.fs.read_file');
  });

  it('always produces a dispatcher-valid name', () => {
    const name = buildNamespacedName('fs', 'read_file');
    expect(name).toMatch(TOOL_NAME_RE);
  });
});

describe('namespaceTools', () => {
  it('simple lowercase pass-through', () => {
    const { descriptors, nameMap } = namespaceTools('fs', [tool('read_file')]);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]!.name).toBe('mcp.fs.read_file');
    expect(descriptors[0]!.name).toMatch(TOOL_NAME_RE);
    expect(nameMap.get('mcp.fs.read_file')).toBe('read_file');
  });

  it('lowercases mixed-case remote names', () => {
    const { descriptors, nameMap } = namespaceTools('gh', [tool('GetRepo')]);
    expect(descriptors[0]!.name).toBe('mcp.gh.getrepo');
    expect(descriptors[0]!.name).toMatch(TOOL_NAME_RE);
    // nameMap preserves the original casing so callTool() sends GetRepo to
    // the server, not the lowercase version.
    expect(nameMap.get('mcp.gh.getrepo')).toBe('GetRepo');
  });

  it('replaces disallowed characters with underscore', () => {
    const { descriptors, nameMap } = namespaceTools('s', [tool('foo/bar baz')]);
    expect(descriptors[0]!.name).toBe('mcp.s.foo_bar_baz');
    expect(descriptors[0]!.name).toMatch(TOOL_NAME_RE);
    expect(nameMap.get('mcp.s.foo_bar_baz')).toBe('foo/bar baz');
  });

  it('resolves collisions deterministically by hash-suffixing every colliding entry', () => {
    // Both tools sanitize to `mcp.s.foo_bar`. Rule: ALL colliding entries
    // get a hash suffix — keeps resolution order-independent (no "first wins").
    const { descriptors, nameMap } = namespaceTools('s', [
      tool('foo/bar'),
      tool('foo bar'),
    ]);
    expect(descriptors).toHaveLength(2);

    const names = descriptors.map((d) => d.name);
    // Both should be unique, dispatcher-valid, and bear the hash suffix
    // computed from the ORIGINAL remote name (not the sanitized form).
    expect(new Set(names).size).toBe(2);
    for (const n of names) {
      expect(n).toMatch(TOOL_NAME_RE);
    }

    const hash1 = shortHash('s', 'foo/bar');
    const hash2 = shortHash('s', 'foo bar');
    expect(names).toContain(`mcp.s.foo_bar_${hash1}`);
    expect(names).toContain(`mcp.s.foo_bar_${hash2}`);

    // Reverse-map integrity: every descriptor round-trips to its original.
    expect(nameMap.get(`mcp.s.foo_bar_${hash1}`)).toBe('foo/bar');
    expect(nameMap.get(`mcp.s.foo_bar_${hash2}`)).toBe('foo bar');
  });

  it('preserves description and inputSchema verbatim and sets executesIn:host', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    const { descriptors } = namespaceTools('fs', [
      tool('read_file', { description: 'a tool', inputSchema: schema }),
    ]);
    const d = descriptors[0]!;
    expect(d.description).toBe('a tool');
    expect(d.inputSchema).toBe(schema);
    expect(d.executesIn).toBe('host');
  });

  it('omits description when the source has none (no undefined leak)', () => {
    const { descriptors } = namespaceTools('fs', [tool('read_file')]);
    const d = descriptors[0]!;
    expect('description' in d).toBe(false);
  });

  it('nameMap round-trips every descriptor', () => {
    const tools: McpToolDescriptor[] = [
      tool('read_file'),
      tool('WriteFile'),
      tool('weird name/here'),
    ];
    const { descriptors, nameMap } = namespaceTools('fs', tools);
    expect(descriptors).toHaveLength(tools.length);
    expect(nameMap.size).toBe(tools.length);
    for (const d of descriptors) {
      expect(nameMap.has(d.name)).toBe(true);
    }
    // Every original name should be mapped to (via some namespaced key).
    const mappedOriginals = new Set(nameMap.values());
    for (const t of tools) {
      expect(mappedOriginals.has(t.name)).toBe(true);
    }
  });

  it('caps name length at 64 chars with a stable hash suffix for very long remote names', () => {
    const longName = 'a'.repeat(200);
    const { descriptors, nameMap } = namespaceTools('fs', [tool(longName)]);
    const d = descriptors[0]!;
    expect(d.name.length).toBeLessThanOrEqual(64);
    expect(d.name).toMatch(TOOL_NAME_RE);
    // Hash suffix is derived from the ORIGINAL remote name so that two long
    // names that share a prefix still collide-resolve correctly.
    const hash = shortHash('fs', longName);
    expect(d.name.endsWith(`_${hash}`)).toBe(true);
    // And the reverse map still round-trips.
    expect(nameMap.get(d.name)).toBe(longName);
  });

  it('throws when the serverId alone is too long to fit under the length cap', () => {
    // If `mcp.${serverId}._${hash6}` already exceeds 64 chars, no sanitized
    // suffix can fit — that's a serverId pathology, not a tool-name issue.
    // Our config schema validates serverId length, so this path is defensive.
    const absurdId = 'x'.repeat(100);
    expect(() => namespaceTools(absurdId, [tool('read_file')])).toThrow(/name-too-long|too long/);
  });

  it('generates dispatcher-valid names for every descriptor across all cases', () => {
    const { descriptors } = namespaceTools('gh', [
      tool('read_file'),
      tool('GetRepo'),
      tool('weird/name here'),
      tool('a'.repeat(80)),
    ]);
    for (const d of descriptors) {
      expect(d.name).toMatch(TOOL_NAME_RE);
    }
  });
});
