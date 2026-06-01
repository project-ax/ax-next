import type { Destination } from './refs.js';

/**
 * Canonical (destination, expectedRef) pairs.
 *
 * The `refForDestination` function lives in three places — the canonical
 * source here in `@ax/credentials`, plus two intentional duplicates
 * (channel-web's `lib/credentials.ts` and credentials-admin-routes'
 * `destination-routes.ts`) that exist because CLAUDE.md invariant 2
 * forbids runtime cross-plugin imports.
 *
 * Each copy has a test that iterates this fixture array and asserts its
 * local implementation produces the expected ref. Adding a new
 * `Destination` kind requires updating this fixture AND all three copies;
 * any divergence breaks one of the three drift tests.
 */
export interface DestinationFixture {
  readonly destination: Destination;
  readonly expectedRef: string;
}

export const KNOWN_DESTINATION_FIXTURES: ReadonlyArray<DestinationFixture> = [
  {
    destination: { kind: 'provider', provider: 'anthropic' },
    expectedRef: 'provider:anthropic',
  },
  {
    destination: {
      kind: 'skill-slot',
      skillId: 'linear-tracker',
      slot: 'LINEAR_TOKEN',
    },
    expectedRef: 'skill:linear-tracker:LINEAR_TOKEN',
  },
  {
    destination: { kind: 'mcp-env', serverId: 'gh', envName: 'GH_TOKEN' },
    expectedRef: 'mcp:gh:env:GH_TOKEN',
  },
  {
    destination: {
      kind: 'mcp-header',
      serverId: 'gh',
      headerName: 'Authorization',
    },
    expectedRef: 'mcp:gh:header:Authorization',
  },
  {
    destination: {
      kind: 'routine-hmac',
      agentId: 'agt-1',
      routinePath: '.ax/routines/cron.md',
    },
    expectedRef: 'routine:agt-1:.ax/routines/cron.md:hmac',
  },
  {
    // Single-slot connector / standalone account key: the ref STAYS
    // `account:<service>` (back-compat by construction — TASK-124). Existing
    // stored keys resolve unchanged; "one key per service" preserved.
    destination: { kind: 'account', service: 'linear' },
    expectedRef: 'account:linear',
  },
  {
    // Multi-slot connector: a `slot` on the account destination expands the ref
    // to `account:<service>:<slot>` (TASK-124) so two slots that resolve to the
    // same service tag no longer collide on one vault row. `slot` is the
    // connector's declared SCREAMING_SNAKE capability slot name (no ':').
    destination: { kind: 'account', service: 'github', slot: 'GITHUB_TOKEN' },
    expectedRef: 'account:github:GITHUB_TOKEN',
  },
];
