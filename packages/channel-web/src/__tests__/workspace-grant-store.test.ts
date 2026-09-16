/**
 * The workspace grant store (TASK-350).
 *
 * Chat's `permission-card-store` is a single slot, because chat shows one card
 * at a time above the composer. Today is a QUEUE — two grants can legitimately
 * be open at once — so this store is a list, and the interesting behaviour is
 * all about identity: one grant must be one row, however many times the frame
 * arrives.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  getWorkspaceGrantSnapshot,
  grantKey,
  workspaceGrantActions,
} from '../lib/workspace-grant-store';
import type { PermissionRequest } from '../server/types';

const skill = (skillId = 'linear'): PermissionRequest => ({
  kind: 'skill',
  skillId,
  description: 'File and read Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key' }],
});

const connector = (connectorId = 'linear'): PermissionRequest => ({
  kind: 'connector',
  connectorId,
  name: 'Linear',
  hosts: ['api.linear.app'],
  slots: [],
});

const host = (h = 'example.org', sessionId = 's-1'): PermissionRequest => ({
  kind: 'host',
  host: h,
  sessionId,
});

/**
 * Where a grant came from. Every test below raises from one agent unless it is
 * specifically about two, so the default keeps the interesting argument — the
 * request — the only one that varies.
 */
const from = (agentId = 'a-quill', conversationId: string | null = 'cnv-1') => ({
  conversationId,
  agentId,
});

beforeEach(() => {
  workspaceGrantActions.resetForTest();
});

describe('grantKey — identity per kind', () => {
  test('a grant is identified by its subject, not by the frame that carried it', () => {
    expect(grantKey(skill('linear'))).toBe('skill:linear');
    expect(grantKey(connector('linear'))).toBe('connector:linear');
    expect(grantKey(host('example.org'))).toBe('host:example.org');
  });

  test('the three kinds cannot collide on one subject name', () => {
    // A skill and a connector can share a slug — they are still two grants.
    const keys = new Set([
      grantKey(skill('linear')),
      grantKey(connector('linear')),
      grantKey(host('linear')),
    ]);
    expect(keys.size).toBe(3);
  });

  test("a host's key ignores the session it was raised on", () => {
    // The person is answering a question about a SITE. Two sessions blocked on
    // the same host is still one question; the newer session id wins for the
    // POST, which `raise` handles by replacing in place.
    expect(grantKey(host('example.org', 's-1'))).toBe(
      grantKey(host('example.org', 's-2')),
    );
  });
});

describe('raise — one grant, one row', () => {
  test('two different grants both appear, in arrival order', () => {
    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.raise(host('example.org'), from());

    expect(getWorkspaceGrantSnapshot().grants.map((g) => g.key)).toEqual([
      'skill:linear',
      'host:example.org',
    ]);
  });

  test('the same grant arriving twice produces one row, not two', () => {
    // The SSE buffer replays a pending card on reconnect (TASK-82), so this is
    // the ordinary case, not a rare one.
    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.raise(skill('linear'), from());

    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(1);
  });

  test('a repeat replaces in place — it keeps its position and takes the newer payload', () => {
    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.raise(host('example.org', 's-1'), from());
    workspaceGrantActions.raise(skill('linear'), from());
    // Re-raised with a fresher session; the POST must target that one.
    workspaceGrantActions.raise(host('example.org', 's-2'), from());

    const grants = getWorkspaceGrantSnapshot().grants;
    expect(grants.map((g) => g.key)).toEqual(['skill:linear', 'host:example.org']);
    const raised = grants[1]?.request;
    expect(raised?.kind === 'host' && raised.sessionId).toBe('s-2');
  });
});

describe('raise — the origin rides along (TASK-351)', () => {
  test('the agent that asked is recorded, so presence can route the row', () => {
    workspaceGrantActions.raise(skill('linear'), from('a-quill'));

    expect(getWorkspaceGrantSnapshot().grants[0]?.agentId).toBe('a-quill');
  });

  test('two agents asking for the SAME subject is still one row', () => {
    // Identity is the subject, not the (subject, agent) pair. Keying on the
    // pair would put two rows in the queue for one question — which, with a
    // second render site added, is exactly the two live copies invariant 4
    // forbids. The newer origin wins, as the newer payload does.
    workspaceGrantActions.raise(connector('linear'), from('a-quill'));
    workspaceGrantActions.raise(connector('linear'), from('a-scout'));

    const grants = getWorkspaceGrantSnapshot().grants;
    expect(grants).toHaveLength(1);
    expect(grants[0]?.agentId).toBe('a-scout');
  });

  test('a re-raise cannot silently keep a stale origin', () => {
    // Both halves of the origin move together: the thread it routes to and
    // the conversation the answer POST targets came from the same producer,
    // and half-updating would answer the old turn from the new thread.
    workspaceGrantActions.raise(skill('linear'), from('a-quill', 'cnv-1'));
    workspaceGrantActions.raise(skill('linear'), from('a-scout', 'cnv-2'));

    const row = getWorkspaceGrantSnapshot().grants[0];
    expect(row?.agentId).toBe('a-scout');
    expect(row?.conversationId).toBe('cnv-2');
  });
});

describe('raise — TASK-113: the wall does not speak over the connector card', () => {
  test('a host grant is dropped while a connector grant is open', () => {
    // On a warm turn the upfront connector card and a same-turn reactive egress
    // wall both fire. The connector card is the ROOT CAUSE — the wall is
    // downstream of the same missing connector — so a second row would point at
    // a cause the first row already names.
    workspaceGrantActions.raise(connector('linear'), from());
    workspaceGrantActions.raise(host('api.linear.app'), from());

    expect(getWorkspaceGrantSnapshot().grants.map((g) => g.key)).toEqual([
      'connector:linear',
    ]);
  });

  test('a connector grant still arrives while a host grant is open', () => {
    // Connector wins both directions.
    workspaceGrantActions.raise(host('api.linear.app'), from());
    workspaceGrantActions.raise(connector('linear'), from());

    expect(getWorkspaceGrantSnapshot().grants.map((g) => g.key)).toEqual([
      'host:api.linear.app',
      'connector:linear',
    ]);
  });

  test('a host grant is NOT dropped while only a skill grant is open', () => {
    // The guard is exactly one condition. A skill card is not the wall's cause.
    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.raise(host('example.org'), from());

    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(2);
  });

  test('once the connector grant is resolved, the wall can be raised again', () => {
    workspaceGrantActions.raise(connector('linear'), from());
    workspaceGrantActions.raise(host('api.linear.app'), from());
    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(1);

    workspaceGrantActions.resolve('connector:linear');
    workspaceGrantActions.raise(host('api.linear.app'), from());

    expect(getWorkspaceGrantSnapshot().grants.map((g) => g.key)).toEqual([
      'host:api.linear.app',
    ]);
  });
});

describe('resolve and reset', () => {
  test('resolving removes exactly that row', () => {
    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.raise(skill('github'), from());
    workspaceGrantActions.resolve('skill:linear');

    expect(getWorkspaceGrantSnapshot().grants.map((g) => g.key)).toEqual([
      'skill:github',
    ]);
  });

  test('resolving a key that is not there changes nothing and does not notify', () => {
    workspaceGrantActions.raise(skill('linear'), from());
    const before = getWorkspaceGrantSnapshot().grants;
    const hits = vi.fn();
    const unsub = workspaceGrantActions.subscribeForTest(hits);

    workspaceGrantActions.resolve('skill:nope');

    expect(getWorkspaceGrantSnapshot().grants).toBe(before); // same reference
    expect(hits).not.toHaveBeenCalled();
    unsub();
  });

  test('reset empties the queue — evidence from one agent cannot speak for another', () => {
    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.reset();

    expect(getWorkspaceGrantSnapshot().grants).toEqual([]);
  });

  test('subscribers are notified on a change and released on unsubscribe', () => {
    const hits = vi.fn();
    const unsub = workspaceGrantActions.subscribeForTest(hits);

    workspaceGrantActions.raise(skill('linear'), from());
    expect(hits).toHaveBeenCalledTimes(1);

    unsub();
    workspaceGrantActions.raise(skill('github'), from());
    expect(hits).toHaveBeenCalledTimes(1);
  });
});
