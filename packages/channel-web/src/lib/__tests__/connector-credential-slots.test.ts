import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_SLOT_RE,
  OAUTH_CLIENT_SECRET_SLOT,
  newHeaderSlot,
} from '../connector-credential-slots';

// TASK-762 — the slots the editors mint must pass the destination-credential
// route's slot grammar, or every save of a header / client secret is a 400.
describe('connector credential slots', () => {
  it('mints header slots in the SCREAMING_SNAKE slot grammar', () => {
    for (let i = 0; i < 50; i++) {
      const slot = newHeaderSlot();
      expect(slot).toMatch(/^HEADER_[0-9A-F]{32}$/);
      expect(slot).toMatch(CONNECTOR_SLOT_RE);
    }
  });

  it('mints a distinct slot per header', () => {
    const slots = new Set(Array.from({ length: 50 }, () => newHeaderSlot()));
    expect(slots.size).toBe(50);
  });

  it('names the OAuth client secret slot in the grammar', () => {
    expect(OAUTH_CLIENT_SECRET_SLOT).toMatch(CONNECTOR_SLOT_RE);
  });

  it('mirrors the route grammar exactly (the shapes it refuses stay refused)', () => {
    expect(CONNECTOR_SLOT_RE.source).toBe('^[A-Z][A-Z0-9_]{0,63}$');
    for (const bad of [
      'header-0f3c',
      'oauth-client-secret',
      'HEADER-1',
      '_HEADER',
      '1HEADER',
      'A'.repeat(65),
      'ACCOUNT:X',
    ])
      expect(bad).not.toMatch(CONNECTOR_SLOT_RE);
  });
});
