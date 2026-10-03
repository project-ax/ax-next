import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectedMcpServers } from '../projected-mcp-servers.js';

// TASK-760 — the loader that hands the connector `.mcp.json` files in the
// host's skills projection to query()'s `mcpServers`. The trust-shape cases
// (namespace-only keys, symlinks, re-validation, workspace never read) are the
// point; the happy path is also pinned end to end in main.test.ts and against
// the real binary in connector-mcp-real-sdk.e2e.test.ts.

const PH = 'ax-cred:' + '0'.repeat(32);
let cfg: string;
let logs: string[];
const log = (l: string): void => {
  logs.push(l);
};

async function bundle(id: string, mcp: unknown | string): Promise<void> {
  const dir = path.join(cfg, 'skills', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${id}\n---\nbody`);
  if (mcp !== undefined) {
    await fs.writeFile(
      path.join(dir, '.mcp.json'),
      typeof mcp === 'string' ? mcp : JSON.stringify(mcp),
    );
  }
}

beforeEach(async () => {
  cfg = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-t760-'));
  logs = [];
});
afterEach(async () => {
  await fs.rm(cfg, { recursive: true, force: true });
});

describe('loadProjectedMcpServers', () => {
  it('returns nothing (and logs nothing) with no config dir or no projection', async () => {
    expect(await loadProjectedMcpServers(undefined, log)).toEqual({ servers: {}, skipped: [] });
    expect(await loadProjectedMcpServers('', log)).toEqual({ servers: {}, skipped: [] });
    expect(await loadProjectedMcpServers(cfg, log)).toEqual({ servers: {}, skipped: [] });
    expect(logs).toEqual([]);
  });

  it('loads stdio and http connector servers in the SDK McpServerConfig shape', async () => {
    await bundle('connector-a', {
      mcpServers: { c0123456789: { command: 'node', args: ['s.js'], env: { K: PH } } },
    });
    await bundle('connector-b', {
      mcpServers: {
        cabcdef0123: { type: 'http', url: 'https://mcp.example.com/', headers: { Authorization: `Bearer ${PH}` } },
      },
    });
    await bundle('plain-skill', undefined);
    const r = await loadProjectedMcpServers(cfg, log);
    expect(r.servers).toEqual({
      c0123456789: { type: 'stdio', command: 'node', args: ['s.js'], env: { K: PH } },
      cabcdef0123: { type: 'http', url: 'https://mcp.example.com/', headers: { Authorization: `Bearer ${PH}` } },
    });
    expect(r.skipped).toEqual([]);
  });

  it('skips keys that are not a host-minted connector namespace (incl. our reserved server names)', async () => {
    await bundle('x', {
      mcpServers: {
        linear: { command: 'node' },
        'ax-host-tools': { command: 'node' },
        C0123456789: { command: 'node' },
        c0123456789: { command: 'node' },
      },
    });
    const r = await loadProjectedMcpServers(cfg, log);
    expect(Object.keys(r.servers)).toEqual(['c0123456789']);
    expect(r.skipped).toHaveLength(3);
    expect(logs.join('\n')).toMatch(/'linear' is not a connector tool namespace/);
  });

  it('first bundle (sorted) wins a duplicate namespace; the second is logged', async () => {
    await bundle('b-second', { mcpServers: { c0123456789: { command: 'second' } } });
    await bundle('a-first', { mcpServers: { c0123456789: { command: 'first' } } });
    const r = await loadProjectedMcpServers(cfg, log);
    expect(r.servers['c0123456789']).toMatchObject({ command: 'first' });
    expect(r.skipped).toEqual([expect.stringMatching(/already loaded/)]);
  });

  it('re-validates every entry: bad headers, cross-transport fields, unknown types are dropped', async () => {
    await bundle('x', {
      mcpServers: {
        c0000000001: { type: 'http', url: 'https://e.example/', headers: { Authorization: 'Bearer sk-real-key' } },
        c0000000002: { type: 'http', url: 'https://e.example/', command: 'node' },
        c0000000003: { type: 'sse', url: 'https://e.example/' },
        c0000000004: { command: '' },
        c0000000005: 'not-an-object',
        c0000000006: { command: 'ok' },
      },
    });
    const r = await loadProjectedMcpServers(cfg, log);
    expect(Object.keys(r.servers)).toEqual(['c0000000006']);
    expect(r.skipped).toHaveLength(5);
    expect(r.skipped.every((s) => /failed validation/.test(s))).toBe(true);
  });

  it('ignores malformed files without throwing', async () => {
    await bundle('a', '{not json');
    await bundle('b', { notMcpServers: {} });
    await bundle('c', { mcpServers: [] });
    await bundle('d', { mcpServers: { c0123456789: { command: 'ok' } } });
    const r = await loadProjectedMcpServers(cfg, log);
    expect(Object.keys(r.servers)).toEqual(['c0123456789']);
    expect(r.skipped).toHaveLength(3);
  });

  it('does not follow a symlinked bundle dir or a symlinked .mcp.json', async () => {
    const outside = path.join(cfg, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(
      path.join(outside, '.mcp.json'),
      JSON.stringify({ mcpServers: { c0123456789: { command: 'evil' } } }),
    );
    await fs.mkdir(path.join(cfg, 'skills'), { recursive: true });
    await fs.symlink(outside, path.join(cfg, 'skills', 'linked-dir'));
    await bundle('linked-file', undefined);
    await fs.symlink(
      path.join(outside, '.mcp.json'),
      path.join(cfg, 'skills', 'linked-file', '.mcp.json'),
    );
    const r = await loadProjectedMcpServers(cfg, log);
    expect(r.servers).toEqual({});
    expect(r.skipped).toEqual([expect.stringMatching(/linked-file.*not a regular file/)]);
  });

  it('never reads a workspace / cwd .mcp.json — only <configDir>/skills/*/', async () => {
    await fs.writeFile(
      path.join(cfg, '.mcp.json'),
      JSON.stringify({ mcpServers: { c0123456789: { command: 'evil' } } }),
    );
    await fs.mkdir(path.join(cfg, '.claude', 'skills', 'x'), { recursive: true });
    await fs.writeFile(
      path.join(cfg, '.claude', 'skills', 'x', '.mcp.json'),
      JSON.stringify({ mcpServers: { c0123456789: { command: 'evil' } } }),
    );
    expect((await loadProjectedMcpServers(cfg, log)).servers).toEqual({});
  });
});
