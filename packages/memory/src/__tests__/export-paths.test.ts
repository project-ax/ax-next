import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { MEMORY_FACTS_EXPORT_ROOT } from '@ax/core';

import {
  factsPath,
  parseFactsPath,
  subjectSlug,
  type FactsChange,
  type FactsPath,
} from '../export-paths.js';

const ROOT = MEMORY_FACTS_EXPORT_ROOT;

describe('subjectSlug', () => {
  it('passes a safe subject through under the v- namespace', () => {
    expect(subjectSlug('acme-corp')).toBe('v-acme-corp');
    expect(subjectSlug('a_b-9')).toBe('v-a_b-9');
  });

  it('hashes unsafe subjects under the h- namespace', () => {
    const slug = subjectSlug('../../rules');
    expect(slug).toMatch(/^h-[0-9a-f]{62}$/);
    expect(subjectSlug('Evil Corp!!')).toMatch(/^h-[0-9a-f]{62}$/);
    expect(subjectSlug('x'.repeat(400))).toMatch(/^h-[0-9a-f]{62}$/);
  });

  it('keeps the v- and h- namespaces disjoint, so no collision is possible', () => {
    expect(subjectSlug('safe')).toMatch(/^v-/);
    expect(subjectSlug('v-safe')).toBe('v-v-safe');
    expect(subjectSlug('unsafe subject')).toMatch(/^h-/);
  });

  it('is deterministic', () => {
    expect(subjectSlug('../../rules')).toBe(subjectSlug('../../rules'));
    expect(subjectSlug('a')).not.toBe(subjectSlug('b'));
  });
});

describe('factsPath', () => {
  it('builds the fixed profile and recent paths', () => {
    expect(factsPath({ kind: 'profile' })).toBe(`${ROOT}/profile.md`);
    expect(factsPath({ kind: 'recent' })).toBe(`${ROOT}/recent.md`);
  });

  it('builds journal paths under the speaker directory', () => {
    expect(factsPath({ kind: 'journal', speaker: 'user', month: '2026-09' })).toBe(
      `${ROOT}/user/2026-09.md`,
    );
    expect(
      factsPath({ kind: 'journal', speaker: 'assistant', month: '1900-01' }),
    ).toBe(`${ROOT}/assistant/1900-01.md`);
  });

  it('rejects a malformed month before assembly', () => {
    for (const month of ['2026-13', '2026-00', '26-09', '2026-9', '2026-09/extra', '../01']) {
      expect(() => factsPath({ kind: 'journal', speaker: 'user', month })).toThrow();
    }
  });

  it('builds subject paths under about/ with the slug', () => {
    expect(factsPath({ kind: 'subject', subject: 'acme' })).toBe(`${ROOT}/about/v-acme.md`);
    expect(factsPath({ kind: 'subject', subject: '../../rules' })).toMatch(
      new RegExp(`^${ROOT}/about/h-[0-9a-f]{62}\\.md$`),
    );
  });

  it('cannot produce rules.md or escape the root', () => {
    for (const subject of ['../../rules', '../..', 'system/rules', '..\\rules', '']) {
      const path: string = factsPath({ kind: 'subject', subject });
      expect(path.startsWith(`${ROOT}/about/`)).toBe(true);
      expect(path.endsWith('.md')).toBe(true);
      expect(path).not.toContain('..');
      expect(path).not.toBe(`${ROOT}/system/rules.md`);
    }
  });
});

describe('parseFactsPath', () => {
  it('round-trips every layout factsPath can build', () => {
    const paths = [
      factsPath({ kind: 'profile' }),
      factsPath({ kind: 'recent' }),
      factsPath({ kind: 'journal', speaker: 'user', month: '2026-09' }),
      factsPath({ kind: 'journal', speaker: 'assistant', month: '3000-12' }),
      factsPath({ kind: 'subject', subject: 'acme' }),
      factsPath({ kind: 'subject', subject: '../../rules' }),
    ];
    for (const path of paths) {
      expect(parseFactsPath(path)).toBe(path);
    }
  });

  it('rejects everything else', () => {
    const rejected = [
      `${ROOT}`,
      `${ROOT}/`,
      `${ROOT}/../rules.md`,
      `${ROOT}/system/rules.md`,
      `${ROOT}/user/2026-13.md`,
      `${ROOT}/user/2026-9.md`,
      `${ROOT}/user/../recent.md`,
      `${ROOT}/about/../../profile.md`,
      `${ROOT}/about/plain.md`,
      `${ROOT}/about/v-UPPER.md`,
      `${ROOT}/about/h-${'0'.repeat(61)}.md`,
      `${ROOT}/profile.md/extra`,
      `/${ROOT}/profile.md`,
      `permanent/memory/facts-backup/profile.md`,
      '',
      'permanent/memory/facts\\profile.md',
      `${ROOT}//profile.md`,
      `${ROOT}/profile.MD`,
    ];
    for (const path of rejected) {
      expect(parseFactsPath(path), path).toBeUndefined();
    }
  });
});

describe('FactsPath branding (type-level)', () => {
  it('a plain string is not a FactsPath, and the rules path is not one either', () => {
    expectTypeOf<string>().not.toExtend<FactsPath>();
    expectTypeOf<'permanent/memory/facts/profile.md'>().not.toExtend<FactsPath>();
    expectTypeOf<'permanent/memory/system/rules.md'>().not.toExtend<FactsPath>();
    expectTypeOf<'memory/system/rules.md'>().not.toExtend<FactsPath>();
  });

  it('a FactsChange path is a FactsPath, and a raw string cannot stand in for one', () => {
    expectTypeOf<FactsChange['path']>().toExtend<FactsPath>();
    expectTypeOf<string>().not.toExtend<FactsChange['path']>();
  });

  it('the type assertions above compile for real under tsc', { timeout: 30_000 }, () => {
    const tsc = createRequire(import.meta.url).resolve('typescript/lib/tsc.js');
    const file = fileURLToPath(new URL('./export-paths.test.ts', import.meta.url));
    execFileSync(
      process.execPath,
      [
        tsc,
        '--noEmit',
        '--ignoreConfig',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2022',
        '--strict',
        '--skipLibCheck',
        '--types',
        'node',
        file,
      ],
      { cwd: fileURLToPath(new URL('../..', import.meta.url)), timeout: 30_000, stdio: 'pipe' },
    );
  });
});
