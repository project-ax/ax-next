import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseServiceForwards } from '../bootstrap.js';

// ARCH-11 drift guard, schema side. `parseServiceForwards` (host contract) and
// the runner's local `parseServiceForwardsEnv` (@ax/agent-runner-core, which
// must not import this package) run ONE shared fixture. The runner side is
// agent-runner-core's `service-forwards-drift.test.ts`. A verdict that flips on
// either side turns one suite red. The vectors cover the 64-pair cap, the
// 4096-char cap and the self/cycle/chain refusal.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'service-forwards-golden-vectors.json'), 'utf-8'),
) as { vectors: Array<{ desc: string; value: string; expect: 'accept' | 'reject' }> };

describe('service forwards golden vectors (schema side)', () => {
  it('has the vectors for every cap', () => {
    const descs = fixture.vectors.map((x) => x.desc).join('|');
    for (const needle of ['65 pairs', '4097 chars', 'self-forward', 'cycle', 'chain']) expect(descs).toContain(needle);
  });
  it.each(fixture.vectors.map((x) => [x.desc, x] as const))('%s', (_d, x) => {
    expect(parseServiceForwards(x.value) !== null).toBe(x.expect === 'accept');
  });
});
