/**
 * Reading a rendered tree's heading OUTLINE, and saying what is wrong with it.
 *
 * Written for TASK-446, where the measured defect was that `AgentView` rendered
 * no headings at all and no surface in the Settings shell rendered an `h1`. The
 * trap in fixing that is not adding the tag — it is that a wrong outline is
 * worse than an absent one. Someone navigating by heading gets a map; two `h1`s
 * or an `h2` that jumps to an `h4` hands them a map of a building that is not
 * the one they are standing in.
 *
 * So the guard is deliberately shaped to fail in every direction, because each
 * of these has a way of passing a test that only asked "is there a heading?":
 *
 *   - NO HEADINGS AT ALL. The vacuous pass. `queryAllByRole('heading')` on a
 *     page with none returns `[]`, and every "for each heading, assert X" loop
 *     over `[]` is green. This is the exact defect the card is about, so a
 *     guard that misses it guards nothing.
 *   - MORE THAN ONE `h1`.
 *   - NOT STARTING AT THE TOP LEVEL. A body whose first heading is an `h3` has
 *     skipped two levels before it began.
 *   - A SKIPPED LEVEL ON THE WAY DOWN. `h2` → `h4`. (Coming back UP is fine and
 *     normal: `h3` → `h2` just closes a section.)
 *
 * jsdom has no CSS and no layout, so anything about how a heading LOOKS is
 * unmeasurable here — but heading elements, their levels and their DOM order
 * are real, which is what an outline is made of.
 */

/** Matches native headings and the ARIA spelling, so neither can hide. */
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"]';

interface Heading {
  level: number;
  text: string;
}

function levelOf(el: Element): number {
  const aria = el.getAttribute('aria-level');
  if (aria !== null) {
    const n = Number.parseInt(aria, 10);
    if (Number.isFinite(n)) return n;
  }
  const native = /^H([1-6])$/.exec(el.tagName);
  // A `role="heading"` with no usable `aria-level` is level 2 per ARIA. It is
  // also a thing we never want to write; the outline reports it as-is rather
  // than throwing, so a test can say so in its own words.
  return native !== null ? Number(native[1]) : 2;
}

function headings(root: ParentNode): Heading[] {
  return Array.from(root.querySelectorAll(HEADING_SELECTOR)).map((el) => ({
    level: levelOf(el),
    text: (el.textContent ?? '').trim(),
  }));
}

/**
 * The outline in DOM order, as `"h2: Granted by you"` lines — the form a failed
 * `toEqual` prints legibly.
 */
export function headingOutline(root: ParentNode = document.body): string[] {
  return headings(root).map((h) => `h${h.level}: ${h.text}`);
}

/** Just the levels, for asserting shape without pinning fixture copy. */
export function headingLevels(root: ParentNode = document.body): number[] {
  return headings(root).map((h) => h.level);
}

/**
 * Everything wrong with the outline, as sentences. `[]` means correct.
 *
 * @param topLevel the level the tree is expected to open at. `1` for a whole
 *   page; a component rendered on its own is a FRAGMENT of someone else's page
 *   and opens at whatever level its host gives it (`ConnectorsTab` sits under
 *   the Settings pane's `h1`, so it opens at `2`).
 */
export function headingOutlineProblems(
  root: ParentNode = document.body,
  topLevel = 1,
): string[] {
  const found = headings(root);
  const problems: string[] = [];

  if (found.length === 0) {
    // Returned ALONE: with no headings every other rule is vacuously true, and
    // listing "and it does not start at h1" underneath would only bury it.
    return ['renders no headings at all'];
  }

  const firstLevel = found[0]?.level ?? 0;
  if (firstLevel !== topLevel) {
    problems.push(
      `opens at h${firstLevel} ("${found[0]?.text ?? ''}"), expected h${topLevel}`,
    );
  }

  const h1s = found.filter((h) => h.level === 1);
  if (h1s.length > 1) {
    problems.push(
      `has ${h1s.length} h1s (${h1s.map((h) => `"${h.text}"`).join(', ')}); a page has exactly one`,
    );
  }

  const shallower = found.filter((h) => h.level < topLevel);
  for (const h of shallower) {
    problems.push(`h${h.level} ("${h.text}") is above the expected top level h${topLevel}`);
  }

  for (let i = 1; i < found.length; i += 1) {
    const prev = found[i - 1];
    const here = found[i];
    if (prev === undefined || here === undefined) continue;
    if (here.level > prev.level + 1) {
      problems.push(
        `h${prev.level} ("${prev.text}") skips to h${here.level} ("${here.text}")`,
      );
    }
  }

  return problems;
}
