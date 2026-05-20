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
];
