// @vitest-environment node
/**
 * Rows and status, one way (S4, rules 8, 10, 11): rows come from `List` /
 * `ListRow` (which own the dividers), a waiting-on-you item is the warning
 * diamond from `StatusMark`, and a moment in time is a `Timestamp`.
 *
 * This is the wall that keeps the old hand-rolled versions from creeping back:
 *   - `rounded-full bg-warning`  a hand-rolled waiting dot
 *   - `divide-y` / `last:border-b-0`  a row drawing its own divider
 *   - `toLocale(Date|Time)?String(`  a moment formatted by hand
 *
 * Comments are stripped before scanning. `components/ui/` and tests are skipped.
 * Allow-lists are by exact file, each with the reason it is not a row or a
 * moment. Add to them only for a real exception.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, '..');

function sources(): Array<{ file: string; src: string }> {
  const out: Array<{ file: string; src: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && full !== join(SRC_DIR, 'components', 'ui')) walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      const raw = readFileSync(full, 'utf-8');
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
      out.push({ file: relative(SRC_DIR, full), src });
    }
  };
  walk(SRC_DIR);
  return out;
}

// `rounded-full` and `bg-warning` in either order inside one quoted class string.
const WAITING_DOT = /(['"`])(?:(?!\1)[^])*?(?:rounded-full(?:(?!\1)[^])*?bg-warning|bg-warning(?:(?!\1)[^])*?rounded-full)/;
const OWN_DIVIDER = /divide-y|last:border-b-0/;
const HAND_FORMATTED_MOMENT =
  /\.toLocale(?:Date|Time)?String\(|\[\s*['"`]toLocale(?:Date|Time)?String['"`]\s*\]|\bIntl\s*\.\s*(?:DateTimeFormat|RelativeTimeFormat)\b/;

/** Exact files that may call toLocale*String( — and why. Anything else fails. */
const LOCALE_KEEPERS: Record<string, string> = {
  'components/workspace/WorkspaceShell.tsx': 'today(): the "Monday, 3 March" day heading, not a moment on a row',
  'components/admin/StorageTab.tsx': 'a count of owners (a number with thousands separators)',
  'components/admin/BundleDiffView.tsx': 'a count of hidden diff lines',
  'lib/storage-copy.ts': 'counts in storage sentences',
  'lib/usage-copy.ts': 'dollar and token amounts',
  'lib/task-row-line.ts': 'Intl.DateTimeFormat in UTC: a calendar-day label for a schedule, not a moment',
  'lib/task-meta.ts': 'Intl.DateTimeFormat in UTC: a calendar-day label, not a moment',
  'lib/task-finish-by.ts': 'Intl.DateTimeFormat in UTC: a calendar-day "finish by" date, not a moment',
};

/** Exact files that may use divide-y / last:border-b-0 — and why. Currently none. */
const DIVIDER_KEEPERS: Record<string, string> = {};

function offenders(pattern: RegExp, allow: Record<string, string>): string[] {
  return sources()
    .filter(({ file, src }) => pattern.test(src) && !(file in allow))
    .map(({ file }) => file);
}

describe('rows and status', () => {
  it('sweep a real tree, so an empty sweep cannot pass', () => {
    expect(sources().length).toBeGreaterThan(50);
  });

  it('has no hand-rolled waiting dot: use StatusMark tone="warning"', () => {
    expect(offenders(WAITING_DOT, {})).toEqual([]);
  });

  it('has no row drawing its own divider: List owns them', () => {
    expect(offenders(OWN_DIVIDER, DIVIDER_KEEPERS)).toEqual([]);
  });

  it('formats a moment with Timestamp, not toLocale*String', () => {
    expect(offenders(HAND_FORMATTED_MOMENT, LOCALE_KEEPERS)).toEqual([]);
  });

  it('keeps no stale allow-list entries', () => {
    const files = new Map(sources().map((s) => [s.file, s.src]));
    for (const f of Object.keys(LOCALE_KEEPERS)) expect(HAND_FORMATTED_MOMENT.test(files.get(f) ?? ''), f).toBe(true);
    for (const f of Object.keys(DIVIDER_KEEPERS)) expect(OWN_DIVIDER.test(files.get(f) ?? ''), f).toBe(true);
  });

  it('the patterns bite', () => {
    for (const bad of ['"h-2 w-2 rounded-full bg-warning"', '"rounded-full  bg-warning"', '"bg-warning h-2 rounded-full"', "`size-2 bg-warning/80 rounded-full`"]) {
      expect(WAITING_DOT.test(bad), bad).toBe(true);
    }
    expect(WAITING_DOT.test('"rounded-full bg-muted" + "bg-warning"')).toBe(false);
    for (const bad of ['<ul className="divide-y">', 'className="border-b last:border-b-0"']) expect(OWN_DIVIDER.test(bad), bad).toBe(true);
    for (const bad of ['d.toLocaleString()', 'd.toLocaleDateString("en")', 'd.toLocaleTimeString(undefined, {})', "d['toLocaleString']()", 'new Intl.DateTimeFormat("en")', 'new Intl.RelativeTimeFormat()']) {
      expect(HAND_FORMATTED_MOMENT.test(bad), bad).toBe(true);
    }
    expect(WAITING_DOT.test('rounded-full bg-muted')).toBe(false);
    expect(OWN_DIVIDER.test('border-b')).toBe(false);
  });
});
