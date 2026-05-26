import { describe, it, expect } from 'vitest';
import { validateAttachmentBindings } from '../attachment-validation.js';

describe('validateAttachmentBindings', () => {
  it('accepts bindings that exactly match the declared slots', () => {
    expect(
      validateAttachmentBindings(['GITHUB_TOKEN'], { GITHUB_TOKEN: 'ref' }),
    ).toEqual({ ok: true });
  });

  it('accepts an inert skill (no slots, no bindings)', () => {
    expect(validateAttachmentBindings([], {})).toEqual({ ok: true });
  });

  it('rejects a binding for an undeclared slot (orphan)', () => {
    const r = validateAttachmentBindings(['GITHUB_TOKEN'], { GITHUB_TOKEN: 'ref', EXTRA: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('binding-orphan');
  });

  it('rejects a declared slot with no binding (missing)', () => {
    const r = validateAttachmentBindings(['GITHUB_TOKEN', 'OTHER'], { GITHUB_TOKEN: 'ref' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('binding-missing');
  });

  it('orphan check runs before missing check (deterministic precedence)', () => {
    // Both an orphan (EXTRA) and a missing slot (OTHER) are present; orphan wins.
    const r = validateAttachmentBindings(['OTHER'], { EXTRA: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('binding-orphan');
  });
});
