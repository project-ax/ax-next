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
});
