import { describe, expect, it } from 'vitest';
import {
  OAUTH_CLIENT_SECRET_SLOT,
  clientSecretScope,
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

  // The custom OAuth client secret is written once, by the author, and read by
  // whoever signs in. Where it is stored decides who can sign in.
  describe('clientSecretScope', () => {
    it('stores a workspace-key connector secret at the workspace, whoever wrote it', () => {
      for (const isAdmin of [true, false])
        for (const visibility of ['shared', 'private'] as const)
          expect(
            clientSecretScope({ isAdmin, keyMode: 'workspace', visibility }),
          ).toBe('global');
    });

    it('stores a shared admin connector secret at the workspace so everyone can sign in', () => {
      expect(
        clientSecretScope({
          isAdmin: true,
          keyMode: 'personal',
          visibility: 'shared',
        }),
      ).toBe('global');
    });

    it('keeps a private admin connector secret with its author', () => {
      expect(
        clientSecretScope({
          isAdmin: true,
          keyMode: 'personal',
          visibility: 'private',
        }),
      ).toBe('user');
    });

    it('keeps a non-admin connector secret with its author, shared or not', () => {
      for (const visibility of ['shared', 'private'] as const)
        expect(
          clientSecretScope({ isAdmin: false, keyMode: 'personal', visibility }),
        ).toBe('user');
    });
  });
});
