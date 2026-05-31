import { describe, expect, it } from 'vitest';
import { createConnectorsPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Manifest assertion. Hook-level integration tests live in store.test.ts +
// hooks.test.ts (testcontainers postgres).
// ---------------------------------------------------------------------------

describe('@ax/connectors plugin manifest', () => {
  it('registers the five connectors:* hooks, calls database:get-instance, subscribes to nothing', () => {
    const plugin = createConnectorsPlugin();
    expect(plugin.manifest).toEqual({
      name: '@ax/connectors',
      version: '0.0.0',
      registers: [
        'connectors:list',
        'connectors:get',
        'connectors:upsert',
        'connectors:delete',
        'connectors:resolve',
      ],
      // database:get-instance is hard — the plugin runs its own migration on
      // init and can't function without a postgres instance.
      calls: ['database:get-instance'],
      subscribes: [],
    });
  });
});
