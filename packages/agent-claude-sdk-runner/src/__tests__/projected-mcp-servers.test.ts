import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectedMcpServers } from '../projected-mcp-servers.js';

// The loader itself lives in @ax/agent-runner-core (TASK-826) and its
// trust-shape suite moved with it. This pins only the claude-sdk adapter: the
// runner-neutral server becomes the SDK's `McpServerConfig` (`type: 'http'`,
// no `bundle`), which `query({ mcpServers })` is handed verbatim.

const PH = 'ax-cred:' + '0'.repeat(32);
let cfg: string;

beforeEach(async () => {
  cfg = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-t826-'));
});
afterEach(async () => {
  await fs.rm(cfg, { recursive: true, force: true });
});

describe('loadProjectedMcpServers (claude-sdk adapter)', () => {
  it('maps projected servers to the SDK http McpServerConfig shape', async () => {
    const dir = path.join(cfg, 'skills', 'conn');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          c0123456789: { type: 'http', url: 'https://plain.example.com/' },
          cabcdef0123: { type: 'http', url: 'https://mcp.example.com/', headers: { Authorization: `Bearer ${PH}` } },
          c0000000001: { command: 'npx' },
        },
      }),
    );
    const skippedLines: string[] = [];
    const r = await loadProjectedMcpServers(cfg, (l) => skippedLines.push(l));
    expect(r.servers).toEqual({
      c0123456789: { type: 'http', url: 'https://plain.example.com/' },
      cabcdef0123: { type: 'http', url: 'https://mcp.example.com/', headers: { Authorization: `Bearer ${PH}` } },
    });
    expect(r.skipped).toEqual([expect.stringMatching(/c0000000001.*stdio/)]);
    expect(skippedLines).toEqual(r.skipped);
  });

  it('returns nothing with no config dir', async () => {
    expect(await loadProjectedMcpServers(undefined, () => {})).toEqual({ servers: {}, skipped: [] });
  });
});
