// @vitest-environment node
/**
 * One state language (S3, rule 7): loading, error and empty states come from
 * `@project-ax/ui` (AsyncState / EmptyState / Notice), and a failed read offers
 * "Try again" — never a per-screen retry dialect.
 *
 * This is the wall that keeps the old dialects from creeping back: "Retry",
 * "Retry <thing>", "Check again" and "Reload app setup" as button text, and the
 * toast-with-action plumbing (`toastActions` / `toast-store`) that carried them.
 * Allowed on purpose: "Reload page", "Reload and discard my changes", UsageTab's
 * "Refresh", and RoutinesList's error-banner "Refresh" (a re-read, not a retry).
 *
 * Comments are stripped before scanning, so prose that explains the old
 * dialects does not trip it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, '..');

/** Every non-test .ts/.tsx under src/, at any depth, with comments removed. */
function sources(): Array<{ file: string; src: string }> {
  const out: Array<{ file: string; src: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      const raw = readFileSync(full, 'utf-8');
      // Block comments, then line comments that start a line or follow whitespace
      // (so `https://` in a string survives). JSX text is not touched.
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
      out.push({ file: relative(SRC_DIR, full), src });
    }
  };
  walk(SRC_DIR);
  return out;
}

/** JSX text: `>Retry<`, `>Retry the upload<`, `>Check again<`, `>Reload app setup<`. */
const BANNED_BUTTON_TEXT = />\s*(Retry(\s+[\w-]+)*[.…]?|Check again|Reload app setup)\s*</;
/** A label passed as a string: `label: 'Retry'`, `label: "Retry …"`, `label="Check again"`, `label: 'Reload app setup'`. */
const BANNED_STRING_LABEL = /\blabel\s*[:=]\s*\{?\s*['"`]\s*(Retry\b[^'"`]*|Check again|Reload app setup)['"`]/;
const BANNED_PLUMBING = /\btoastActions\b|toast-store/;

describe('state language', () => {
  it('sweep a real tree, so an empty sweep cannot pass', () => {
    expect(sources().length).toBeGreaterThan(50);
  });

  it('offers "Try again", never Retry / Check again / Reload app setup', () => {
    const offenders = sources()
      .filter(({ src }) => BANNED_BUTTON_TEXT.test(src))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('offers "Try again" in string action labels too, never Retry / Check again', () => {
    const offenders = sources()
      .filter(({ src }) => BANNED_STRING_LABEL.test(src))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('the patterns bite: they match the dialects they ban and spare "Try again"', () => {
    for (const bad of ["label: 'Retry'", 'label: "Retry …"', "label: 'Retry upload'", "label: 'Check again'", 'label="Check again"', "label: 'Reload app setup'"]) {
      expect(BANNED_STRING_LABEL.test(bad), bad).toBe(true);
    }
    for (const bad of ['>Retry.<', '> Retry <', '>Retry the upload<', '>Retry…<', '>Check again<']) {
      expect(BANNED_BUTTON_TEXT.test(bad), bad).toBe(true);
    }
    for (const ok of ["label: 'Try again'", "label: 'Reload page'", "label: 'Refresh'"]) {
      expect(BANNED_STRING_LABEL.test(ok), ok).toBe(false);
    }
    expect(BANNED_BUTTON_TEXT.test('>Try again<')).toBe(false);
  });

  it('has no toast-with-action plumbing', () => {
    const offenders = sources()
      .filter(({ src }) => BANNED_PLUMBING.test(src))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
