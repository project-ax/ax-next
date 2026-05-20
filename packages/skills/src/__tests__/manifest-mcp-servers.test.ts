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
});
