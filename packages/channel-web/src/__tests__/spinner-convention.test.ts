// @vitest-environment node
/**
 * One spinner: the shadcn `Spinner` in `components/ui/spinner.tsx`.
 *
 * Before it was installed, seven call sites each spun lucide's loader icon by
 * hand — at 13, 14 and 16px, and only about half of them honouring reduced
 * motion. Same icon, seven slightly different spinners. This is the wall that
 * keeps a hand-rolled one from creeping back: a component that wants a loading
 * indicator renders `<Spinner />` and overrides only size, colour or label.
 *
 * `animate-spin` is banned outside the component for the same reason — a
 * spinning `RefreshCw` is still a hand-rolled spinner.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, '..');
const SPINNER_FILE = join(SRC_DIR, 'components', 'ui', 'spinner.tsx');

/** Every non-test .ts/.tsx under src/, at any depth. */
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
      out.push({ file: relative(SRC_DIR, full), src: readFileSync(full, 'utf-8') });
    }
  };
  walk(SRC_DIR);
  return out;
}

/** lucide exports the one loader icon under all of these names. */
const LOADER_ICON = /\b(Lucide)?(Loader2|LoaderCircle)(Icon)?\b/;

describe('spinners', () => {
  it('sweep a real tree, so an empty sweep cannot pass', () => {
    const files = sources().map((f) => f.file);
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(join('components', 'ui', 'spinner.tsx'));
  });

  it('are all the shadcn Spinner — no hand-rolled loader icon or animate-spin', () => {
    const offenders = sources()
      .filter(({ file }) => join(SRC_DIR, file) !== SPINNER_FILE)
      .filter(({ src }) => LOADER_ICON.test(src) || /\banimate-spin\b/.test(src))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('honour reduced motion, in the one place that decides it', () => {
    expect(readFileSync(SPINNER_FILE, 'utf-8')).toContain('motion-reduce:animate-none');
  });
});
