import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TOOL_NAMESPACE_RE,
  deriveToolNamespace,
  deriveToolNamespaces,
} from '../tool-namespace.js';
import type { Capabilities } from '../types.js';

function server(name: string): Capabilities['mcpServers'][number] {
  return {
    name,
    transport: 'http',
    url: `https://mcp.example.com/${name}`,
    allowedHosts: ['mcp.example.com'],
    credentials: [],
  };
}

function caps(...names: string[]): Capabilities {
  return {
    allowedHosts: [],
    credentials: [],
    mcpServers: names.map(server),
    packages: { npm: [], pypi: [] },
    services: [],
  };
}

describe('deriveToolNamespace', () => {
  it('is deterministic — the same (owner, connector, server) always yields the same namespace', () => {
    const a = deriveToolNamespace('userA', 'linear', 'linear');
    const b = deriveToolNamespace('userA', 'linear', 'linear');
    expect(a).toBe(b);
  });

  it('matches the documented derivation (pinned so a silent algorithm change is loud)', () => {
    const expected =
      'c' +
      createHash('sha256')
        .update('ax-connector-tool-namespace/v1\0userA\0linear\0linear')
        .digest('hex')
        .slice(0, 10);
    expect(deriveToolNamespace('userA', 'linear', 'linear')).toBe(expected);
    // Pin one literal too: the algorithm (domain tag, NUL separators, slice
    // length) is a stable contract — toolKeys persisted in per-agent permission
    // rows are keyed off it, so a change would orphan every stored decision.
    expect(expected).toBe('c5e0235982f');
  });

  it('has the shape /^c[0-9a-f]{10}$/ and stays well under the 64-char tool-name limit', () => {
    const ns = deriveToolNamespace(
      'user-with-a-long-id-0123456789',
      'a-very-long-connector-id-0123456789',
      'a-very-long-server-name-0123456789',
    );
    expect(ns).toMatch(TOOL_NAMESPACE_RE);
    expect(ns).toHaveLength(11);
    // mcp__<ns>__<tool> with a generous 40-char tool name still fits in 64.
    expect(`mcp__${ns}__${'t'.repeat(40)}`.length).toBeLessThanOrEqual(64);
  });

  it('differs by owner', () => {
    expect(deriveToolNamespace('userA', 'linear', 'linear')).not.toBe(
      deriveToolNamespace('userB', 'linear', 'linear'),
    );
  });

  it('differs by connector id', () => {
    expect(deriveToolNamespace('userA', 'linear', 'linear')).not.toBe(
      deriveToolNamespace('userA', 'linear-2', 'linear'),
    );
  });

  it('differs by server name', () => {
    expect(deriveToolNamespace('userA', 'linear', 'linear')).not.toBe(
      deriveToolNamespace('userA', 'linear', 'other'),
    );
  });

  it('separates fields — shifting a boundary between adjacent fields cannot collide', () => {
    // Without a separator these would hash the same bytes.
    expect(deriveToolNamespace('ab', 'c', 's')).not.toBe(deriveToolNamespace('a', 'bc', 's'));
    expect(deriveToolNamespace('o', 'ab', 'c')).not.toBe(deriveToolNamespace('o', 'a', 'bc'));
  });

  it('does not expose the owner id', () => {
    const ns = deriveToolNamespace('very-recognisable-owner', 'linear', 'linear');
    expect(ns).not.toContain('very');
    expect(ns).not.toContain('owner');
  });
});

describe('TOOL_NAMESPACE_RE', () => {
  it('accepts a derived namespace and rejects near-misses', () => {
    expect(TOOL_NAMESPACE_RE.test('c0123456789')).toBe(true);
    expect(TOOL_NAMESPACE_RE.test('cabcdef0123')).toBe(true);
    expect(TOOL_NAMESPACE_RE.test('C0123456789')).toBe(false); // uppercase prefix
    expect(TOOL_NAMESPACE_RE.test('cABCDEF0123')).toBe(false); // uppercase hex
    expect(TOOL_NAMESPACE_RE.test('c012345678')).toBe(false); // too short
    expect(TOOL_NAMESPACE_RE.test('c01234567890')).toBe(false); // too long
    expect(TOOL_NAMESPACE_RE.test('d0123456789')).toBe(false); // wrong prefix
    expect(TOOL_NAMESPACE_RE.test('linear')).toBe(false);
    expect(TOOL_NAMESPACE_RE.test('c0123456789\n')).toBe(false); // trailing newline
  });
});

describe('deriveToolNamespaces', () => {
  it('returns one entry per mcpServers entry, in order, each matching the per-server derivation', () => {
    const out = deriveToolNamespaces('userA', { id: 'linear', capabilities: caps('first', 'second') });
    expect(out).toEqual([
      { server: 'first', toolNamespace: deriveToolNamespace('userA', 'linear', 'first') },
      { server: 'second', toolNamespace: deriveToolNamespace('userA', 'linear', 'second') },
    ]);
    expect(out[0]!.toolNamespace).not.toBe(out[1]!.toolNamespace);
  });

  it('returns [] when the connector declares no MCP servers', () => {
    expect(deriveToolNamespaces('userA', { id: 'sf', capabilities: caps() })).toEqual([]);
  });
});
