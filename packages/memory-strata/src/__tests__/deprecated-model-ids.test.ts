/**
 * A dead model id fails CLOSED into a silent BM25 fallback, so it is worth a
 * lint rather than a code review.
 *
 * Three ids have now gone deprecated under this package while still being
 * referenced by it, and each time the symptom was the same: an arm that looks
 * like it is measuring something is really returning 404 on every call.
 * `x-ai/grok-4.1-fast` sat in the accuracy bench as the default model of
 * `makeOpenRouterOrchestratorClient` AND as a `PRICING` key AND as the
 * cost-meter key for `--orchestrator-model grok`, four months after this
 * repo's own probe recorded it as deprecated.
 *
 * This scans for the id as a STRING LITERAL, not as prose: the reports and
 * comments that record what was measured on a since-retired model are history
 * and must keep naming it. `orchestrator-client.ts` says the 11s p50 "was
 * `x-ai/grok-4.1-fast`" in backticks, which is exactly the distinction — that
 * sentence is true and has to stay, while a quoted id is something we might
 * actually send.
 *
 * Two honest limits, so nobody reads this as more than it is:
 *
 *  - The test is "quote char vs backtick", not "code vs prose". A backticked
 *    template literal with no interpolation is a perfectly good model string
 *    and would slip through; a comment written with straight quotes would trip
 *    it. Neither happens today, and the trade buys the ability to keep history
 *    readable, but the guarantee is narrower than "no dead id can reach a wire".
 *  - The scan is PACKAGE-LOCAL and `.ts`-only: `src/` and `test/` under
 *    @ax/memory-strata. A dead id in a chart value, a preset, or another
 *    package is invisible to it. A repo-wide ESLint rule under
 *    `test:eslint-rules` would be the stronger home if this ever needs to cover
 *    more than the bench.
 *
 * To retire another id: add it here, then run the suite and fix what it names.
 */
import { describe, expect, it } from 'vitest';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Confirmed dead against a live `GET /api/v1/models` — see each entry's note. */
const DEPRECATED_MODEL_IDS: ReadonlyArray<{ id: string; note: string }> = [
  {
    id: 'x-ai/grok-4.1-fast',
    note: 'absent from the OpenRouter catalogue; POST returns 404 "Grok 4.1 Fast is deprecated. xAI recommends switching to Grok 4.3" (verified 2026-09-11)',
  },
  {
    id: 'x-ai/grok-4-fast',
    note: 'absent from the OpenRouter catalogue; 404 on every call (recorded 2026-09-10)',
  },
];

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCAN_ROOTS = ['src', 'test'];
const THIS_FILE = 'deprecated-model-ids.test.ts';

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    // lstat, not stat: a symlinked directory would otherwise be recursed into
    // (double-reporting, or looping) and a broken one would throw mid-walk.
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (entry.endsWith('.ts') && entry !== THIS_FILE) {
      yield full;
    }
  }
}

describe('deprecated model ids', () => {
  it.each(DEPRECATED_MODEL_IDS)(
    'never appears as a string literal: $id',
    ({ id, note }) => {
      // Quoted only. Backticked/prose mentions are the historical record and
      // are deliberately allowed — see this file's header.
      const quoted = new RegExp(`['"]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
      const offenders: string[] = [];
      for (const root of SCAN_ROOTS) {
        for (const file of walkTsFiles(join(PACKAGE_ROOT, root))) {
          const lines = readFileSync(file, 'utf8').split('\n');
          lines.forEach((line, i) => {
            if (quoted.test(line)) {
              offenders.push(`${file.slice(PACKAGE_ROOT.length)}:${i + 1}`);
            }
          });
        }
      }
      expect(offenders, `${id} is dead (${note}) but is still used as a value at:\n  ${offenders.join('\n  ')}`).toEqual([]);
    },
  );

  it('scans a non-trivial number of files, so a broken walk cannot pass vacuously', () => {
    // A typo'd SCAN_ROOTS actually throws ENOENT, so that is not the hole this
    // plugs. What it plugs is a walk that yields NOTHING without throwing — a
    // bad extension filter, an over-eager skip, a generator that returns early
    // — any of which would make every assertion above pass by scanning air.
    const count = SCAN_ROOTS.reduce(
      (n, root) => n + [...walkTsFiles(join(PACKAGE_ROOT, root))].length,
      0,
    );
    expect(count).toBeGreaterThan(50);
  });
});
