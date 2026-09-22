import { createHash } from 'node:crypto';
import { MEMORY_FACTS_EXPORT_ROOT } from '@ax/core';

declare const factsPathBrand: unique symbol;

export type FactsPath =
  `${typeof MEMORY_FACTS_EXPORT_ROOT}/${string}` & {
    readonly [factsPathBrand]: true;
  };

export type FactsChange =
  | { path: FactsPath; kind: 'put'; content: Uint8Array }
  | { path: FactsPath; kind: 'delete' };

export function subjectSlug(subject: string): string {
  return /^[a-z0-9_-]{1,62}$/.test(subject)
    ? `v-${subject}`
    : `h-${createHash('sha256').update(subject).digest('hex').slice(0, 62)}`;
}

type FactsTarget =
  | { kind: 'profile' | 'recent' }
  | { kind: 'journal'; speaker: 'user' | 'assistant'; month: string }
  | { kind: 'subject'; subject: string };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function brand(path: string): FactsPath {
  return path as FactsPath;
}

export function factsPath(target: FactsTarget): FactsPath {
  switch (target.kind) {
    case 'profile':
      return brand(`${MEMORY_FACTS_EXPORT_ROOT}/profile.md`);
    case 'recent':
      return brand(`${MEMORY_FACTS_EXPORT_ROOT}/recent.md`);
    case 'journal': {
      if (!MONTH.test(target.month)) {
        throw new Error(`facts journal month must be YYYY-MM, got ${target.month}`);
      }
      return brand(
        `${MEMORY_FACTS_EXPORT_ROOT}/${target.speaker}/${target.month}.md`,
      );
    }
    case 'subject':
      return brand(
        `${MEMORY_FACTS_EXPORT_ROOT}/about/${subjectSlug(target.subject)}.md`,
      );
  }
}

const FACTS_PATH_RE = new RegExp(
  `^${MEMORY_FACTS_EXPORT_ROOT}/(` +
    `profile\\.md` +
    `|recent\\.md` +
    `|(?:user|assistant)/\\d{4}-(?:0[1-9]|1[0-2])\\.md` +
    `|about/(?:v-[a-z0-9_-]{1,62}|h-[0-9a-f]{62})\\.md` +
    `)$`,
);

export function parseFactsPath(path: string): FactsPath | undefined {
  return FACTS_PATH_RE.test(path) ? brand(path) : undefined;
}
