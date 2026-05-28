import { PluginError } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { ToolCatalog } from '../catalog.js';

// ToolCatalog.validateDescriptor reconstructs each descriptor field-by-field,
// so any NEW field has to be threaded explicitly or it's silently dropped.
// flushWorkspaceBeforeCall is the host→runner signal that gates the BUG-W2
// pre-call workspace flush — if the catalog drops it, the runner never flushes
// and install_authored_skill regresses. These tests pin that it survives.

describe('ToolCatalog flushWorkspaceBeforeCall', () => {
  it('carries flushWorkspaceBeforeCall:true through register → list', () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: 'install_authored_skill',
      inputSchema: { type: 'object' },
      executesIn: 'host',
      flushWorkspaceBeforeCall: true,
    });
    const [d] = catalog.list();
    expect(d?.flushWorkspaceBeforeCall).toBe(true);
  });

  it('omits the field when not set (no redundant false)', () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: 'web_search',
      inputSchema: { type: 'object' },
      executesIn: 'host',
    });
    const [d] = catalog.list();
    expect(d?.flushWorkspaceBeforeCall).toBeUndefined();
  });

  it('does not carry an explicit false', () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: 'web_search',
      inputSchema: { type: 'object' },
      executesIn: 'host',
      flushWorkspaceBeforeCall: false,
    });
    const [d] = catalog.list();
    expect(d?.flushWorkspaceBeforeCall).toBeUndefined();
  });

  it('rejects a non-boolean flushWorkspaceBeforeCall', () => {
    const catalog = new ToolCatalog();
    expect(() =>
      catalog.register({
        name: 'bad_tool',
        inputSchema: { type: 'object' },
        executesIn: 'host',
        flushWorkspaceBeforeCall: 'yes',
      }),
    ).toThrow(PluginError);
  });

  it('rejects flushWorkspaceBeforeCall:true on a sandbox tool (host-only capability)', () => {
    const catalog = new ToolCatalog();
    // The flush only runs in the host-tool forwarder, so the flag is
    // meaningless (and misleading) on a sandbox tool — reject rather than
    // silently ignore, keeping the capability boundary explicit.
    expect(() =>
      catalog.register({
        name: 'sandbox_tool',
        inputSchema: { type: 'object' },
        executesIn: 'sandbox',
        flushWorkspaceBeforeCall: true,
      }),
    ).toThrow(PluginError);
  });
});
