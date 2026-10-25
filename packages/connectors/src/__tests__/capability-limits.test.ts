import { describe, expect, it } from 'vitest';
import { PluginError } from '@ax/core';
import {
  CAPABILITY_WRITE_LIMITS as L,
  CapabilitiesSchema,
  CapabilitiesWriteSchema,
} from '../types.js';
import { validateCapabilities, validateCapabilitiesForWrite } from '../store.js';

// TASK-945. Connector capability lists are bounded on WRITE only
// (`connectors:upsert`, `connectors:install-authored`). The read schema also
// parses every stored row, so it stays unbounded: a row stored before these
// limits must still open, and its owner must be able to trim it (the TASK-712
// rule). The Postgres funnel tests live in admin-routes.test.ts and
// authored-hooks.test.ts.
//
// Junk elements (`0`) would each fail on their own, so a result holding ONLY
// the size issue shows the list was refused before any element was parsed.
const junk = (n: number): unknown[] => Array.from({ length: n }, () => 0);
const copies = (n: number, item: unknown): unknown[] => Array.from({ length: n }, () => item);

function expectOnlySizeIssue(
  r: { success: boolean; error?: { issues: unknown[] } },
  path: (string | number)[],
  maximum: number,
): void {
  expect(r.success).toBe(false);
  expect(r.error?.issues).toEqual([
    expect.objectContaining({ code: 'too_big', type: 'array', path, maximum }),
  ]);
}

const base = () => ({
  allowedHosts: [] as unknown[],
  credentials: [] as unknown[],
  mcpServers: [] as unknown[],
  packages: { npm: [] as unknown[], pypi: [] as unknown[] },
});
const server = {
  name: 'srv',
  transport: 'http',
  url: 'https://mcp.example.com',
  allowedHosts: [] as unknown[],
  credentials: [] as unknown[],
};
const apiKeySlot = { slot: 'API_KEY', kind: 'api-key' };

type Case = [
  label: string,
  path: (string | number)[],
  limit: number,
  valid: unknown,
  build: (items: unknown[]) => unknown,
];

const CASES: Case[] = [
  ['allowedHosts', ['allowedHosts'], L.allowedHosts, 'api.example.com',
    (items) => ({ ...base(), allowedHosts: items })],
  ['credentials', ['credentials'], L.credentials, apiKeySlot,
    (items) => ({ ...base(), credentials: items })],
  ['mcpServers', ['mcpServers'], L.mcpServers, server,
    (items) => ({ ...base(), mcpServers: items })],
  ["an MCP server's allowedHosts", ['mcpServers', 0, 'allowedHosts'], L.allowedHosts, 'mcp.example.com',
    (items) => ({ ...base(), mcpServers: [{ ...server, allowedHosts: items }] })],
  ["an MCP server's credentials", ['mcpServers', 0, 'credentials'], L.credentials, apiKeySlot,
    (items) => ({ ...base(), mcpServers: [{ ...server, credentials: items }] })],
  ['packages.npm', ['packages', 'npm'], L.packages, 'left-pad',
    (items) => ({ ...base(), packages: { npm: items, pypi: [] } })],
  ['packages.pypi', ['packages', 'pypi'], L.packages, 'requests',
    (items) => ({ ...base(), packages: { npm: [], pypi: items } })],
  // The OAuth arm is a `.strict()` object inside a discriminated union: one
  // over must still be one issue.
  ["an OAuth slot's scopes", ['credentials', 0, 'scopes'], L.scopes, 'read',
    (items) => ({
      ...base(),
      mcpServers: [server],
      credentials: [{ slot: 'TOKEN', kind: 'oauth', server: 'srv', scopes: items }],
    })],
];

describe('connector capability list limits apply on write only (TASK-945)', () => {
  // The cases below size their lists FROM the limits, so they cannot see a
  // changed limit. Pin the values: 64 / 32 / 8 are the sandbox wire's own
  // per-entry limits (@ax/sandbox-protocol InstalledSkillSchema).
  it('pins the sized values', () => {
    expect(L).toEqual({ allowedHosts: 64, credentials: 32, mcpServers: 8, packages: 64, scopes: 128 });
  });

  it.each(CASES)('%s: the write schema takes the limit', (_label, _path, limit, valid, build) => {
    expect(CapabilitiesWriteSchema.safeParse(build(copies(limit, valid))).success).toBe(true);
  });

  it.each(CASES)(
    '%s: one over fails the write schema with only the size issue',
    (_label, path, limit, _valid, build) => {
      expectOnlySizeIssue(CapabilitiesWriteSchema.safeParse(build(junk(limit + 1))), path, limit);
    },
  );

  it.each(CASES)(
    '%s: the read schema still parses a stored spec over the limit',
    (_label, _path, limit, valid, build) => {
      expect(CapabilitiesSchema.safeParse(build(copies(limit + 1, valid))).success).toBe(true);
    },
  );

  it('validateCapabilitiesForWrite refuses an over-limit spec with invalid-payload, and validateCapabilities (read) returns it', () => {
    const spec = { ...base(), allowedHosts: copies(L.allowedHosts + 1, 'api.example.com') };
    let thrown: unknown;
    try {
      validateCapabilitiesForWrite(spec);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PluginError);
    expect((thrown as PluginError).code).toBe('invalid-payload');
    expect(validateCapabilities(spec).allowedHosts).toHaveLength(L.allowedHosts + 1);
  });
});
