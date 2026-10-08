import { describe, expect, it } from 'vitest';
import {
  CLIENT_SECRET_NEEDS_SHARED,
  OAUTH_CLIENT_SECRET_SLOT,
  newHeaderSlot,
} from '../connector-credential-slots';

// TASK-762 — the shapes the editors mint. Whether the server ACCEPTS them is
// pinned against the real route in connector-credential-slots.contract.test.ts
// (TASK-767), not against a copy of its regex.
describe('connector credential slots', () => {
  it('mints header slots as HEADER_<32 uppercase hex>', () => {
    for (let i = 0; i < 50; i++) {
      const slot = newHeaderSlot();
      expect(slot).toMatch(/^HEADER_[0-9A-F]{32}$/);
    }
  });

  it('mints a distinct slot per header', () => {
    const slots = new Set(Array.from({ length: 50 }, () => newHeaderSlot()));
    expect(slots.size).toBe(50);
  });

  it('names the OAuth client secret slot', () => {
    expect(OAUTH_CLIENT_SECRET_SLOT).toBe('OAUTH_CLIENT_SECRET');
  });

  // Slice 5 — the custom OAuth client secret is always the workspace's
  // (global): nothing is stored per person. A private connector can't carry one.
  it('tells the admin how to use a client secret on a private connector', () => {
    expect(CLIENT_SECRET_NEEDS_SHARED).toBe('Make it Shared to use a client secret.');
  });
});
