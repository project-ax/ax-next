import { describe, expect, it } from 'vitest';
import { createConnectorsPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Manifest assertion. Hook-level integration tests live in store.test.ts +
// hooks.test.ts (testcontainers postgres).
// ---------------------------------------------------------------------------

describe('@ax/connectors plugin manifest', () => {
  it('registers the connectors:* hooks (CRUD + authored lifecycle + the TASK-808 legacy-default conversion pair), calls database:get-instance, subscribes to agents:deleted', () => {
    const plugin = createConnectorsPlugin();
    expect(plugin.manifest).toEqual({
      name: '@ax/connectors',
      version: '0.0.0',
      registers: [
        'connectors:list',
        // TASK-739 — an agent's effective connector set.
        'connectors:list-effective',
        'connectors:get',
        'connectors:upsert',
        'connectors:delete',
        'connectors:resolve',
        // TASK-744 — toolNamespace → connector display name.
        'connectors:tool-labels',
        // Agent-owned sign-ins slice 2b — which ids are still in use.
        'connectors:live-ids',
        // TASK-94 — agent-authored connector drafts (the admins' queue).
        'connectors:install-authored',
        // Slice 2c — the admin proposal queue and its Dismiss.
        'connectors:list-authored-pending-all',
        'connectors:clear-authored-by-id',
        // TASK-808 — TRANSITIONAL: let @ax/agents convert the retired "Set default"
        // flag into explicit attachments at boot (no HTTP / IPC surface).
        'connectors:list-legacy-defaults',
        'connectors:clear-legacy-default',
        // TASK-697 — the read-authorization seam @ax/credentials consults before an
        // `account:` ref may fall through to the global (company) scope.
        'credentials:authorize-global:account',
        // TASK-711 — its agent-scope twin.
        'credentials:authorize-agent:account',
      ],
      // database:get-instance is hard — the plugin runs its own migration on
      // init and can't function without a postgres instance.
      calls: ['database:get-instance'],
      // credentials:delete is a soft dep — purge-on-delete and the sign-out
      // before a retarget (TASK-887) degrade gracefully when no
      // @ax/credentials provider is present.
      optionalCalls: [
        {
          hook: 'credentials:delete',
          degradation:
            'the connector is deleted or pointed somewhere new but its stored key is left in the vault (no @ax/credentials provider to purge it)',
        },
        {
          hook: 'credentials:purge-account',
          degradation:
            "the connector is deleted or pointed somewhere new but agents' sign-ins for it are left in the vault (a later same-id connector, or the new address, could receive them)",
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
        // TASK-758 — the gated reset before an endpoint change commits.
        {
          hook: 'tool-policy:reset-tool-namespaces',
          degradation:
            'an endpoint change saves without a reset; with no per-tool-permission provider there are no stored choices for it to carry over',
        },
        // TASK-809 — which ceiling (admin per-connector vs. per-agent) applies
        // to each tool namespace, keyed off the server's auth type.
        {
          hook: 'tool-policy:set-ceiling-sources',
          degradation:
            'no per-tool-permission provider is loaded, so there is no admin ceiling to switch on or off; connectors save normally',
        },
        // TASK-697 — the admin check on a workspace-keyed connector's owner.
        {
          hook: 'auth:get-user',
          degradation:
            'workspace-keyed (company) connector credentials are never authorized for reading, because the connector owner cannot be proven to be an admin; personal keys are unaffected (fail closed)',
        },
        // TASK-1100 — the admin connector directory search route.
        {
          hook: 'connectors:directory-search',
          degradation:
            'the admin connector directory answers as turned off (no @ax/connector-directory loaded)',
        },
        // TASK-1102 — which directory listing a connector was set up from,
        // and a hand-changed server address on one.
        {
          hook: 'connectors:directory-provenance-record',
          degradation:
            'a connector set up from the directory saves normally, but nothing remembers which listing it came from (no @ax/connector-directory loaded, or it is turned off)',
        },
        {
          hook: 'connectors:directory-provenance-mark-edited',
          degradation:
            'a connector whose address is changed by hand saves normally, but its directory listing record is not marked as edited (no @ax/connector-directory loaded, or it is turned off)',
        },
      ],
      // TASK-718 — a deleted agent's authored connector drafts go with it.
      subscribes: ['agents:deleted'],
    });
  });
});
