import { afterEach, describe, expect, it } from 'vitest';
import {
  getPermissionCardSnapshot,
  permissionCardActions,
} from '../lib/permission-card-store';

const sample = {
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
    expect(getPermissionCardSnapshot().request?.skillId).toBe('linear');
    permissionCardActions.dismiss();
    expect(getPermissionCardSnapshot().request).toBeNull();
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
