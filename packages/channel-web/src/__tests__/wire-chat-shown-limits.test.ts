// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ApproveAuthoredSkillRequest,
  PermissionDecisionRequest,
  SHOWN_LIST_MAX,
} from '../wire/chat.js';

// TASK-945. Junk elements (`0`) would each fail on their own, so a result
// holding ONLY the size issue shows the list was refused before any element
// was parsed.
function expectOnlySizeIssue(
  r: { success: boolean; error?: { issues: unknown[] } },
  path: (string | number)[],
  maximum: number,
): void {
  expect(r.success).toBe(false);
  expect(r.error?.issues).toEqual([
    expect.objectContaining({ code: 'too_big', type: 'array', path, maximum }),
  ]);
}

type ShownList = 'hosts' | 'slots' | 'npm' | 'pypi';
type Route = 'permission-decision' | 'approve-authored-skill';
type Schema = typeof PermissionDecisionRequest | typeof ApproveAuthoredSkillRequest;
type Case = [route: Route, list: ShownList, schema: Schema, base: Record<string, string>];

const ROUTES: [Route, Schema, Record<string, string>][] = [
  ['permission-decision', PermissionDecisionRequest, { conversationId: 'c1', skillId: 's1' }],
  ['approve-authored-skill', ApproveAuthoredSkillRequest, { agentId: 'a1', skillId: 's1' }],
];
const LISTS: ShownList[] = ['hosts', 'slots', 'npm', 'pypi'];
const CASES: Case[] = ROUTES.flatMap(([route, schema, base]) =>
  LISTS.map((list): Case => [route, list, schema, base]),
);

const empty = (): Record<ShownList, unknown[]> => ({ hosts: [], slots: [], npm: [], pypi: [] });

describe('chat shown.* list limits (TASK-945)', () => {
  // The biggest card GrantRow sends back: a skill names at most 64 connectors,
  // and a connector is written with at most 64 entries per list. The length is
  // pinned as a literal, so a lower SHOWN_LIST_MAX, or a .max() one below it,
  // fails here. The entries are distinct, as in GrantRow's de-duplicated union.
  it.each(CASES)('%s: shown.%s takes SHOWN_LIST_MAX entries', (_route, list, schema, base) => {
    const items = Array.from({ length: SHOWN_LIST_MAX }, (_, i) => `entry-${i}`);
    expect(items).toHaveLength(4_096);
    const r = schema.safeParse({ ...base, shown: { ...empty(), [list]: items } });
    expect(r.success).toBe(true);
    expect(r.data?.shown?.[list]).toEqual(items);
  });

  // PermissionDecisionRequest is `.strict()`; the result must still hold
  // exactly one issue.
  it.each(CASES)('%s: shown.%s one over fails with only the size issue', (_route, list, schema, base) => {
    const junk = Array.from({ length: SHOWN_LIST_MAX + 1 }, () => 0);
    const r = schema.safeParse({ ...base, shown: { ...empty(), [list]: junk } });
    expectOnlySizeIssue(r, ['shown', list], SHOWN_LIST_MAX);
  });
});
