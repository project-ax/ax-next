import { describe, it, expect } from 'vitest';
import { parseSkillManifest } from '../manifest.js';

describe('parseSkillManifest -- capabilities.mcpServers', () => {
  it('parses a valid stdio MCP server', () => {
    const yaml = `name: x
description: x
capabilities:
  mcpServers:
    - name: github
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
      env: { LOG_LEVEL: info }
      allowedHosts: [api.github.com]
      credentials:
        - slot: GITHUB_TOKEN
          kind: api-key
`;
    const r = parseSkillManifest(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.capabilities.mcpServers).toEqual([
      {
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { LOG_LEVEL: 'info' },
        allowedHosts: ['api.github.com'],
        credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
      },
    ]);
    expect(r.value.capabilities.allowedHosts).toContain('api.github.com');
  });

  it('parses a valid http MCP server and folds url host into allowedHosts implicitly', () => {
    const yaml = `name: x
description: x
capabilities:
  mcpServers:
    - name: remote
      transport: http
      url: https://mcp.example.com
`;
    const r = parseSkillManifest(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.capabilities.mcpServers?.[0]?.allowedHosts).toContain('mcp.example.com');
    expect(r.value.capabilities.allowedHosts).toContain('mcp.example.com');
  });

  it('rejects non-whitelisted command', () => {
    const yaml = `name: x
description: x
capabilities:
  mcpServers:
    - name: x
      transport: stdio
      command: /bin/sh
`;
    const r = parseSkillManifest(yaml);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid-mcp-command');
  });

  it('rejects secret-looking env values', () => {
    const yaml = `name: x
description: x
capabilities:
  mcpServers:
    - name: x
      transport: stdio
      command: npx
      env: { apiKey: sk-xxx }
`;
    const r = parseSkillManifest(yaml);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('inline-secret-forbidden');
  });

  it('caps mcpServers array length at 8', () => {
    const items = Array.from({ length: 9 }, (_, i) => `      - name: s${i}\n        transport: stdio\n        command: npx`).join('\n');
    const yaml = `name: x\ndescription: x\ncapabilities:\n  mcpServers:\n${items}\n`;
    const r = parseSkillManifest(yaml);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid-manifest');
  });

  // -------------------------------------------------------------------------
  // env caps (symmetric with MCP_ARGS_*). Without these, the parser accepted
  // arbitrarily large env maps that downstream layers would still JSON-encode.
  // -------------------------------------------------------------------------

  it('rejects env with more than 32 keys', () => {
    // YAML flow-mapping inline so we keep the test compact.
    const pairs = Array.from({ length: 33 }, (_, i) => `K${i}: v`).join(', ');
    const yaml = `name: x
description: x
capabilities:
  mcpServers:
    - name: srv
      transport: stdio
      command: npx
      env: { ${pairs} }
`;
    const r = parseSkillManifest(yaml);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid-manifest');
    expect(r.message).toMatch(/at most 32 entries/);
  });

  it('rejects an env value longer than 256 chars', () => {
    const big = 'x'.repeat(257);
    const yaml = `name: x
description: x
capabilities:
  mcpServers:
    - name: srv
      transport: stdio
      command: npx
      env: { K: "${big}" }
`;
    const r = parseSkillManifest(yaml);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid-manifest');
    expect(r.message).toMatch(/value length/);
  });

  it('rejects an env key longer than 256 chars', () => {
    const bigKey = 'K'.repeat(257);
    const yaml = `name: x
description: x
capabilities:
  mcpServers:
    - name: srv
      transport: stdio
      command: npx
      env: { ${bigKey}: v }
`;
    const r = parseSkillManifest(yaml);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid-manifest');
    expect(r.message).toMatch(/key length/);
  });
});
