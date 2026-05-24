import { describe, it, expect } from 'vitest';
import { DISPATCHER_DEPENDENCIES } from '@ax/ipc-core';
import { createIpcServerPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Manifest tests for @ax/ipc-server.
//
// The transport doesn't hand-maintain its dependency list — it spreads
// @ax/ipc-core's DISPATCHER_DEPENDENCIES (the single source of truth for the
// hooks the shared dispatcher transitively invokes). These tests assert the
// spread is verbatim, so a transport can't silently fall behind the
// dispatcher again (the drift ARCH-2 fixes).
// ---------------------------------------------------------------------------

describe('createIpcServerPlugin manifest', () => {
  it('registers ipc:start / ipc:stop', () => {
    const plugin = createIpcServerPlugin();
    expect(plugin.manifest.registers).toEqual(['ipc:start', 'ipc:stop']);
  });

  it('manifest.calls is spread verbatim from DISPATCHER_DEPENDENCIES.requiredCalls', () => {
    const plugin = createIpcServerPlugin();
    expect(plugin.manifest.calls).toEqual([
      ...DISPATCHER_DEPENDENCIES.requiredCalls,
    ]);
  });

  it('manifest.optionalCalls is spread verbatim from DISPATCHER_DEPENDENCIES.optionalCalls', () => {
    const plugin = createIpcServerPlugin();
    expect(plugin.manifest.optionalCalls).toEqual([
      ...DISPATCHER_DEPENDENCIES.optionalCalls,
    ]);
  });

  it('does not list any dynamic tool:execute: route in manifest.calls', () => {
    const plugin = createIpcServerPlugin();
    expect(
      plugin.manifest.calls.some((c) => c.startsWith('tool:execute:')),
    ).toBe(false);
  });
});
