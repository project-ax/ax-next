import { describe, expect, it } from 'vitest';
import { createConnectorsPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Manifest assertion. Hook-level integration tests live in store.test.ts +
// hooks.test.ts (testcontainers postgres).
// ---------------------------------------------------------------------------

describe('@ax/connectors plugin manifest', () => {
  it('registers the connectors:* hooks (CRUD + list-defaults + authored lifecycle), calls database:get-instance, subscribes to agents:deleted', () => {
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
        // TASK-697 — the read-authorization seam @ax/credentials consults before an
        // `account:` ref may fall through to the global (company) scope.
        'credentials:authorize-global:account',
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
        {
          hook: 'tool-policy:get-connector-defaults',
          degradation:
            'the connector editor cannot show per-tool permissions (the route answers 503)',
        },
        {
          hook: 'tool-policy:set-connector-defaults',
          degradation:
            'the connector editor cannot save per-tool permissions (the route answers 503)',
        },
        // TASK-697 — the admin check on a workspace-keyed connector's owner.
        {
          hook: 'auth:get-user',
          degradation:
            'workspace-keyed (company) connector credentials are never authorized for reading, because the connector owner cannot be proven to be an admin; personal keys are unaffected (fail closed)',
        },
      ],
      // TASK-718 — a deleted agent's authored connector drafts go with it.
      subscribes: ['agents:deleted'],
    });
  });
});
