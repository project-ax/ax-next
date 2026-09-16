/**
 * The presence rule (TASK-351).
 *
 * The Today queue shows every open grant. An agent's thread ALSO shows the
 * ones that agent raised, but only while the person is demonstrably there
 * reading that thread: its chat tab is the open route, and the tab is visible.
 *
 * Pinned here as a pure function because the rule is the part worth pinning,
 * and because each refusal is a separate sentence about the product — "another
 * agent's thread is not this agent's thread", "the files tab has no composer to
 * sit above", "a backgrounded tab has nobody in front of it". A render test
 * covering all six would be six mounts saying one thing each.
 */
import { describe, expect, test } from 'vitest';
import {
  grantBelongsInThread,
  threadGrants,
  type GrantPresence,
} from '../workspace-grant-presence';
import { grantKey, type WorkspaceGrant } from '../workspace-grant-store';
import type { PermissionRequest } from '../../server/types';
import type { WorkspaceRoute } from '../workspace-route';

const skill = (skillId = 'linear'): PermissionRequest => ({
  kind: 'skill',
  skillId,
  description: 'File and read Linear issues',
  hosts: ['api.linear.app'],
  slots: [],
});

const grant = (agentId = 'a-quill', request = skill()): WorkspaceGrant => ({
  key: grantKey(request),
  request,
  agentId,
  conversationId: 'cnv-1',
});

/** The one presence state that routes a grant into a thread. */
const there = (
  id = 'a-quill',
  tab: 'chat' | 'did' | 'files' | 'memory' = 'chat',
): GrantPresence => ({ route: { kind: 'agent', id, tab }, visible: true });

describe('the thread is the exception', () => {
  test("it takes the grant when that agent's chat tab is open and the tab is visible", () => {
    expect(grantBelongsInThread(grant('a-quill'), there('a-quill'))).toBe(true);
  });

  test("another agent's thread does not take it", () => {
    // The discriminating case for the whole rule: without the id comparison
    // every open thread would draw every agent's grants.
    expect(grantBelongsInThread(grant('a-quill'), there('a-scout'))).toBe(false);
  });

  test.each(['did', 'files', 'memory'] as const)(
    "the agent's %s tab does not take it",
    (tab) => {
      // Right agent, wrong view. The card renders above the composer, and no
      // other tab has one.
      expect(grantBelongsInThread(grant('a-quill'), there('a-quill', tab))).toBe(
        false,
      );
    },
  );

  test.each([
    ['today', { kind: 'today' } as WorkspaceRoute],
    ['activity', { kind: 'activity' } as WorkspaceRoute],
  ])('%s does not take it — it IS the queue, or next to it', (_name, route) => {
    expect(grantBelongsInThread(grant('a-quill'), { route, visible: true })).toBe(
      false,
    );
  });

  test('a hidden tab does not take it, however right the route is', () => {
    // A backgrounded tab, a minimised window, a closed laptop. The person is
    // not reading this thread, so the thread is not where the question lives.
    expect(
      grantBelongsInThread(grant('a-quill'), {
        route: { kind: 'agent', id: 'a-quill', tab: 'chat' },
        visible: false,
      }),
    ).toBe(false);
  });
});

describe('threadGrants — a filter, never a copy', () => {
  test('it hands back the very same row objects', () => {
    // If this were a map/clone, the card in the thread and the row in the queue
    // would be two objects for one grant — the second live copy invariant 4
    // forbids. Reference equality is the cheapest way to say "same row".
    const rows = [grant('a-quill')];

    const picked = threadGrants(rows, there('a-quill'));

    expect(picked).toHaveLength(1);
    expect(picked[0]).toBe(rows[0]);
  });

  test('it picks only the open thread’s own grants out of a mixed queue', () => {
    const mine = grant('a-quill', skill('linear'));
    const theirs = grant('a-scout', skill('github'));

    expect(threadGrants([mine, theirs], there('a-quill'))).toEqual([mine]);
    expect(threadGrants([mine, theirs], there('a-scout'))).toEqual([theirs]);
  });

  test('it takes nothing at all when nobody is looking', () => {
    const rows = [grant('a-quill'), grant('a-scout', skill('github'))];

    expect(
      threadGrants(rows, {
        route: { kind: 'agent', id: 'a-quill', tab: 'chat' },
        visible: false,
      }),
    ).toEqual([]);
    // And the queue still holds both — this function never removes anything
    // from it, which is what stops a grant being orphaned in a thread.
    expect(rows).toHaveLength(2);
  });
});
