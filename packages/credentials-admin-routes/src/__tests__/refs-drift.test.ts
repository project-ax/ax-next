import { describe, expect, it } from 'vitest';
import { KNOWN_DESTINATION_FIXTURES } from '@ax/credentials';
import { refForDestination } from '../destination-routes.js';

// Drift guard for the file-local `refForDestination` in destination-routes.ts.
// Cross-plugin runtime imports of @ax/credentials are forbidden (CLAUDE.md
// invariant 2), so this file is one of three intentional copies. If the
// canonical version in @ax/credentials/src/refs.ts ever changes the ref
// shape for any destination kind, this test will fail.

describe('destination-routes refForDestination — drift guard', () => {
  it('matches KNOWN_DESTINATION_FIXTURES from @ax/credentials', () => {
    for (const { destination, expectedRef } of KNOWN_DESTINATION_FIXTURES) {
      expect(refForDestination(destination)).toBe(expectedRef);
    }
  });
});
