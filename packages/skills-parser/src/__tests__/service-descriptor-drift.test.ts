import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ServiceDescriptorSchema } from '../index.js';

// A6 — drift guard, canonical side. The fixture lives here, with the grammar;
// @ax/connectors, @ax/sandbox-protocol and @ax/skill-broker read it by a
// repo-relative path (the R34 / ARCH-11 pattern) and assert the same keys and
// verdicts on their own copies.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'service-descriptor-golden-vectors.json'), 'utf-8'),
) as {
  keys: string[];
  full: Record<string, unknown>;
  alternates: Record<string, unknown>;
  vectors: Array<{ desc: string; value: unknown; expect: 'accept' | 'reject' }>;
};

describe('service descriptor golden vectors (canonical: @ax/skills-parser)', () => {
  it('the schema has exactly the canonical keys', () => {
    expect(Object.keys(ServiceDescriptorSchema.shape).sort()).toEqual([...fixture.keys].sort());
  });

  it('`full` and `alternates` cover every key, and every alternate is valid', () => {
    expect(Object.keys(fixture.full).sort()).toEqual([...fixture.keys].sort());
    expect(Object.keys(fixture.alternates).sort()).toEqual([...fixture.keys].sort());
    for (const key of fixture.keys) {
      expect(ServiceDescriptorSchema.safeParse({ ...fixture.full, [key]: fixture.alternates[key] }).success).toBe(true);
    }
  });

  it.each(fixture.vectors.map((x) => [x.desc, x] as const))('%s', (_d, x) => {
    expect(ServiceDescriptorSchema.safeParse(x.value).success).toBe(x.expect === 'accept');
  });
});
