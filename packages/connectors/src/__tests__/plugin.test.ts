import { describe, expect, it } from 'vitest';
import { createConnectorsPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Manifest assertion. Hook-level integration tests live in store.test.ts +
// hooks.test.ts (testcontainers postgres).
// ---------------------------------------------------------------------------

describe('@ax/connectors plugin manifest', () => {
  it('registers the connectors:* hooks (CRUD + list-defaults + authored lifecycle), calls database:get-instance, subscribes to nothing', () => {
    const plugin = createConnectorsPlugin();
    expect(plugin.manifest).toEqual({
      name: '@ax/connectors',
      version: '0.0.0',
      registers: [
        'connectors:list',
        'connectors:list-defaults',
        'connectors:get',
        'connectors:upsert',
        'connectors:delete',
        'connectors:resolve',
        // TASK-94 — agent-authored connector drafts + the approval gate.
        'connectors:install-authored',
        'connectors:list-authored',
        // The Settings "Proposed by your assistant" fallback read.
        'connectors:list-authored-pending',
        'connectors:activate-authored',
        'connectors:clear-authored',
      ],
      // database:get-instance is hard — the plugin runs its own migration on
      // init and can't function without a postgres instance.
      calls: ['database:get-instance'],
      // credentials:delete is a soft dep — purge-on-delete degrades gracefully
      // when no @ax/credentials provider is present.
      optionalCalls: [
        {
          hook: 'credentials:delete',
          degradation:
            'the connector is deleted but its stored key is left in the vault (no @ax/credentials provider to purge it)',
        },
      ],
      subscribes: [],
    });
  });
});
