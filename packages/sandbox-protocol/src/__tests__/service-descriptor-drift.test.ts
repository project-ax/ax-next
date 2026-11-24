import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ServiceDescriptorSchema } from '../schemas.js';

// A6 — drift guard, wire side. The wire re-declares the descriptor to
// re-validate at the trust boundary; the shared fixture lives with the
// canonical grammar in @ax/skills-parser and is read by a repo-relative path
// (no import of that package from here).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const fixture = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'packages', 'skills-parser', 'src', '__tests__', 'fixtures', 'service-descriptor-golden-vectors.json'),
    'utf-8',
  ),
) as { keys: string[]; vectors: Array<{ desc: string; value: unknown; expect: 'accept' | 'reject' }> };

describe('service descriptor golden vectors (wire: @ax/sandbox-protocol)', () => {
  it('the wire schema has exactly the canonical keys', () => {
    expect(Object.keys(ServiceDescriptorSchema.shape).sort()).toEqual([...fixture.keys].sort());
  });

  it.each(fixture.vectors.map((x) => [x.desc, x] as const))('%s', (_d, x) => {
    expect(ServiceDescriptorSchema.safeParse(x.value).success).toBe(x.expect === 'accept');
  });
});
