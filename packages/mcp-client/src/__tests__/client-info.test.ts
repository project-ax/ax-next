import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIENT_INFO, readMcpClientInfo } from '../connector-inventory/client-info.js';

describe('readMcpClientInfo', () => {
  it('is the default when AX_MCP_CLIENT_NAME is unset or empty', () => {
    expect(readMcpClientInfo({})).toStrictEqual({ name: '@ax/mcp-client', version: '0.0.0' });
    expect(readMcpClientInfo({ AX_MCP_CLIENT_NAME: '' })).toStrictEqual(DEFAULT_CLIENT_INFO);
  });

  it('replaces only the name', () => {
    expect(readMcpClientInfo({ AX_MCP_CLIENT_NAME: 'acme-agents' })).toStrictEqual({
      name: 'acme-agents',
      version: '0.0.0',
    });
    expect(readMcpClientInfo({ AX_MCP_CLIENT_NAME: 'x'.repeat(64) }).name).toBe('x'.repeat(64));
  });

  it.each([
    ['a space', 'acme agents'],
    ['a newline', 'acme\nagents'],
    ['non-ASCII', 'acmé'],
    ['65 characters', 'x'.repeat(65)],
  ])('throws on %s, so a typo fails boot', (_label, raw) => {
    expect(() => readMcpClientInfo({ AX_MCP_CLIENT_NAME: raw })).toThrow(/AX_MCP_CLIENT_NAME must be/);
  });
});
