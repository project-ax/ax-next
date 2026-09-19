/**
 * TASK-405 — which slices of a markdown source survive into the rendered text.
 *
 * This module is the hinge the whole count-vs-marks claim now hangs on, so the
 * tests are about the EDGES rather than about "bold works". The interesting
 * cases are the ones where a source offset would point at the wrong characters
 * if anybody trusted it: a code span whose value is shorter than its span, a
 * fenced block, and a paragraph containing a backslash escape or a character
 * reference (where the whole paragraph's value differs from its slice).
 *
 * `markdownTextRuns` and the highlight plugin apply the SAME predicate to two
 * different trees — mdast here, hast in the renderer — so the render tests in
 * `AgentConversationMarkdown.test.tsx` are the other half of this file: these
 * pin what is counted, those pin what is painted, and the pair is what makes
 * "two readings of one result" a measured claim rather than a comment.
 */
import { describe, expect, it } from 'vitest';
import { isRenderedRange, markdownTextRuns } from '@/lib/markdown-find';
import { findRanges, markdownFindRanges } from '@/lib/thread-find';

/** The runs as the substrings they stand for — far easier to read than offsets. */
const runsOf = (src: string): string[] =>
  markdownTextRuns(src).map((r) => src.slice(r.start, r.end));

describe('markdownTextRuns', () => {
  it('keeps the visible words of an emphasised run and drops its asterisks', () => {
    expect(runsOf('The build is **green** today.')).toEqual([
      'The build is ',
      'green',
      ' today.',
    ]);
  });

  it('keeps a table’s cells and drops its pipes and rule', () => {
    expect(runsOf('| env | status |\n| --- | --- |\n| prod | green |')).toEqual([
      'env',
      'status',
      'prod',
      'green',
    ]);
  });

  it('keeps a link’s label and drops its destination', () => {
    // The destination is text a reader never sees, so a match in it could
    // never be marked. Counting it is the drift; dropping it is the fix.
    expect(runsOf('see [the report](https://deploy.test/report)')).toEqual([
      'see ',
      'the report',
    ]);
  });

  it('drops an image entirely — its alt text is not a source-mapped run', () => {
    /*
      `Markdown.tsx` renders the alt text instead of fetching the image, so
      those words ARE on screen and are NOT findable. Under-count, never
      over-count: the bar can still never name a match nobody can see. Pinned
      because it is the accepted gap this design chose, not an oversight.
    */
    expect(runsOf('![a chart](https://x.test/p.png)')).toEqual([]);
  });

  it('drops a code span and a fenced block — their values are not their slices', () => {
    expect(runsOf('run `pnpm build` first')).toEqual(['run ', ' first']);
    expect(runsOf('```js\nconst x = 1;\n```')).toEqual([]);
  });

  it('drops a paragraph whose text carries an escape or an entity', () => {
    /*
      The guard that makes the whole scheme safe. mdast unescapes into `value`
      while `position` still spans the escaped source, so offsets inside such a
      node point one or more characters to the left of the truth — exactly the
      "confidently misplaced highlight" `findRanges` refuses elsewhere.
    */
    expect(runsOf('Escaped \\*not bold\\* here')).toEqual([]);
    expect(runsOf('AT&amp;T shipped')).toEqual([]);
  });

  it('returns the same array for the same source, so the cache cannot drift', () => {
    const src = 'a **b** c';
    expect(markdownTextRuns(src)).toBe(markdownTextRuns(src));
  });
});

describe('isRenderedRange', () => {
  const src = 'The build is **green** today.';
  const runs = markdownTextRuns(src);
  const at = (needle: string) => findRanges(src, needle)[0]!;

  it('accepts a match that sits wholly inside one run', () => {
    expect(isRenderedRange(at('green'), runs)).toBe(true);
    expect(isRenderedRange(at('build'), runs)).toBe(true);
  });

  it('rejects a match made only of markup', () => {
    expect(isRenderedRange(at('**'), runs)).toBe(false);
  });

  it('rejects a match that straddles markup, which would need two marks', () => {
    expect(isRenderedRange(at('is **g'), runs)).toBe(false);
  });
});

describe('markdownFindRanges', () => {
  it('is findRanges minus the matches that could never be painted', () => {
    const src = 'The build is **green** today, and green again.';

    // The raw matcher finds both — it is looking at a string.
    expect(findRanges(src, 'green')).toHaveLength(2);
    expect(markdownFindRanges(src, 'green')).toHaveLength(2);

    // …and finds two `**` that the reader will never see.
    expect(findRanges(src, '**')).toHaveLength(2);
    expect(markdownFindRanges(src, '**')).toHaveLength(0);
  });

  it('keeps the ranges in source order, which is what numbers the marks', () => {
    const src = '# One\n\nsomething **one** else\n\n| one |\n| --- |\n| x |';
    const hits = markdownFindRanges(src, 'one');
    expect(hits.map((r) => r.start)).toEqual(
      [...hits.map((r) => r.start)].sort((a, b) => a - b),
    );
    // Heading, the bold run, and the table cell: three visible "one"s.
    expect(hits).toHaveLength(3);
  });

  it('short-circuits an empty query without parsing anything', () => {
    expect(markdownFindRanges('**anything**', '')).toEqual([]);
  });
});
