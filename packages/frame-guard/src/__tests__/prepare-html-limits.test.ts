import { getHeapStatistics } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { parse, serialize } from 'parse5';
import { FRAME_GUARD_SOURCE, prepareArtifactHtml, type PrepareLimits, type PrepareResult } from '../index.js';

// The transform runs on the host's one thread, on a page an agent wrote, so what
// it costs has to be bounded by something the agent does not choose. These tests
// feed it the shapes that make parse5 itself slow, at the size the content
// origin lets through (4 MiB), and assert on how long the answer takes and how
// much memory it uses. Every one of them used to take minutes, or end the
// process (TASK-1082 review, finding 1). The limits are then crossed one at a
// time with small pages, through the knobs `PrepareLimits` gives a test, so a
// limit that stops working fails here quickly and by name.

const KiB = 1024;
const MiB = 1024 * KiB;
/** The most the content origin hands the transform (MAX_HTML_TRANSFORM_BYTES). */
const CAP = 4 * MiB;

/** Wall-clock ceiling for an abort. Measured at single-digit to a few hundred ms; CI machines are slower, not 4x slower. */
const FAST_MS = 1000;
/** Growth in the heap while a hostile page was being refused. Measured at a few tens of MB. */
const HEAP_MB = 200;

// ---- the shapes --------------------------------------------------------------

const repeat = (unit: string, bytes: number, head = ''): string => head + unit.repeat(Math.ceil(bytes / unit.length));

/** Reviewer's first input: nothing but open divs. Plain parse5 spends 1.3 s on 98 KiB and ~50 minutes on 4 MiB. */
const nestedDivs = (bytes: number): string => repeat('<div>', bytes);

/**
 * Reviewer's second: `n` formatting elements with distinct attributes, closed by their parent, then
 * every `<span>` that follows rebuilds all of them (the adoption agency's "reconstruct the active
 * formatting elements"). Plain parse5 builds ~500 elements for every 17 bytes: 104 KiB took 20 s and 2 GB.
 */
function reconstruct(bytes: number, n = 500): string {
  let head = '<div>';
  for (let i = 0; i < n; i++) head += `<b x=${i}>`;
  head += '</div>';
  return repeat('<div><span></div>', bytes - head.length, head);
}

/** One start tag with thousands of distinct attributes: parse5's tokenizer compares each against all the ones before it. */
function attributeFlood(bytes: number): string {
  let s = '<div';
  for (let i = 0; s.length < bytes; i++) s += ` a${i}`;
  return `${s}>`;
}

/** Repeated `<body x>`: each one copies its attributes onto the first body, rebuilding a set of everything it has so far. */
function bodyAttributes(bytes: number): string {
  let s = '<body>';
  for (let i = 0; s.length < bytes; i++) s += `<body a${i}>`;
  return s;
}

/**
 * 500 attributes' worth of names on the first `<body>`, then `<body x>` over and over. Each repeat adds its
 * attributes to the first body; the default adapter rebuilds a set of the ~250 names that body has on every call.
 */
const bodyRepeated = (bytes: number): string => {
  const names = Array.from({ length: 250 }, (_, i) => ` a${i}`).join('');
  return repeat('<body x>', bytes, `<body${names}>`);
};

/** A block with tens of thousands of children, then the end tag of the formatting element around it: the adoption agency moves them one at a time. */
const adoptedChildren = (bytes: number): string => repeat('<i></i>', bytes - 12, '<a><div>') + '</a>';

/** `<a><div>x</a>`, over and over: the adoption agency moves a growing pile of children every time. Plain parse5: 21 s per MiB. */
const adoptionAgency = (bytes: number): string => repeat('<a><div>x</a>', bytes);
/** Everything in a table that is not table content is moved in front of it, one search through the siblings at a time. */
const fosterParented = (bytes: number): string => repeat('<div>x</div>', bytes, '<table>');
/** The same with void elements, and with text between them: every one is a search for where the table is. */
const fosterParentedInputs = (bytes: number): string => repeat('<input>', bytes, '<table>');
const fosterParentedText = (bytes: number): string => repeat('a<b></b>', bytes, '<table>');
const nestedTables = (bytes: number): string => repeat('<table><tr><td>', bytes);
const nestedTemplates = (bytes: number): string => repeat('<template>', bytes);
/** `<pre>` is a block, so each one scans the whole stack for an open paragraph: 100 s for 1 MiB in plain parse5. */
const nestedPre = (bytes: number): string => repeat('<pre>\nx', bytes);
/** 500 open elements and then end tags nothing matches: each looks through all 500 and builds nothing. */
const endTagsOverDeepStack = (bytes: number): string => repeat('</i>', bytes, '<span>'.repeat(500));
/** The same under list items: each `<li>` looks down the whole stack for the list item it closes. */
const listItemsOverDeepStack = (bytes: number): string => repeat('<li>', bytes, '<div>'.repeat(500));

// ---- measuring -----------------------------------------------------------------

interface Run {
  result: PrepareResult;
  ms: number;
  /** The most the heap grew, sampled each time the transform looked at the clock. */
  grownMB: number;
  /** How many times it looked. A run with no samples says nothing about memory. */
  samples: number;
}

/**
 * Runs the transform and reports how long it took and how far the heap grew. The heap is sampled
 * from inside the call, through the `now` the transform takes: the only way to see the peak of
 * work that never yields.
 */
function run(html: string, limits: PrepareLimits = {}): Run {
  const clock = limits.now ?? ((): number => performance.now());
  const base = getHeapStatistics().used_heap_size;
  let peak = base;
  let samples = 0;
  const now = (): number => {
    if (samples++ % 8 === 0) peak = Math.max(peak, getHeapStatistics().used_heap_size);
    return clock();
  };
  const started = performance.now();
  const result = prepareArtifactHtml(html, { ...limits, now });
  const ms = performance.now() - started;
  return { result, ms, grownMB: Math.max(0, peak - base) / MiB, samples };
}

/**
 * `run`, retried (twice at most) when it was slow or grew the heap, keeping the best one. These tests claim
 * that an abort takes milliseconds, and a timeslice the machine took for something else (measured: 30 times
 * the normal time, once in a few dozen runs) is not a regression. A real one is slow every time.
 */
function bestRun(html: string, limits: PrepareLimits = {}): Run {
  let best: Run | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = run(html, limits);
    if (best === undefined || r.ms < best.ms) best = r;
    if (r.ms < FAST_MS && r.grownMB < HEAP_MB) break;
  }
  return best as Run;
}

/** The reason a run was refused, or 'served'. */
function verdict(r: Run | PrepareResult): string {
  const result = 'result' in r ? r.result : r;
  return result.ok ? 'served' : result.reason;
}

/** Generous for ordinary machines, not so for the minutes these used to take. */
function expectFast(r: Run): void {
  expect(r.ms, 'milliseconds to answer').toBeLessThan(FAST_MS);
  expect(r.samples, 'the transform never looked at the clock, so the heap was never sampled').toBeGreaterThan(0);
  expect(r.grownMB, 'MB of heap growth').toBeLessThan(HEAP_MB);
}

// ---- the reviewer's two inputs, at the cap ---------------------------------------

describe("the reviewer's two inputs, scaled to the 4 MiB cap", () => {
  it('nested divs: refused as too deep, in milliseconds', () => {
    // At 1/32 of the size a quadratic parse already takes ~2 s (and the full size ~50 minutes), so a
    // regression is a quick failure here instead of a hung run below.
    const canary = bestRun(nestedDivs(CAP / 32));
    expect(verdict(canary)).toBe('too_deep');
    expect(canary.ms).toBeLessThan(FAST_MS);

    const full = bestRun(nestedDivs(CAP));
    expect(verdict(full)).toBe('too_deep');
    expectFast(full);
  });

  it('formatting-element reconstruction: refused for building too many nodes, in milliseconds, without the 2 GB', () => {
    // 16 KiB of this took 1.6 s and 250 MB in plain parse5, and 4 MiB ended the process.
    const canary = bestRun(reconstruct(16 * KiB));
    expect(verdict(canary)).toBe('too_many_nodes');
    expect(canary.ms).toBeLessThan(FAST_MS);
    expect(canary.grownMB).toBeLessThan(HEAP_MB);

    const full = bestRun(reconstruct(CAP));
    expect(verdict(full)).toBe('too_many_nodes');
    expectFast(full);
  });
});

// ---- the other shapes that make parse5 itself slow -------------------------------

describe('other shapes that cost parse5 minutes, at the 4 MiB cap', () => {
  // Each of these was measured in plain parse5 before the fix (the comment above says what). Where a
  // small copy is already slow in plain parse5 it is run first, so a regression fails in about a second
  // instead of hanging the run on the full size.
  const SHAPES: Array<{ name: string; make: (bytes: number) => string; reason: string; canary: boolean }> = [
    { name: 'one tag with thousands of attributes', make: attributeFlood, reason: 'too_many_attrs', canary: true },
    { name: '<body> repeated, each with new attributes', make: bodyAttributes, reason: 'too_many_attrs', canary: true },
    { name: '<body x> repeated 500,000 times after 250 attributes on the first (served: it is linear)', make: bodyRepeated, reason: 'served', canary: false },
    { name: '<a><div>x</a> repeated (adoption agency)', make: adoptionAgency, reason: 'too_deep', canary: true },
    { name: 'table content moved in front of the table', make: fosterParented, reason: 'too_many_nodes', canary: false },
    { name: '...void elements, one search for the table each', make: fosterParentedInputs, reason: 'too_many_nodes', canary: false },
    { name: '...text between elements, one search for the table each', make: fosterParentedText, reason: 'too_many_nodes', canary: false },
    { name: '<table><tr><td> nested', make: nestedTables, reason: 'too_deep', canary: true },
    { name: '<template> nested', make: nestedTemplates, reason: 'too_deep', canary: true },
    { name: '<pre> nested', make: nestedPre, reason: 'too_deep', canary: true },
    { name: '500 open elements, then end tags that match nothing', make: endTagsOverDeepStack, reason: 'too_much_work', canary: false },
    { name: '500 open divs, then list items', make: listItemsOverDeepStack, reason: 'too_much_work', canary: false },
  ];

  it('stops the one shape no count catches, by the clock: a block of 70,000 children moved by the adoption agency', () => {
    // Each child is moved out of a list that is 70,000 long (plain parse5: ~6 s for 1 MiB of this, quadratic),
    // which no node, depth, attribute or call limit sees. The time budget (700 ms for this page) is what ends it.
    const out = bestRun(adoptedChildren(MiB));
    expect(verdict(out)).toBe('too_slow');
    expect(out.ms).toBeLessThan(FAST_MS);
    // ...and a page of the same shape that is small enough is served.
    expect(verdict(run(adoptedChildren(60 * KiB)))).toBe('served');
  });

  it.each(SHAPES)('$name', ({ make, reason, canary }) => {
    if (canary) {
      const small = bestRun(make(CAP / 32));
      expect(verdict(small)).toBe(reason);
      expect(small.ms).toBeLessThan(FAST_MS);
    }
    const full = bestRun(make(CAP));
    expect(verdict(full)).toBe(reason);
    expectFast(full);
  });
});

// ---- the limits must not cost real pages ------------------------------------------

describe('ordinary pages, big and dense, are still served', () => {
  // These are the pages the limits could get wrong, so they run under the real node, call and attribute
  // limits and a budget far longer than they need: what is asserted is that no limit but time is
  // in their way. (Time on a loaded CI runner is not a thing a unit test should depend on.)
  const LONG = { budgetMs: 60_000 };

  it('4 MiB of inlined script', () => {
    const page = `<!doctype html><title>t</title><script>${'a=1;'.repeat(CAP / 4 - 64)}</script><p>hi</p>`;
    expect(verdict(run(page, LONG))).toBe('served');
  });

  it('4 MiB of text, and 4 MiB in one attribute value', () => {
    expect(verdict(run(`<p>${'word '.repeat(CAP / 5 - 8)}</p>`, LONG))).toBe('served');
    expect(verdict(run(`<img src="data:image/png;base64,${'QUJD'.repeat(CAP / 4 - 64)}">`, LONG))).toBe('served');
  });

  it('a table of 5,000 rows by 10 numbers (100,000 nodes, 0.4 MiB)', () => {
    const row = `<tr>${'<td>12.5</td>'.repeat(10)}</tr>`;
    const out = run(`<table><tbody>${row.repeat(5000)}</tbody></table>`, LONG);
    expect(verdict(out)).toBe('served');
  });

  it('0.75 MiB of prose with a link or an emphasis every dozen characters (130,000 nodes)', () => {
    const out = run(repeat('<p>Hello <b>world</b> and <a href="x">more</a>.</p>\n', 0.75 * MiB), LONG);
    expect(verdict(out)).toBe('served');
  });

  it('a page whose end tags and stray tags are all over the place, a thousand times over', () => {
    const messy = '<table><b>x<tr><td>cell</i></span><p>para</b></a></table>more text<li>item</font>';
    expect(verdict(run(messy.repeat(1000), LONG))).toBe('served');
  });

  it('refuses a table 20 times that size, on the node limit, in milliseconds', () => {
    const row = `<tr>${'<td>12.5</td>'.repeat(10)}</tr>`;
    const out = bestRun(`<table><tbody>${row.repeat(100_000)}</tbody></table>`);
    expect(verdict(out)).toBe('too_many_nodes');
    expectFast(out);
  });
});

// ---- the limits, one at a time ----------------------------------------------------

describe('each limit on its own, with a small page', () => {
  /** A clock that moves a millisecond every time it is read. */
  const ticking = (): (() => number) => {
    let t = 0;
    return () => t++;
  };

  describe('nodes', () => {
    it('counts what the parse builds, text and comments included, against maxNodes', () => {
      const page = '<p>x</p>'.repeat(200); // html, head, body, then a <p> and its text each
      expect(verdict(prepareArtifactHtml(page))).toBe('served');
      expect(verdict(prepareArtifactHtml(page, { maxNodes: 1000 }))).toBe('served');
      expect(verdict(prepareArtifactHtml(page, { maxNodes: 100 }))).toBe('too_many_nodes');
      expect(verdict(prepareArtifactHtml('<!--c-->'.repeat(200), { maxNodes: 100 }))).toBe('too_many_nodes');
    });

    it('counts the nodes the parser makes that the markup never wrote: formatting elements that come back', () => {
      // 100 formatting elements, then every <span> brings all 100 back: 40 KiB of markup, 2.4 million nodes.
      const page = reconstruct(40 * KiB, 100);
      const out = run(page, { maxNodes: 20_000 });
      expect(verdict(out)).toBe('too_many_nodes');
      expect(out.ms).toBeLessThan(FAST_MS);
    });

    it('is the number of nodes in ONE parse: another pass starts again from zero', () => {
      // 60 nodes a pass, two passes, a limit of 80.
      const page = '<p>x</p>'.repeat(28);
      expect(verdict(prepareArtifactHtml(page, { maxNodes: 80 }))).toBe('served');
    });
  });

  describe('calls to the tree adapter', () => {
    // A page that makes thousands of calls (the limit is looked at every 1,024 of them).
    const page = '<p>x</p>'.repeat(2000);

    /** The fewest calls that still serve `html`. */
    function needed(html: string): number {
      let lo = 0;
      let hi = 1_000_000;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (prepareArtifactHtml(html, { maxCalls: mid }).ok) hi = mid;
        else lo = mid;
      }
      return hi;
    }

    it('refuses a parse that makes more calls than maxCalls, as too much work', () => {
      expect(verdict(prepareArtifactHtml(page, { maxCalls: 2000 }))).toBe('too_much_work');
      expect(verdict(prepareArtifactHtml(page, { maxCalls: 1_000_000 }))).toBe('served');
    });

    it('counts the calls of every pass together, not each pass on its own', () => {
      // A page is read twice (it is read again once it has the guard and what the parser fixed), but a page that
      // is already what the transform makes (its own output) is read once. The first costs the second's calls
      // twice over if the passes share the limit, and the same if each pass has its own.
      const result = prepareArtifactHtml(page);
      expect(result.ok).toBe(true);
      const once = result.ok ? result.html : '';
      const twice = needed(page);
      const single = needed(once);
      expect(single).toBeGreaterThan(5_000);
      expect(twice / single).toBeGreaterThan(1.5);
    });
  });

  describe('the clock', () => {
    it('refuses a page whose parse runs past the budget, partway through', () => {
      // Each read of the clock is a millisecond; a page this size is looked at dozens of times.
      const page = '<p>x</p>'.repeat(5000);
      expect(verdict(prepareArtifactHtml(page, { now: ticking(), budgetMs: 1_000_000 }))).toBe('served');
      expect(verdict(prepareArtifactHtml(page, { now: ticking(), budgetMs: 3 }))).toBe('too_slow');
    });

    it('refuses at once with no time at all', () => {
      expect(verdict(prepareArtifactHtml('<p>x</p>', { budgetMs: 0 }))).toBe('too_slow');
    });

    it('looks while the tokenizer is inside one token, where nothing of ours runs (lookEvery)', () => {
      // A single run of text: three adapter calls in all, so only the tokenizer's own looks can see the clock.
      const page = `<!--${'x'.repeat(2000)}-->`;
      expect(verdict(prepareArtifactHtml(page, { now: ticking(), budgetMs: 1_000_000, lookEvery: 10 }))).toBe('served');
      expect(verdict(prepareArtifactHtml(page, { now: ticking(), budgetMs: 50, lookEvery: 10 }))).toBe('too_slow');
    });

    it('looks every few thousand characters by default, and not much more often', () => {
      let reads = 0;
      const now = (): number => (reads++, 0);
      prepareArtifactHtml(`<!--${'x'.repeat(40_000)}-->`, { now, budgetMs: 1_000_000 });
      // 2 passes of ~49 KB: about a dozen looks each at one per 4096 characters, plus the few between phases.
      expect(reads).toBeGreaterThan(10);
      expect(reads).toBeLessThan(80);
    });

    describe('between the phases of a pass', () => {
      // A small page makes no look of its own: the clock is read at the start, after the parse, and before the
      // page is written out. `jumpAt(n)` is a clock that runs out of time on its n-th read (the first is the start).
      const jumpAt = (n: number): (() => number) => {
        let reads = 0;
        return () => (reads++ < n ? 0 : 10_000);
      };

      it('looks after the parse, before the tree is cut: out of time first', () => {
        // <plaintext> is refused by the cut that follows the parse.
        expect(verdict(prepareArtifactHtml('<plaintext>x', { now: jumpAt(1), budgetMs: 100 }))).toBe('too_slow');
        expect(verdict(prepareArtifactHtml('<plaintext>x', { now: jumpAt(2), budgetMs: 100 }))).toBe('plaintext');
      });

      it('looks again before the page is written out: out of time first', () => {
        // A carriage return from a character reference is refused when the page is written out.
        expect(verdict(prepareArtifactHtml('x&#13;', { now: jumpAt(2), budgetMs: 100 }))).toBe('too_slow');
        expect(verdict(prepareArtifactHtml('x&#13;', { now: jumpAt(3), budgetMs: 100 }))).toBe('cr_entity');
      });
    });
  });

  describe('attributes', () => {
    const tagWith = (n: number, close = '>'): string => `<div${Array.from({ length: n }, (_, i) => ` a${i}`).join('')}${close}`;

    it('allows an element 256 attributes and refuses 257', () => {
      expect(verdict(prepareArtifactHtml(tagWith(256)))).toBe('served');
      expect(verdict(prepareArtifactHtml(tagWith(257)))).toBe('too_many_attrs');
    });

    it('counts the attributes <html> and <body> tags repeated in a page add to the first', () => {
      const body = (from: number, n: number): string => `<body${Array.from({ length: n }, (_, i) => ` b${from + i}`).join('')}>`;
      expect(verdict(prepareArtifactHtml(body(0, 100) + body(100, 100)))).toBe('served');
      expect(verdict(prepareArtifactHtml(body(0, 200) + body(200, 100)))).toBe('too_many_attrs');
      // ...and names it already has don't count twice.
      expect(verdict(prepareArtifactHtml(body(0, 200) + body(0, 200)))).toBe('served');
    });

    it('looks at the tag being read, not only the finished tag (a tag that never ends)', () => {
      // No `>`: the tokenizer drops the tag at the end of the page, so no element is ever made, and only a
      // look at the tag in progress can tell. This is what ends a 4 MiB flood after 4 KiB instead of 2 minutes.
      const unfinished = tagWith(300, '');
      expect(verdict(prepareArtifactHtml(unfinished, { lookEvery: 16 }))).toBe('too_many_attrs');
      expect(verdict(prepareArtifactHtml(tagWith(100, ''), { lookEvery: 16 }))).toBe('served');
    });
  });

  describe('what it writes out', () => {
    it('refuses a result several times the page before writing it: one big attribute that comes back with every span', () => {
      // A 200 KiB attribute on 20 formatting elements that each span brings back: the tree is ten thousand
      // nodes sharing the attribute lists, and written out it is 2 GB, past the longest string there is.
      let page = '<div>';
      for (let i = 0; i < 20; i++) page += `<b x=${i} y="${'v'.repeat(200 * KiB)}">`;
      page += `</div>${'<div><span></div>'.repeat(500)}`;
      const out = bestRun(page);
      expect(verdict(out)).toBe('output_too_large');
      expect(out.ms).toBeLessThan(FAST_MS);
      expect(out.grownMB).toBeLessThan(HEAP_MB);
    });

    it('refuses a result that only escaping makes too large (a quote in an attribute is six characters out)', () => {
      expect(verdict(prepareArtifactHtml(`<p title='${'"'.repeat(15_000)}'>x</p>`))).toBe('served'); // 90 KB out: under the slack
      expect(verdict(prepareArtifactHtml(`<p title='${'"'.repeat(1 * MiB)}'>x</p>`))).toBe('output_too_large'); // 6 MiB out
    });

    it('serves what real pages do: markup that grows a little when it is written out', () => {
      const grows = '<table><tr><td>a<td>b<tr><td>c</table><p>one<p>two<ul><li>x<li>y</ul><br><input disabled><img alt>'.repeat(500);
      const out = prepareArtifactHtml(grows);
      expect(verdict(out)).toBe('served');
      if (out.ok) expect(out.html.length).toBeGreaterThan(grows.length);
    });
  });
});

// ---- the parse is still parse5's ---------------------------------------------------

describe('what the bounded parse builds is what plain parse5 builds', () => {
  // The transform parses through its own tree adapter, which replaces three of the default's calls (how
  // foster-parented nodes are inserted, and how repeated <html> and <body> tags add their attributes).
  // Pages that go through those, written out by parse5 itself, must match what the transform serves.
  const withGuard = (html: string): string => serialize(parse(html, { scriptingEnabled: true }), { scriptingEnabled: true }).replace('<head>', '<head><GUARD/>');
  const unguarded = (out: string): string => {
    const open = out.indexOf(`<script>${FRAME_GUARD_SOURCE}`);
    return out.slice(0, open) + '<GUARD/>' + out.slice(out.indexOf('</script>', open) + '</script>'.length);
  };

  const PAGES: Array<[string, string]> = [
    ['text and elements foster-parented out of a table', '<table>a<b>b</b><i>c<tr><td>d</td></tr>e<div>f</div></table>g'],
    ['foster parenting inside nested tables', '<table><tr><td><table>x<b>y<tr><td>z</table>w</td></tr></table>'],
    ['foster-parented text next to text', '<table>one two<tr><td>cell</td></tr>three</table>'],
    ['a table inside formatting elements', '<b><table><i>x<tr><td>y</td></tr></i>z</table></b>'],
    ['misnested formatting elements (the adoption agency)', '<p><b><i>one</b>two</i>three</p><a href=x><div>four</a>five</div>'],
    ['formatting elements that come back after the paragraph that held them', '<p><b x=1><i x=2>one</p><p>two</p><p>three'],
    ['<html> and <body> attributes added by tags that repeat', '<html a=1><body b=2><html c=3 a=9><body d=4 b=8><p>x'],
    ['<body> after content, with the same name twice', '<p>x<body e=5 e=6 f><body g>'],
    ['a template inside a table', '<table><template><tr><td>x</td></tr></template><tr><td>y</td></tr></table>'],
    ['a select in a table cell and stray text', '<table><tr><td><select><option>a<option>b</select>stray</td></tr>more</table>'],
  ];

  it.each(PAGES)('%s', (_name, html) => {
    const result = prepareArtifactHtml(html);
    expect(result.ok).toBe(true);
    if (result.ok) expect(unguarded(result.html)).toBe(withGuard(html));
  });

  it('keeps foster-parented nodes where parse5 puts them: in front of the table, in order', () => {
    const result = prepareArtifactHtml('<table>a<b>b</b>c<tr><td>d</td></tr></table>');
    expect(result.ok && result.html.includes('<body>a<b>b</b>c<table><tbody><tr><td>d</td></tr></tbody></table></body>')).toBe(true);
  });
});

// ---- the refusals say nothing about the page --------------------------------------

describe('a refusal is a fixed code', () => {
  it('names the limit and nothing of the page, whatever the page said', () => {
    const SECRET = 'SECRET-PAGE-CONTENT-4f2a';
    const hostile: Array<[string, string]> = [
      ['too_deep', `<p>${SECRET}</p>${'<div>'.repeat(600)}`],
      ['too_many_attrs', `<div title="${SECRET}" ${Array.from({ length: 300 }, (_, i) => `${SECRET}${i}`).join(' ')}>`],
      ['plaintext', `<plaintext>${SECRET}`],
      ['nul', `${SECRET}\u0000`],
      ['cr_entity', `${SECRET}&#13;`],
    ];
    for (const [reason, page] of hostile) {
      const result = prepareArtifactHtml(page);
      expect(result).toEqual({ ok: false, reason });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });
});
