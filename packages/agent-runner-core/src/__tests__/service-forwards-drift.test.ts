import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseServiceForwardsEnv } from '../env.js';

// ARCH-11 drift guard, runner side. The shared fixture lives with
// `@ax/sandbox-protocol`'s `parseServiceForwards`; this side reads it by a
// repo-root-relative path and does NOT import that package (the runner stays
// independent of the host contract; only standby.ts may import it). The schema
// side is sandbox-protocol's `service-forwards-drift.test.ts`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/agent-runner-core/src/__tests__ -> repo root
const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const fixture = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'packages', 'sandbox-protocol', 'src', '__tests__', 'fixtures', 'service-forwards-golden-vectors.json'),
    'utf-8',
  ),
) as { vectors: Array<{ desc: string; value: string; expect: 'accept' | 'reject' }> };

describe('service forwards golden vectors (runner side)', () => {
  it.each(fixture.vectors.map((x) => [x.desc, x] as const))('%s', (_d, x) => {
    expect(parseServiceForwardsEnv(x.value) !== null).toBe(x.expect === 'accept');
  });
});
