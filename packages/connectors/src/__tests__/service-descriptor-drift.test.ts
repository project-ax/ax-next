import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConnectorServiceDescriptorSchema } from '../types.js';

// A6 — drift guard, store side. The connector store re-declares the
// descriptor (its type-only stance on @ax/skills-parser's zod schema); the
// shared fixture lives with the canonical grammar and is read by a
// repo-relative path.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const fixture = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'packages', 'skills-parser', 'src', '__tests__', 'fixtures', 'service-descriptor-golden-vectors.json'),
    'utf-8',
  ),
) as { keys: string[]; vectors: Array<{ desc: string; value: unknown; expect: 'accept' | 'reject' }> };

describe('service descriptor golden vectors (store: @ax/connectors)', () => {
  it('the store schema has exactly the canonical keys', () => {
    expect(Object.keys(ConnectorServiceDescriptorSchema.shape).sort()).toEqual([...fixture.keys].sort());
  });

  it.each(fixture.vectors.map((x) => [x.desc, x] as const))('%s', (_d, x) => {
    expect(ConnectorServiceDescriptorSchema.safeParse(x.value).success).toBe(x.expect === 'accept');
  });
});
