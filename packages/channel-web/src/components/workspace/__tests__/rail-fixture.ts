/**
 * Rail shapes for the component tests.
 *
 * A TEST fixture, and only a test fixture. Nothing under `src/components/` may
 * import it — `no-fixtures.test.ts` fails the build if anything does. The rail
 * is the one surface where a plausible-looking string reaching production would
 * be a security claim nobody made, so the wall is enforced rather than assumed.
 */
import type {
  AgentRailData,
  GrantRow,
  PermissionRow,
  RailActivity,
} from '@/lib/workspace-types';

export function railActivity(over: Partial<RailActivity> = {}): RailActivity {
  return {
    phrase: 'Reading email',
    counter: null,
    startedAt: new Date().toISOString(),
    stale: false,
    source: 'tool',
    ...over,
  };
}

export function describedRow(over: Partial<PermissionRow> = {}): PermissionRow {
  return {
    verdict: 'allow',
    capability: 'search the web',
    source: 'rule:web.search',
    provenance: 'catalog',
    described: true,
    mechanicalLabel: null,
    theirDescription: null,
    theirName: null,
    ...over,
  };
}

export function mcpRow(over: Partial<PermissionRow> = {}): PermissionRow {
  return {
    verdict: 'hold',
    capability: '',
    source: 'mcp:mcp.linear.create_issue',
    provenance: 'mcp',
    described: false,
    mechanicalLabel: 'mcp.linear.create_issue',
    theirDescription: 'Creates an issue in Linear',
    theirName: 'linear',
    ...over,
  };
}

export function siteGrant(over: Partial<GrantRow> = {}): GrantRow {
  return {
    ref: { grant: 'site', host: 'api.linear.app' },
    verdict: 'allow',
    action: 'reach',
    label: 'api.linear.app',
    source: 'grant:api.linear.app',
    provenance: 'grant',
    grantedAt: '2026-08-14T10:00:00.000Z',
    grantedFor: null,
    revocable: true,
    ...over,
  };
}

export function rail(over: Partial<AgentRailData> = {}): AgentRailData {
  return {
    activity: { status: 'ok', activity: null },
    permissions: {
      status: 'ok',
      rows: [],
      incomplete: false,
      unrestrictedTools: false,
    },
    grants: { status: 'ok', rows: [], incomplete: false },
    counters: { status: 'ok', rows: [], windowDays: 7 },
    ...over,
  };
}
