import { afterEach, describe, expect, it } from 'vitest';
import {
  getPermissionCardSnapshot,
  permissionCardActions,
  type PermissionRequest,
} from '../lib/permission-card-store';

const sample: PermissionRequest = {
  kind: 'skill',
  skillId: 'linear',
  description: 'Read your Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key' as const }],
};

describe('permission-card-store', () => {
  afterEach(() => permissionCardActions.reset());

  it('starts with no pending request', () => {
    expect(getPermissionCardSnapshot().request).toBeNull();
  });

  it('show() stores the request; dismiss() clears it', () => {
    permissionCardActions.show(sample);
    const req = getPermissionCardSnapshot().request;
    expect(req?.kind).toBe('skill');
    expect(req).toEqual(sample);
    permissionCardActions.dismiss();
    expect(getPermissionCardSnapshot().request).toBeNull();
  });

  it('show() stores a host-grant request (TASK-37)', () => {
    permissionCardActions.show({ kind: 'host', host: 'status.example.com', sessionId: 's1' });
    expect(getPermissionCardSnapshot().request).toEqual({
      kind: 'host',
      host: 'status.example.com',
      sessionId: 's1',
    });
    permissionCardActions.dismiss();
  });

  it('show() notifies subscribers', () => {
    let hits = 0;
    const unsub = permissionCardActions.subscribeForTest(() => {
      hits += 1;
    });
    permissionCardActions.show(sample);
    permissionCardActions.dismiss();
    unsub();
    expect(hits).toBe(2);
  });

  // -------------------------------------------------------------------------
  // TASK-113 — card precedence. On a WARM turn both the upfront `connector`
  // connect card and a reactive `host` egress-wall frame can fire in the same
  // turn. The single-slot store's blind last-write-wins showed the wall ("npm
  // 403") instead of the actionable "Connect <service>" card. The connect card
  // is the root cause; the wall is downstream of the same missing connector, so
  // the connector card must WIN.
  // -------------------------------------------------------------------------
  const connector: PermissionRequest = {
    kind: 'connector',
    connectorId: 'linear',
    name: 'Linear',
    hosts: ['api.linear.app'],
    slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' as const }],
    authored: true,
  };
  const wall: PermissionRequest = {
    kind: 'host',
    host: 'registry.npmjs.org',
    sessionId: 's1',
  };

  it('a reactive host wall does NOT clobber a showing connector card', () => {
    permissionCardActions.show(connector);
    permissionCardActions.show(wall);
    // The connector card survives — the user still sees "Connect Linear".
    expect(getPermissionCardSnapshot().request).toEqual(connector);
  });

  it('a connector card DOES replace a showing host wall (connector wins both directions)', () => {
    permissionCardActions.show(wall);
    permissionCardActions.show(connector);
    expect(getPermissionCardSnapshot().request).toEqual(connector);
  });

  it('a host wall still replaces a prior host/skill card (unchanged behavior)', () => {
    permissionCardActions.show(sample); // skill
    permissionCardActions.show(wall);
    expect(getPermissionCardSnapshot().request).toEqual(wall);
    permissionCardActions.show({ kind: 'host', host: 'other.example.com', sessionId: 's2' });
    expect(getPermissionCardSnapshot().request).toEqual({
      kind: 'host',
      host: 'other.example.com',
      sessionId: 's2',
    });
  });

  it('a connector card replaces a prior skill/connector card (unchanged behavior)', () => {
    permissionCardActions.show(sample); // skill
    permissionCardActions.show(connector);
    expect(getPermissionCardSnapshot().request).toEqual(connector);
    const other: PermissionRequest = { ...connector, connectorId: 'sf', name: 'Salesforce' };
    permissionCardActions.show(other);
    expect(getPermissionCardSnapshot().request).toEqual(other);
  });
});
