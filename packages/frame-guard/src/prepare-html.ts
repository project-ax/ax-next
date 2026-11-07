import {
  defaultTreeAdapter as tree,
  html as spec,
  parse,
  Parser,
  serializeOuter,
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes as Tree,
  type Tokenizer,
  type TreeAdapter,
} from 'parse5';
import { CHILD_FRAME_TAGS, DSD_ATTRS, FRAME_GUARD_SOURCE } from './guard.js';

// The server half of the frame guard. An artifact is a page an agent wrote,
// served to a browser that runs its scripts. The in-page guard (frame-guard.js)
// can only watch the document tree, so it is blind to anything inside a CLOSED
// declarative shadow root: `<template shadowrootmode="closed"><iframe srcdoc=…>`
// parsed straight into the page gets a child frame the guard can't see and a
// fresh realm with working WebRTC. That hole has to be closed before the browser
// parses a byte, which is what this does:
//
//   1. parse the page the way the browser will (scripting ON, so a <noscript>
//      body is raw text, not markup),
//   2. cut out every element that can make a child frame, every <noscript>, and
//      the attributes that turn a <template> into a shadow root,
//   3. put the guard script first in the <head> the parser built,
//   4. serialize, and go round again until a pass finds nothing more to cut.
//
// The result is built from parse5's tree, never from the original bytes, so
// whatever parse5 dropped (say, tags that the spec of the day doesn't allow
// inside a <select>) is gone from what we ship instead of surviving unread. The
// string that comes back is also one parse5 reproduces byte for byte from its
// own parse of it, so it holds still under another pass and under a second call.
//
// This is a second layer on top of the CSP and the sandbox, not a boundary. Where
// the browsers and parse5 are known to read the same bytes differently we either
// rebuild from parse5's tree (tags in a <select>) or refuse (a NUL, a carriage
// return written as a character reference); anywhere else they might, the
// guard's observer and its window.length check are what catch the rest. The
// answer to "I can't be sure" is a refusal with a reason code: the caller serves
// its fixed "can't show this" answer.
//
// It also runs on the caller's thread, on bytes an agent chose, and parse5 is
// not linear: nested `<div>`s, formatting elements that come back for every
// following tag, thousands of attributes on one tag and a few other shapes cost
// it quadratic time or memory, so 4 MiB of the right markup holds a thread for
// the better part of an hour or ends the process. The cost therefore has to be
// bounded by something the page does not pick, and the page's size is not that:
// the PARSE is bounded. parse5 gets our own tree adapter that counts what it
// builds (elements and text, how deep the stack of open elements is, how many
// attributes one element has) and looks at the clock, and the tokenizer, which
// calls nothing of ours while it reads a tag, is made to look at the clock and
// at the tag it is in the middle of every few thousand characters. Whichever
// limit is crossed first ends the parse with a reason.
//
// Those limits are measured, and they are the first layer, not the only one: the
// shapes found so far are not all there are. The content origin does not call this
// on the thread that serves its requests. It calls `createHtmlPreparer`
// (prepare-pool.ts), which runs it on a worker thread with a heap limit and a
// deadline, so what the limits miss is held there.

/** What the guard script does on a kill. The page is already blank by then; this says why. */
const START_GUARD =
  'window.axFrameGuard(window,{onKill:function(){try{console.warn("blocked: this page tried to open a nested frame")}catch(e){}}});' +
  'delete window.axFrameGuard;';

/** The text of the one <script> element that is placed first in <head>. */
const GUARD_SCRIPT = `${FRAME_GUARD_SOURCE}\n${START_GUARD}`;

/** Parse passes before giving up. `stripChildFrames` in channel-web's visual-doc.ts allows the same. */
const MAX_PASSES = 4;

/**
 * Chromium, Firefox and WebKit all stop nesting at about 512 open elements (700
 * nested divs put the deepest at depth 513, 513 and 512) and attach what comes
 * next to an ancestor, so a tree deeper than that is shaped differently there
 * than here. No page comes near it. Past it we refuse, which also keeps the
 * recursive serializer well clear of the call stack limit. Checked twice: on the
 * stack of open elements while parsing (so a deep page is refused after 512
 * elements, not after the quadratic cost of building all of them), and on the
 * finished tree (where adoption can have put things deeper than the stack was).
 */
const MAX_DEPTH = 512;

/**
 * Nodes (elements, text, comments) one parse may build. A real page is nowhere
 * near it: measured, a 1 MB page of HTML is 100 to 33,000 nodes (a dense
 * reference page 32 per KB), and a table of numbers about 170 per KB, so
 * 150,000 nodes is a 900 KB table. This is what stops a page whose parse builds
 * nodes the markup never wrote: each `<span>` after 500 formatting elements
 * brings all 500 back, 30 nodes per input byte, and the number is the cap on
 * that whatever the size of the page. A page that stays inside it costs what its
 * size and shape cost, and the numbers are measured, not a bound: of 14 shapes,
 * the biggest page each is served at (the limits all in force, the time budget
 * not) takes 0.06 to 0.31 s of CPU (150,000 foster-parented `<input>`s are 0.15 s,
 * 150,000 `<input type=hidden>`, the dearest, 0.3 s), and 4 MiB of text with
 * nothing in it to count 0.34 s. The shapes that cost more than that are the ones
 * nothing counts, and the time budget is what stops them.
 */
const MAX_NODES = 150_000;

/**
 * Calls parse5 may make to the tree adapter, over every pass of one transform. It reads the tree
 * through the adapter for everything it checks, so this counts the work of its
 * scans, which node counts don't: 500 open elements and then a million `</i>`,
 * each of which looks through all 500, builds no nodes at all. A real page makes
 * under one call per character of HTML (measured: 0.01 to 0.9; a table of
 * numbers is the top), so even 4 MiB of it needs under 8 million over its two
 * passes; this is 25 million, which stops that scan page after 0.19 to 0.25 s
 * of CPU (measured: 500 open elements, then end tags or list items).
 */
const MAX_CALLS = 25_000_000;

/**
 * Attributes one element may have. parse5 checks each new attribute against
 * every earlier one on the tag, so thousands on one tag cost quadratic time in
 * the tokenizer, where nothing else can interrupt it; and `<body>` and `<html>`
 * tags repeated in a page copy theirs onto the first. A real element has a
 * dozen.
 */
const MAX_ATTRS = 256;

/**
 * What the result may weigh, as a multiple of the page plus a little for the
 * guard. Writing a tree out repeats the attribute text of every element parse5
 * rebuilt (so one big attribute and a few hundred rebuilt elements is a result
 * of gigabytes from a few hundred nodes), and escaping can turn one character
 * into six. A real page comes back at its own size: of 3,869 real pages (up to
 * 4 MiB) none came back more than 1.001 times as long as soon as it was over 256
 * KiB (947 of them), and the most any grew was 1.27 times, a page of 1 KiB, which
 * the slack covers.
 *
 * It is also what bounds the second pass, which has to tokenize everything the
 * first wrote. It was 4, and an ASCII page under 4 MiB (ten attributes of 420 KB
 * on formatting elements, rebuilt twice) that wrote out at three times its length
 * was let through and ended the process: the second pass over 12.6 MB needed more
 * than 400 MB of heap and V8 aborted, which it does instead of ending the worker
 * when a limit is that far under the need. 1.5 refuses every such shape found
 * (measured, a fraction of a second each), and the most it lets through is the
 * worst legitimate page: half a script, half attributes written out once more.
 * That page needs under 96 MB with the reads in `boundedAdapter`; 256 to 288
 * without them. Checked twice: on the tree before anything is written, counting
 * each character as the serializer will write it (`weigh`), and on the string
 * that comes out, so a second pass never starts on more than this.
 */
const OUTPUT_FACTOR = 1.5;
const OUTPUT_SLACK = 64 * 1024;

/**
 * Characters the serializer may have to rewrite (`"`, `&`, `<`, `>` and the
 * no-break space become `&quot;`, `&amp;`, `&lt;`, `&gt;` and `&nbsp;`), over the
 * whole tree. parse5 escapes one match at a time, a regular expression match and
 * two string joins for each, and the joins stay in memory until the result is
 * flattened: measured, about 45 ns and 40 bytes of heap per character (a million
 * is 50 ms and 44 MB; 4 MiB of nothing but `<`, which is four million, is 200 ms
 * and 160 MB). So this, with the length limit, is what bounds writing a page out,
 * whatever its size. Real pages have almost none: the densest of 1,341 pages
 * of 20 KiB to 4 MiB had 0.6% (254 in 41,000 characters) and the most in any one
 * was 287. A million is a 4 MiB page of which a quarter is such characters.
 */
const MAX_ESCAPES = 1_000_000;

/**
 * Characters the tokenizer reads between looks at the clock and at the tag it is
 * in the middle of. The tokenizer is where one tag with thousands of attributes
 * costs quadratic time (each new attribute is compared with every earlier one),
 * and it calls nothing we hold while it does. After this many characters of such
 * a tag it has 700 attributes to compare, about a millisecond.
 */
const LOOK_EVERY = 4096;

/** The adapter checks its call count and the clock once per this many calls. */
const CLOCK_EVERY = 1024;

/**
 * The time one call may take, of this thread's CPU, when the caller does not say
 * otherwise: 500 ms, whatever the size of the page. A call made on a thread that
 * serves other work must not hold it for longer than that, so this is what anyone
 * gets who calls `prepareArtifactHtml` directly. It is also what a refusal as too
 * slow is measured against, and that is the page and not the machine, so it can be
 * remembered. The heaviest real pages (3 to 4 MiB of script or inlined data; 49
 * real pages of 0.4 to 4 MiB were measured) take up to 0.35 s of CPU on the machine
 * measured on (the 3 to 4 MiB ones 0.22 to 0.35 s) and an ordinary one of 100 to 170
 * KiB 7 to 15 ms, which this passes with room on that machine and not much to spare
 * on a slower one. Those pages are served by the worker thread
 * (prepare-worker.ts), which gives the transform `WORKER_BUDGET_MS` and is the only
 * caller that does; nothing that serves requests runs a longer one.
 */
const BUDGET_MS = 500;

const NUL = '\u0000';

/**
 * Why a page was not prepared. Fixed codes, so a log line can say which without
 * saying anything about the page.
 */
export type PrepareRefusal =
  /** A U+0000 in the page: browsers and parse5 read it differently while `<head>` is open. */
  | 'nul'
  /** A carriage return written as a character reference (`&#13;`). */
  | 'cr_entity'
  /** Elements nested deeper than a browser keeps them. */
  | 'too_deep'
  /** The parse built more nodes than any real page needs. */
  | 'too_many_nodes'
  /** An element with more attributes than any real page has. */
  | 'too_many_attrs'
  /** The parse made more calls to the tree adapter than any real page does: it is scanning, not building. */
  | 'too_much_work'
  /** The transform ran out of its time. */
  | 'too_slow'
  /** The result would be far larger than the page, or have far more characters to escape than any page does. */
  | 'output_too_large'
  /** `<plaintext>`: the rest of the document is its text, and writing the page back out changes it. */
  | 'plaintext'
  /** A doctype whose quirks mode can't be written back. */
  | 'quirks'
  /** Reading the result back keeps changing it. */
  | 'no_fixpoint'
  /** The parser itself threw. */
  | 'parse_error';

export type PrepareResult = { ok: true; html: string } | { ok: false; reason: PrepareRefusal };

/** Every `PrepareRefusal`, as a record so the compiler says when this list and the type above part ways. */
const REFUSAL_CODES: Record<PrepareRefusal, true> = {
  nul: true,
  cr_entity: true,
  too_deep: true,
  too_many_nodes: true,
  too_many_attrs: true,
  too_much_work: true,
  too_slow: true,
  output_too_large: true,
  plaintext: true,
  quirks: true,
  no_fixpoint: true,
  parse_error: true,
};

/** Whether a value read off a message is one of the refusal codes. */
export function isPrepareRefusal(value: unknown): value is PrepareRefusal {
  return typeof value === 'string' && Object.hasOwn(REFUSAL_CODES, value);
}

/**
 * Knobs for tests: the defaults are the policy. Each one lets a test cross a
 * limit with a small page, or take the clock out of the picture.
 */
export interface PrepareLimits {
  /** Milliseconds of CPU the whole call may take. Default: `BUDGET_MS` (500). */
  budgetMs?: number;
  /** Nodes one parse may build. Default: `MAX_NODES`. */
  maxNodes?: number;
  /** Tree adapter calls the whole transform may make. Default: `MAX_CALLS`. */
  maxCalls?: number;
  /** Characters the serializer may have to escape, in one tree. Default: `MAX_ESCAPES`. */
  maxEscapes?: number;
  /** Characters the tokenizer reads between looks at the clock and at the tag it is in. Default: `LOOK_EVERY`. */
  lookEvery?: number;
  /** The clock, in milliseconds. Default: this thread's CPU time (`defaultClock`). */
  now?: () => number;
}

/**
 * The clock the time budget runs on: the CPU time this thread has used, in
 * milliseconds. Not the wall clock. The budget is for work, and a stretch the OS
 * gives the thread to something else (a busy host, a CPU quota, a test runner
 * with every core taken) is not the page's doing: measured, a wall clock turned
 * good pages into refused ones whenever the machine was busy, and a refusal is
 * cached. Where the runtime has no per-thread CPU time it is the wall clock (every
 * Node this repo supports has it).
 */
export function defaultClock(): number {
  if (typeof process.threadCpuUsage !== 'function') return performance.now();
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/** What ends a transform early. Private: it never leaves this module, `prepareArtifactHtml` turns it into a result. */
class Refusal extends Error {
  constructor(readonly reason: PrepareRefusal) {
    super(reason);
    this.name = 'Refusal';
  }
}

/** What one call to the transform works under. */
interface Run {
  now: () => number;
  /** Tree adapter calls so far, over every parse of this transform. */
  calls: number;
  /** When `now()` reaches this, the call is out of time. */
  deadline: number;
  maxNodes: number;
  maxCalls: number;
  look: number;
  /** The most the result may weigh, in characters. */
  maxOutput: number;
  /** The most characters the serializer may have to escape. */
  maxEscapes: number;
  /** Where the reads that make a string flat (see `boundedAdapter`) go. Nothing reads it. */
  sink: number;
}

const PARSE_OPTIONS = { scriptingEnabled: true } as const;
const SERIALIZE_OPTIONS = { scriptingEnabled: true } as const;

const FRAME_MAKERS: ReadonlySet<string> = new Set(CHILD_FRAME_TAGS);
const SHADOW_ROOT_ATTRS: ReadonlySet<string> = new Set(DSD_ATTRS);
/** The elements whose first newline the parser eats ("in body": pre, listing, textarea). */
const EATS_FIRST_NEWLINE: ReadonlySet<string> = new Set(['pre', 'listing', 'textarea']);

const isElement = (node: Tree.Node): node is Tree.Element => tree.isElementNode(node);
const isHtmlElement =
  (name: string) =>
  (node: Tree.ChildNode): node is Tree.Element =>
    isElement(node) && node.tagName === name && node.namespaceURI === spec.NS.HTML;

/** The fragment holding an HTML <template>'s children, which are not in `childNodes`. */
function templateContent(el: Tree.Element): Tree.DocumentFragment | null {
  return el.tagName === 'template' && el.namespaceURI === spec.NS.HTML ? tree.getTemplateContent(el as Tree.Template) : null;
}

/** The parser always builds <html> then <head>, whatever the input looked like. */
function headOf(doc: Tree.Document): Tree.Element {
  const head = doc.childNodes.find(isHtmlElement('html'))?.childNodes.find(isHtmlElement('head'));
  if (head === undefined) throw new Error('the parser built no <head>');
  return head;
}

/** Exactly the script this module injects: a plain classic script holding exactly the guard text. */
function isGuardScript(node: Tree.ChildNode | undefined): boolean {
  if (node === undefined || !isHtmlElement('script')(node) || node.attrs.length !== 0) return false;
  const only = node.childNodes.length === 1 ? node.childNodes[0] : undefined;
  return only !== undefined && tree.isTextNode(only) && only.value === GUARD_SCRIPT;
}

// The guard is sent inline, so the HTML parser has to hand the browser the same
// script text we wrote, and has to hand it back when we read our own output
// ("already there" is an exact-text match). A `</script`, a `<!--`, or a CR (the
// parser turns it into LF) would break one or the other. A test pins the guard
// file; this is the same check on the finished text, with the real parser, so
// a bad edit fails loudly at load instead of 404ing every artifact.
{
  const probe = parse(`<script>${GUARD_SCRIPT}</script>`, PARSE_OPTIONS);
  if (!isGuardScript(headOf(probe).childNodes[0])) {
    throw new Error('@ax/frame-guard: the guard script does not survive the HTML parser as one inline <script>');
  }
}

/**
 * Calls `visit` on every node that has children: the document, each element,
 * and each <template>'s content. `visit` may replace `node.childNodes`; the
 * walk then goes on to whatever it left. Iterative, so depth costs heap, not
 * stack, and capped at MAX_DEPTH.
 */
function walk(root: Tree.ParentNode, visit: (node: Tree.ParentNode) => void): void {
  const pending: Array<[Tree.ParentNode, number]> = [[root, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [node, depth] = next;
    visit(node);
    for (const child of node.childNodes) {
      if (!isElement(child)) continue;
      if (depth + 1 > MAX_DEPTH) throw new Refusal('too_deep');
      pending.push([child, depth + 1]);
      const content = templateContent(child);
      if (content !== null) pending.push([content, depth + 1]);
    }
  }
}

/**
 * Adds up, before anything is written, what the finished page will weigh and how
 * many characters its writing will escape, and refuses the moment either is past
 * its limit. It has to be told what the serializer does, character by character,
 * because the tree is not the page: the parser shares an element's attribute list
 * with every copy it makes of the element (so a tree of a few hundred nodes can be
 * gigabytes of markup), and the serializer turns one character into up to six.
 * Counted as one each, 80 copies of an attribute of 200 KiB of quotes read as
 * 16 MiB and were 100 MiB, and writing them took more than half a gigabyte.
 *
 * These are parse5's own rules (`serializer/index.js`, `entities/escape`):
 * in an attribute value `"` and U+00A0 are six characters (`&quot;`, `&nbsp;`)
 * and `&` is five; in text `&` is five, `<` and `>` are four and U+00A0 is six,
 * except in the raw text of `script`, `style` and the like, which is written as
 * it is. Elements are counted with both tags, so a void element is counted a few
 * characters over. The count may be high, never low: a test holds it to that.
 * The exact length is checked again once the page is written.
 */
class Weigher {
  /** About the length of the page written out, in characters. */
  weight = 0;
  /** The characters in it that the serializer rewrites. */
  escapes = 0;

  constructor(
    private readonly maxWeight: number,
    private readonly maxEscapes: number,
  ) {}

  add(chars: number): void {
    this.weight += chars;
    if (this.weight > this.maxWeight || this.escapes > this.maxEscapes) throw new Refusal('output_too_large');
  }

  /** An attribute value: `"` and no-break space written as six, `&` as five. */
  attribute(value: string): void {
    let grown = 0;
    let escapes = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 34 || c === 160) {
        grown += 5;
        escapes++;
      } else if (c === 38) {
        grown += 4;
        escapes++;
      }
    }
    this.escapes += escapes;
    this.add(value.length + grown);
  }

  /** Text outside a raw-text element: `&` as five, `<` and `>` as four, no-break space as six. */
  text(value: string): void {
    let grown = 0;
    let escapes = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 38) {
        grown += 4;
        escapes++;
      } else if (c === 60 || c === 62) {
        grown += 3;
        escapes++;
      } else if (c === 160) {
        grown += 5;
        escapes++;
      }
    }
    this.escapes += escapes;
    this.add(value.length + grown);
  }

  /**
   * An element: its tags, and each attribute's name (with the `xlink:` sort of prefix), value, quotes and space,
   * and the newline that `restoreSkippedNewlines` may put back after a `<pre>`.
   */
  element(el: Tree.Element): void {
    this.add(2 * el.tagName.length + 5 + (EATS_FIRST_NEWLINE.has(el.tagName) ? 1 : 0));
    for (const attr of el.attrs) {
      this.add(attr.name.length + (attr.prefix === undefined ? 0 : attr.prefix.length + 1) + 4);
      this.attribute(attr.value);
    }
  }
}

/** Whether the serializer writes the text of this element as it is: `script`, `style` and the few more raw-text elements. */
function writesTextAsIs(node: Tree.ParentNode): boolean {
  return isElement(node) && node.namespaceURI === spec.NS.HTML && spec.hasUnescapedText(node.tagName, SERIALIZE_OPTIONS.scriptingEnabled);
}

/** Adds up the whole tree. Refuses as it goes, so what it costs is bounded by the limits, not by the tree. */
function weigh(doc: Tree.Document, weigher: Weigher): void {
  walk(doc, (parent) => {
    const asIs = writesTextAsIs(parent);
    for (const child of parent.childNodes) {
      if (isElement(child)) weigher.element(child);
      else if (tree.isTextNode(child)) {
        if (asIs) weigher.add(child.value.length);
        else weigher.text(child.value);
      } else if (tree.isCommentNode(child)) weigher.add(child.data.length + 7);
      else if (tree.isDocumentTypeNode(child)) weigher.add(child.name.length + child.publicId.length + child.systemId.length + 40);
    }
  });
}

/** What `weigh` adds up for a tree, with no limit. Exported for tests, which hold the count to what the serializer writes. */
export function weighTree(doc: Tree.Document): { weight: number; escapes: number } {
  const weigher = new Weigher(Infinity, Infinity);
  weigh(doc, weigher);
  return { weight: weigher.weight, escapes: weigher.escapes };
}

/**
 * Cuts out frame-making elements (and <noscript>) wherever they are, and the
 * shadow-root attributes from every <template>. Matching is by name in any
 * namespace, the way a CSS type selector does: an `<iframe>` parsed into SVG is
 * inert today, but it is one mutation round trip from not being. Reports
 * whether it cut anything.
 */
function scrub(doc: Tree.Document): boolean {
  let cut = false;
  walk(doc, (node) => {
    const kept: Tree.ChildNode[] = [];
    for (const child of node.childNodes) {
      if (isElement(child)) {
        // parse5 hands over lowercase names, and none of the ones we match is one of the few SVG names it re-cases.
        const name = child.tagName;
        if (FRAME_MAKERS.has(name)) {
          cut = true;
          continue;
        }
        // Everything after <plaintext> is its text, including the end tags the serializer writes, so every
        // pass reads more text than the last and the page never settles. (In SVG and MathML it is an
        // ordinary element, which settles.)
        if (name === 'plaintext' && child.namespaceURI === spec.NS.HTML) throw new Refusal('plaintext');
        if (name === 'template') {
          const attrs = child.attrs.filter((attr) => !SHADOW_ROOT_ATTRS.has(attr.name));
          if (attrs.length !== child.attrs.length) {
            child.attrs = attrs;
            cut = true;
          }
        }
      }
      kept.push(child);
    }
    node.childNodes = kept;
  });
  return cut;
}

/**
 * The parser drops one newline straight after <pre>, <listing> and <textarea>,
 * and the serializer never writes that newline back. A tree whose text starts
 * with a newline there was not ignored by the parser (the author wrote two),
 * so the serialized form needs one more or the browser eats the author's.
 */
function restoreSkippedNewlines(doc: Tree.Document): void {
  walk(doc, (node) => {
    if (!isElement(node) || node.namespaceURI !== spec.NS.HTML || !EATS_FIRST_NEWLINE.has(node.tagName)) return;
    const first = node.childNodes[0];
    if (first !== undefined && tree.isTextNode(first) && first.value.startsWith('\n')) first.value = `\n${first.value}`;
  });
}

/** A doctype identifier in the quotes it can be written in; the tokenizer ends it at the same quote, so one of the two always fits. */
function quoted(identifier: string): string {
  if (!identifier.includes('"')) return `"${identifier}"`;
  if (!identifier.includes("'")) return `'${identifier}'`;
  throw new Error('a doctype identifier holds both kinds of quote');
}

/**
 * parse5's own serializer writes `<!DOCTYPE name>` and drops the public and
 * system identifiers, which turns a legacy doctype (HTML 4.01 Transitional, say)
 * from quirks mode into standards mode. Write them back.
 */
function serializeDoctype(node: Tree.DocumentType): string {
  const ids =
    node.publicId !== ''
      ? ` PUBLIC ${quoted(node.publicId)}${node.systemId !== '' ? ` ${quoted(node.systemId)}` : ''}`
      : node.systemId !== ''
        ? ` SYSTEM ${quoted(node.systemId)}`
        : '';
  return `<!DOCTYPE ${node.name}${ids}>`;
}

/**
 * The tree adapter parse5's serializer reads the tree through: the default one,
 * with a look at the clock every CLOCK_EVERY nodes it visits. The serializer is
 * recursive and writes with `+=`, and it is the one part of a pass that calls
 * nothing of ours, so without this a page that is slow to write out (the weight
 * and escape limits bound how much there is to write, not how long a slow machine
 * takes to write it) would be written whatever the budget said. A refusal thrown
 * from here ends the serializer's recursion at once.
 */
function meteredSerializer(run: Run): TreeAdapter<DefaultTreeAdapterMap> {
  let visited = 0;
  const lap = (): void => {
    if (++visited % CLOCK_EVERY === 0) checkClock(run);
  };
  return {
    ...tree,
    getChildNodes: (node) => {
      lap();
      return tree.getChildNodes(node);
    },
    getTextNodeContent: (node) => {
      lap();
      return tree.getTextNodeContent(node);
    },
  };
}

/** The document as markup the browser parses back into the same tree. Reshapes `doc`. */
function render(doc: Tree.Document, run: Run): string {
  restoreSkippedNewlines(doc);
  const options = { ...SERIALIZE_OPTIONS, treeAdapter: meteredSerializer(run) };
  let out = '';
  for (const child of doc.childNodes) {
    out += tree.isDocumentTypeNode(child) ? serializeDoctype(child) : serializeOuter(child, options);
  }
  // Reading turns every CR and CRLF in the input into LF, so a CR in the tree
  // came from a character reference (&#13;). Written raw it would come back as
  // an LF; written as a reference it would be read as whitespace by a browser
  // and as text by parse5, which only counts tab, LF, FF and space, and ends a
  // <head> at it. Nothing legitimate spells one, so the page is refused.
  if (out.length > run.maxOutput) throw new Refusal('output_too_large');
  if (out.includes('\r')) throw new Refusal('cr_entity');
  return out;
}

/** Puts the guard first in <head>, unless it already is. */
function putGuardFirst(doc: Tree.Document): void {
  const head = headOf(doc);
  const first = head.childNodes[0];
  if (isGuardScript(first)) return;
  const script = tree.createElement('script', spec.NS.HTML, []);
  tree.insertText(script, GUARD_SCRIPT);
  if (first === undefined) tree.appendChild(head, script);
  else tree.insertBefore(head, script, first);
}

/** Looks at the clock; out of time is a refusal. */
function checkClock(run: Run): void {
  if (run.now() >= run.deadline) throw new Refusal('too_slow');
}

/**
 * The tree adapter parse5 builds the page with: the default one, with limits on
 * what it may build. Everything parse5 does to the tree goes through these
 * calls, which is what makes them a place to count and to look at the clock:
 *
 *   - nodes made (elements, text, comments, template contents), against `maxNodes`;
 *   - the stack of open elements, which parse5 reports as it pushes and pops, so
 *     a page nested past MAX_DEPTH is refused at element 513, not after the
 *     time it takes to build a hundred thousand more (every start tag scans
 *     that stack, which is what makes deep nesting quadratic);
 *   - the attributes on an element, as it is made and as `<html>`/`<body>` tags
 *     repeated in a page add theirs to the first;
 *   - the clock: on every call that has to walk a list (moving and inserting
 *     nodes, copying attributes) and once per CLOCK_EVERY of the cheap ones.
 *
 * The default adapter's own calls to itself (`insertText` making its text node)
 * don't come back through here, so the two that make text nodes are wrapped.
 */
function boundedAdapter(run: Run): TreeAdapter<DefaultTreeAdapterMap> {
  let nodes = 0;
  let open = 0;
  let lookAt = run.calls + CLOCK_EVERY;
  let heavyCalls = 0;
  const adopted = new WeakMap<Tree.Element, Set<string>>();
  const look = (): void => {
    lookAt = run.calls + CLOCK_EVERY;
    if (run.calls > run.maxCalls) throw new Refusal('too_much_work');
    checkClock(run);
  };
  const lap = (): void => {
    if (++run.calls >= lookAt) look();
  };
  // A call that can walk a long list (the child list of a node, the attributes of an element): look after
  // every 16 of them, so a flood of them can't run a thousand times as long between looks as a flood of reads.
  const heavy = (): void => {
    lap();
    if ((++heavyCalls & 15) === 0) look();
  };
  const built = (): void => {
    if (++nodes > run.maxNodes) throw new Refusal('too_many_nodes');
    lap();
  };
  const attrs = (count: number): void => {
    if (count > MAX_ATTRS) throw new Refusal('too_many_attrs');
  };
  // parse5 builds a token's text one character at a time (`value += character`), and a string made that way is
  // a chain of joins, about 32 bytes a character, until something reads it flat. Nothing did until the whole
  // page was weighed, after the parse, so a page held every character of every token as a join at once: the
  // second pass over a page that had been written out three times as long, its long attributes tokenized one
  // character at a time, needed more than 400 MB of heap and ended the process. Reading each string flat as it
  // arrives lets the joins go as the parse goes, so the heap it needs follows the biggest token and not the
  // page (measured: the 1.5x page that needed 256 to 288 MB needs under 96). `run.sink` takes the read, which
  // is all it is for.
  const flat = (value: string): string => {
    run.sink |= value.charCodeAt(0);
    return value;
  };
  const flatAttrs = (list: readonly { name: string; value: string }[]): void => {
    for (const a of list) {
      flat(a.name);
      flat(a.value);
    }
  };
  return {
    ...tree,
    createDocumentFragment: () => {
      built();
      return tree.createDocumentFragment();
    },
    createElement: (name, namespace, attributes) => {
      attrs(attributes.length);
      built();
      flatAttrs(attributes);
      return tree.createElement(name, namespace, attributes);
    },
    createCommentNode: (data) => {
      built();
      return tree.createCommentNode(flat(data));
    },
    createTextNode: (value) => {
      built();
      return tree.createTextNode(value);
    },
    insertText: (parent, text) => {
      const before = parent.childNodes.length;
      tree.insertText(parent, flat(text));
      if (parent.childNodes.length > before) built();
      else lap();
    },
    // The default adapter looks for the reference from the front of the child list. It is nearly always the
    // last child: the <table> that content is foster-parented in front of. From the front, each of N
    // foster-parented siblings costs a walk past the N before it.
    insertTextBefore: (parent, text, reference) => {
      heavy();
      flat(text);
      const siblings = parent.childNodes;
      const at = siblings.lastIndexOf(reference);
      const previous = siblings[at - 1];
      if (previous !== undefined && tree.isTextNode(previous)) {
        previous.value += text;
        return;
      }
      built();
      const node = tree.createTextNode(text);
      siblings.splice(at, 0, node);
      node.parentNode = parent;
    },
    appendChild: (parent, node) => {
      lap();
      tree.appendChild(parent, node);
    },
    insertBefore: (parent, node, reference) => {
      heavy();
      parent.childNodes.splice(parent.childNodes.lastIndexOf(reference), 0, node);
      node.parentNode = parent;
    },
    detachNode: (node) => {
      heavy();
      tree.detachNode(node);
    },
    // The default adapter builds a set of the recipient's attribute names on every call, so `<body x>` repeated
    // 100,000 times with a few hundred attributes already on the first body costs that set 100,000 times.
    adoptAttributes: (recipient, attributes) => {
      heavy();
      attrs(attributes.length);
      let names = adopted.get(recipient);
      if (names === undefined) {
        names = new Set(recipient.attrs.map((attr) => attr.name));
        adopted.set(recipient, names);
      }
      for (const attr of attributes) {
        if (names.has(attr.name)) continue;
        names.add(attr.name);
        // Only the ones that are kept (one the element already has is dropped, joins and all).
        flat(attr.name);
        flat(attr.value);
        recipient.attrs.push(attr);
      }
      attrs(recipient.attrs.length);
    },
    getTagName: (el) => {
      lap();
      return tree.getTagName(el);
    },
    getNamespaceURI: (el) => {
      lap();
      return tree.getNamespaceURI(el);
    },
    getAttrList: (el) => {
      lap();
      return tree.getAttrList(el);
    },
    getFirstChild: (node) => {
      lap();
      return tree.getFirstChild(node);
    },
    getParentNode: (node) => {
      lap();
      return tree.getParentNode(node);
    },
    getTemplateContent: (el) => {
      lap();
      return tree.getTemplateContent(el);
    },
    onItemPush: () => {
      if (++open > MAX_DEPTH) throw new Refusal('too_deep');
      lap();
    },
    onItemPop: () => {
      open--;
    },
  };
}

/** The tag the tokenizer is partway through, if it has one: its attributes so far. Not part of parse5's typed surface. */
function attributesInFlight(tokenizer: Tokenizer): number {
  const token = (tokenizer as unknown as { currentToken?: { attrs?: readonly unknown[] } | null }).currentToken;
  return token?.attrs?.length ?? 0;
}

/**
 * Makes the tokenizer look at the clock, and at the tag it is reading, every
 * `run.look` characters. It reads its input through the preprocessor's
 * `advance`, one character at a time, which is the one call it makes all the
 * time and the only one while it is inside a single tag, a comment or a long
 * script: nothing of ours runs then, and one tag with thousands of attributes
 * costs the tokenizer quadratic time. The page is still handed over whole, in
 * one write, so what it reads is exactly what plain `parse` would read.
 *
 * (Feeding it the page in pieces would be the plain way, but a piece joins what
 * the tokenizer is still holding, so one long script copies a growing buffer on
 * every piece, and giving back what it has read between pieces, which parse5 does
 * for itself at the end of a tag, corrupts a character reference that is
 * split across the cut: measured.)
 */
function watchTokenizer(tokenizer: Tokenizer, run: Run): void {
  const input = tokenizer.preprocessor;
  const advance = input.advance;
  let untilLook = run.look;
  input.advance = (): number => {
    if (--untilLook === 0) {
      untilLook = run.look;
      checkClock(run);
      if (attributesInFlight(tokenizer) > MAX_ATTRS) throw new Refusal('too_many_attrs');
    }
    return advance.call(input);
  };
}

/** parse5's `parse`, with the limits on it. */
function parseBounded(source: string, run: Run): Tree.Document {
  const parser = new Parser<DefaultTreeAdapterMap>({ ...PARSE_OPTIONS, treeAdapter: boundedAdapter(run) });
  watchTokenizer(parser.tokenizer, run);
  parser.tokenizer.write(source, true);
  return parser.document;
}

function settle(source: string, run: Run): string {
  // A NUL is the one character parse5 and Chromium, Firefox and WebKit all read
  // differently while a <head> is open: the browsers skip it and keep the head
  // going, parse5 ends the head there. Text that holds one is not text we can
  // read the way a browser will, and no real page has one.
  if (source.includes(NUL)) throw new Refusal('nul');
  let current = source;
  let mode: string | undefined;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const doc = parseBounded(current, run);
    checkClock(run);
    const modeNow = tree.getDocumentMode(doc);
    mode ??= modeNow;
    const cut = scrub(doc);
    // Before anything is written: what writing it would weigh, and how much it would have to escape.
    weigh(doc, new Weigher(run.maxOutput, run.maxEscapes));
    putGuardFirst(doc);
    checkClock(run);
    const next = render(doc, run);
    // Nothing left to cut, and writing the tree back out, guard and all, gives
    // the string we just read (so the guard was already first in <head>, and
    // this string is one parse5 reproduces from its own reading of it):
    // `current` is the page to serve.
    if (!cut && next === current) {
      if (modeNow !== mode) throw new Refusal('quirks');
      return current;
    }
    current = next;
  }
  throw new Refusal('no_fixpoint');
}

/**
 * Makes an agent-written HTML page safe to serve with the frame guard in it.
 * Strips everything that can open a child browsing context (iframe, frame,
 * frameset, object, embed, portal, fencedframe), every <noscript>, and the
 * `shadowrootmode` / `shadowroot` attributes on <template>, and puts the guard
 * script first in <head>. Takes the page decoded as UTF-8 the way a browser
 * would (`new TextDecoder().decode(bytes)`, which drops a leading byte order
 * mark; a U+FEFF left at the start is the page's own text, as it is to a
 * browser) and returns it to be served as UTF-8 (`text/html; charset=utf-8`).
 *
 * Answers `{ ok: true, html }`, or `{ ok: false, reason }` when it can't vouch
 * for the result, and the caller must refuse the page. The reason is a fixed
 * code (`PrepareRefusal`) for the caller's log; none of them says anything
 * about the page. The causes: it holds a NUL character or a carriage return
 * written as a character reference (&#13;); the markup never settles
 * (`<plaintext>`, or re-reading it keeps revealing frame-makers); it nests
 * deeper than a browser does; its doctype can't be written back without
 * changing the page's quirks mode; parsing it would build more nodes, or give
 * one element more attributes, or take longer, than any real page does; the
 * result would be more than one and a half times the page's size; or the parser threw. It never
 * throws.
 *
 * The page is rebuilt from a parse, so it comes back normalized (implied
 * html/head/body made explicit, attributes double-quoted, comments and text
 * kept as they were parsed), but it renders as before apart from what was cut
 * and two things that differ: parse5 keeps only option, optgroup, hr, script
 * and template inside a <select>, while Chromium 147 keeps more (a div, a
 * button, an img), so that content is lost; and a
 * <script> the page never closed (it ends the document) is closed, so it runs,
 * where a browser would have skipped it. No doctype is added or removed.
 * Calling it on its own output returns that output unchanged.
 *
 * Synchronous, on the caller's thread: run it where holding the thread does not
 * matter, as the content origin does, on a worker (`createHtmlPreparer`). It is
 * bounded by what the parse builds, what the serializer would have to escape and
 * the clock (500 ms of this thread's CPU unless the caller gives more), not by the
 * page's size (see the limits above). Measured on 86 shapes of 4 MiB each, hostile
 * and ordinary: a page of markup costs about 0.15 s of CPU per MB and one of script
 * or text about 0.1 s (3 to 4 MiB of either, 0.3 to 0.5 s; a 4 MiB comment is the
 * dearest, 0.475 s). The slowest refusal of a shape the clock does not have to stop
 * is 0.39 s (4 MiB of `&`), most are refused in under 0.1 s, and a page that holds
 * the budget is stopped at it, give or take the longest stretch nothing here can
 * look at the clock in (10 to 45 ms measured). Still hand it a bounded page: even a
 * refusal costs the time it took to get there.
 *
 * `limits` is for tests; leave it out.
 */
export function prepareArtifactHtml(html: string, limits: PrepareLimits = {}): PrepareResult {
  try {
    const now = limits.now ?? defaultClock;
    const run: Run = {
      now,
      calls: 0,
      deadline: now() + (limits.budgetMs ?? BUDGET_MS),
      maxNodes: limits.maxNodes ?? MAX_NODES,
      maxCalls: limits.maxCalls ?? MAX_CALLS,
      maxEscapes: limits.maxEscapes ?? MAX_ESCAPES,
      sink: 0,
      look: Math.max(1, Math.floor(limits.lookEvery ?? LOOK_EVERY)),
      maxOutput: OUTPUT_FACTOR * html.length + OUTPUT_SLACK,
    };
    return { ok: true, html: settle(html, run) };
  } catch (err) {
    return { ok: false, reason: err instanceof Refusal ? err.reason : 'parse_error' };
  }
}
