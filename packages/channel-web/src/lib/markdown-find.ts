/**
 * Where a markdown string's RENDERED text lives in its source (TASK-405).
 *
 * The agent bubble renders markdown now, and that puts find-in-thread in an
 * awkward spot. `findRanges` searches the markdown SOURCE — `**bold**`, pipes,
 * fences and link destinations and all — but a `<mark>` can only be painted
 * inside text the reader can actually see. The two sets are not the same, and
 * a count taken over the first while the marks are painted into the second is
 * exactly the drift `thread-find.ts` was written to make impossible.
 *
 * So this module answers one question, once, for both readers:
 *
 *   > which slices of the source survive into the rendered output?
 *
 * `thread-find.ts` uses the answer to decide what COUNTS. `ThreadFind.tsx` uses
 * it (through the same filtered range list) to decide what gets a MARK. Neither
 * computes it independently.
 *
 * WHY THE TWO SIDES PROVABLY AGREE. This module parses to **mdast** and keeps
 * every `text` node whose `source.slice(start, end) === node.value`. The
 * renderer's plugin below sees **hast** — the tree after `remark-rehype`, which
 * is what `react-markdown` hands its `rehypePlugins` — and applies the SAME
 * predicate. Those two node sets were measured to be identical over a document
 * containing bold, a GFM table, a list, inline code, a link, an image, a fenced
 * block, a backslash escape and a character reference:
 *
 *   mdast: 0-8,10-14,16-22,26-27,30-31,46-47,50-51,57-65,68-76,78-85,…
 *   hast : 0-8,10-14,16-22,26-27,30-31,46-47,50-51,57-65,68-76,78-85,…
 *
 * The slice-equality guard is the load-bearing half, not a nicety. A fenced
 * block's hast text node holds `const x = 1\n` while its position spans the
 * fences; an inline code span holds `foo` while its position spans the
 * backticks; a paragraph containing `\*` or `&amp;` holds the UNescaped text.
 * In every one of those cases `value !== slice`, so both sides drop the node
 * together and offsets are never used where they would point at the wrong
 * characters.
 *
 * THE GAP THIS LEAVES, stated rather than hidden: text that is rendered but is
 * not an mdast `text` node — an image's alt text, the inside of a code span or
 * fence, a paragraph carrying an escape or an entity — is VISIBLE BUT NOT
 * FINDABLE. That is an under-count and never an over-count, which is the
 * direction that cannot lie to a reader: the bar can never name a match that is
 * not on the screen. Same class of accepted gap as the collapsible `steps`
 * panel and a grant's description, both documented in `thread-find.ts`.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { FindRange } from '@/lib/thread-find';

/**
 * The shape of a tree node this module walks.
 *
 * Structural rather than imported from `mdast`/`hast`: those type packages are
 * dependencies of `remark-parse` and `react-markdown`, not of this package, and
 * naming them here would be a cross-package import of somebody else's
 * transitive dependency. All we need of a node is its type, its children, and
 * — for text — its value and its source position.
 */
interface TreeNode {
  type: string;
  value?: string;
  children?: TreeNode[];
  /** hast only, and only ever WRITTEN here — see `markElement`. */
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

/**
 * The processor, built ONCE.
 *
 * `remark-gfm` is not optional here: it changes what the tokenizer considers a
 * table cell, a strikethrough or an autolink, and therefore where text nodes
 * begin and end. The renderer runs `remark-gfm` (see `Markdown.tsx`), so an
 * index built without it would disagree about offsets on exactly the documents
 * this card is about.
 *
 * `.freeze()` because a unified processor that has been used cannot take
 * another `.use()`; freezing makes that explicit and makes reuse safe.
 */
const parser = unified().use(remarkParse).use(remarkGfm).freeze();

/**
 * Text runs are a pure function of the source, and the source is re-searched on
 * every keystroke — `buildFindIndex` walks the whole thread each time the query
 * changes. Without this, a 200-turn conversation re-parses 200 markdown
 * documents per typed letter.
 *
 * Bounded, and evicted oldest-first (a `Map` iterates in insertion order), so a
 * long-lived tab that has read a thousand turns does not hold a thousand parses
 * alive. The cap is generous relative to a thread and tiny relative to memory.
 */
const RUNS_CACHE_LIMIT = 256;
const runsCache = new Map<string, readonly FindRange[]>();

/**
 * True when `node`'s source span can be used as an offset map for its value.
 *
 * Both this module and the highlight plugin gate on it, which is what makes the
 * index and the marks agree (see the header).
 */
function isOffsetMapped(node: TreeNode, source: string): node is TreeNode & {
  value: string;
  position: { start: { offset: number }; end: { offset: number } };
} {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined) return false;
  if (typeof node.value !== 'string') return false;
  return source.slice(start, end) === node.value;
}

/** Depth-first, in document order. */
function collectTextRuns(
  node: TreeNode,
  source: string,
  out: FindRange[],
): void {
  if (node.type === 'text' && isOffsetMapped(node, source)) {
    out.push({ start: node.position.start.offset, end: node.position.end.offset });
    return;
  }
  for (const child of node.children ?? []) collectTextRuns(child, source, out);
}

/**
 * Every slice of `source` that `react-markdown` will render as visible text,
 * in source order.
 *
 * Returned ranges never overlap and never touch: mdast text nodes are disjoint
 * by construction, and everything between two of them is markup.
 */
export function markdownTextRuns(source: string): readonly FindRange[] {
  const hit = runsCache.get(source);
  if (hit !== undefined) return hit;

  const out: FindRange[] = [];
  collectTextRuns(parser.parse(source) as unknown as TreeNode, source, out);
  const frozen: readonly FindRange[] = out;

  if (runsCache.size >= RUNS_CACHE_LIMIT) {
    const oldest = runsCache.keys().next();
    if (!oldest.done) runsCache.delete(oldest.value);
  }
  runsCache.set(source, frozen);
  return frozen;
}

/**
 * True when `range` lies wholly inside ONE rendered run.
 *
 * "Wholly inside one" and not "overlaps some" is the whole invariant. A match
 * that straddles `**` — `o **b` in `foo **bar**` — could only be painted as two
 * marks, and two marks for one counted match is the drift in the other
 * direction. Such a match is not counted and not painted, on both sides,
 * because both sides ask this same question.
 */
export function isRenderedRange(
  range: FindRange,
  runs: readonly FindRange[],
): boolean {
  for (const run of runs) {
    if (run.start > range.start) return false; // runs are ordered; past it
    if (range.start >= run.start && range.end <= run.end) return true;
  }
  return false;
}

/** What a `<mark>` needs to know to paint itself. */
export interface MarkdownHighlightOptions {
  /** The markdown the ranges index into. */
  source: string;
  /** Already filtered to rendered ranges, in source order. */
  ranges: readonly FindRange[];
  /** Stamped on every mark, so a test can scope to one field. */
  fieldKey: string;
  /** Thread-wide number of `ranges[0]`; the nth range is `base + n`. */
  base: number;
  /** Thread-wide number of the match the reader is standing on, -1 for none. */
  active: number;
  /** Classes for the match under the reader's cursor. */
  activeClassName: string;
  /** Classes for every other match. */
  inactiveClassName: string;
}

function markElement(
  text: string,
  isActive: boolean,
  o: MarkdownHighlightOptions,
): TreeNode {
  return {
    type: 'element',
    tagName: 'mark',
    properties: {
      // hast wants a space-separated list as an array; react-markdown joins it
      // back into one `class` attribute.
      className: (isActive ? o.activeClassName : o.inactiveClassName).split(' '),
      'data-find-field': o.fieldKey,
      ...(isActive ? { 'data-find-active': 'true', 'aria-current': 'true' } : {}),
    },
    children: [{ type: 'text', value: text }],
  };
}

/**
 * A `rehype` plugin that paints `o.ranges` onto the rendered text.
 *
 * It splits hast text nodes rather than building markup from the message: the
 * only string that ever becomes an element's contents is a slice of a text node
 * that `react-markdown` had already decided to render as text. Nothing here can
 * turn model output into a tag.
 *
 * ORDINALS COME FROM THE RANGE ARRAY, not from a counter that walks the tree.
 * `ranges` is ordered by source offset and so is the index's numbering, so
 * `base + i` is the same number on both sides even for the one construct whose
 * document order differs from its source order (a GFM footnote definition,
 * which renders in a section at the end).
 */
export function markdownHighlight(o: MarkdownHighlightOptions) {
  return () =>
    (tree: TreeNode): void => {
      if (o.ranges.length === 0) return;
      paint(tree, o);
    };
}

function paint(node: TreeNode, o: MarkdownHighlightOptions): void {
  const children = node.children;
  if (children === undefined) return;

  const next: TreeNode[] = [];
  for (const child of children) {
    if (child.type !== 'text' || !isOffsetMapped(child, o.source)) {
      paint(child, o);
      next.push(child);
      continue;
    }
    next.push(...split(child, o));
  }
  node.children = next;
}

/**
 * One text node, cut into plain text and `<mark>`s.
 *
 * Every range is wholly inside a single run by construction (see
 * `isRenderedRange`), so a range either falls entirely within this node or does
 * not touch it — there is no partial case to get wrong.
 */
function split(
  node: TreeNode & {
    value: string;
    position: { start: { offset: number }; end: { offset: number } };
  },
  o: MarkdownHighlightOptions,
): TreeNode[] {
  const from = node.position.start.offset;
  const to = node.position.end.offset;

  const out: TreeNode[] = [];
  let cursor = from;
  o.ranges.forEach((range, i) => {
    if (range.start < from || range.end > to) return;
    if (range.start > cursor) {
      out.push({ type: 'text', value: o.source.slice(cursor, range.start) });
    }
    out.push(
      markElement(o.source.slice(range.start, range.end), o.base + i === o.active, o),
    );
    cursor = range.end;
  });

  if (out.length === 0) return [node];
  if (cursor < to) out.push({ type: 'text', value: o.source.slice(cursor, to) });
  return out;
}
