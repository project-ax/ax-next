import { describe, expect, it } from 'vitest';
import { ToolCatalog } from '../catalog.js';

// ToolCatalog.validateDescriptor reconstructs each descriptor field-by-field,
// so a field it does not know is dropped rather than carried into the catalog.
//
// TASK-995 removed `flushWorkspaceBeforeCall` (the host→runner signal that
// made the runner flush its git workspace before a host tool read it) along
// with the workspace. A tool plugin that still sets it must still register —
// refusing it would fail the boot over a flag that grants nothing — and the
// flag must not reach `tool:list`, where it would claim a behaviour no runner
// has any more.

describe('ToolCatalog — the retired flush flag (TASK-995)', () => {
  it('registers a host tool that still sets flushWorkspaceBeforeCall, without carrying the flag', () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: 'host_reads_files',
      inputSchema: { type: 'object' },
      executesIn: 'host',
      flushWorkspaceBeforeCall: true,
    });
    const [d] = catalog.list();
    expect(d).toEqual({
      name: 'host_reads_files',
      inputSchema: { type: 'object' },
      executesIn: 'host',
    });
  });

  it('ignores the flag in any shape, on a host or a sandbox tool', () => {
    // These were refusals while the flag meant something (a non-boolean, or a
    // flush asked of a sandbox tool). Now the field is simply unknown.
    const catalog = new ToolCatalog();
    catalog.register({
      name: 'host_tool',
      inputSchema: { type: 'object' },
      executesIn: 'host',
      flushWorkspaceBeforeCall: 'yes',
    });
    catalog.register({
      name: 'sandbox_tool',
      inputSchema: { type: 'object' },
      executesIn: 'sandbox',
      flushWorkspaceBeforeCall: true,
    });
    for (const d of catalog.list()) {
      expect(d).not.toHaveProperty('flushWorkspaceBeforeCall');
    }
  });
});
