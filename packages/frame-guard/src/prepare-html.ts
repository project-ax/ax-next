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
 * that whatever the size of the page. It is also the biggest thing a page can
 * ask of the thread without breaking a limit: parsing and writing out 150,000
 * nodes twice takes about 0.3 s here (the costliest shape measured, 140,000
 * `<input>`s), and that is the worst case of this transform.
 */
const MAX_NODES = 150_000;

/**
 * Calls parse5 may make to the tree adapter, over every pass of one transform. It reads the tree
 * through the adapter for everything it checks, so this counts the work of its
 * scans, which node counts don't: 500 open elements and then a million `</i>`,
 * each of which looks through all 500, builds no nodes at all. A real page makes
 * under one call per character of HTML (measured: 0.01 to 0.9; a table of
 * numbers is the top), so even 4 MiB of it needs under 8 million over its two
 * passes; this is 25 million, about a quarter of a second of parse5's time,
 * which is where that scan page is stopped.
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
 * into six. A real page comes back at about its own size.
 */
const OUTPUT_FACTOR = 4;
const OUTPUT_SLACK = 64 * 1024;

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
 * The time one call may take, of this thread's CPU: a floor, plus a share for
 * each MiB of page. The limits above stop every shape measured in a quarter of
 * a second or less; this is the backstop for the ones nobody has found. It has
 * to leave room for the biggest ordinary pages (4 MiB of script or inlined data
 * takes 0.4 s on a fast machine, an ordinary page under 0.05 s) on a host that
 * is slower: about four times what the biggest takes, and ten for the usual page.
 */
const BUDGET_BASE_MS = 400;
const BUDGET_PER_MIB_MS = 300;

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
  /** The result would be far larger than the page. */
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

/**
 * Knobs for tests: the defaults are the policy. Each one lets a test cross a
 * limit with a small page, or take the clock out of the picture.
 */
export interface PrepareLimits {
  /** Milliseconds the whole call may take. Default: `BUDGET_BASE_MS` plus `BUDGET_PER_MIB_MS` per MiB of page. */
  budgetMs?: number;
  /** Nodes one parse may build. Default: `MAX_NODES`. */
  maxNodes?: number;
  /** Tree adapter calls the whole transform may make. Default: `MAX_CALLS`. */
  maxCalls?: number;
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

/** About what an element weighs written out: its tags, and each attribute's name, value, quotes and space. */
function elementWeight(el: Tree.Element): number {
  let weight = 2 * el.tagName.length + 5;
  for (const attr of el.attrs) weight += attr.name.length + attr.value.length + 4;
  return weight;
}

/**
 * Cuts out frame-making elements (and <noscript>) wherever they are, and the
 * shadow-root attributes from every <template>. Matching is by name in any
 * namespace, the way a CSS type selector does: an `<iframe>` parsed into SVG is
 * inert today, but it is one mutation round trip from not being. Reports
 * whether it cut anything.
 *
 * It also adds up what the rest weighs written out, and refuses before anything
 * is written if that is more than `maxOutput`: the parser shares an element's
 * attribute list with every copy it makes of the element, so a tree of a few
 * hundred nodes can still be gigabytes of markup.
 */
function scrub(doc: Tree.Document, maxOutput: number): boolean {
  let cut = false;
  let weight = 0;
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
        weight += elementWeight(child);
      } else if (tree.isTextNode(child)) {
        weight += child.value.length;
      } else if (tree.isCommentNode(child)) {
        weight += child.data.length + 7;
      }
      kept.push(child);
    }
    node.childNodes = kept;
    if (weight > maxOutput) throw new Refusal('output_too_large');
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

/** The document as markup the browser parses back into the same tree. Reshapes `doc`. */
function render(doc: Tree.Document, maxOutput: number): string {
  restoreSkippedNewlines(doc);
  let out = '';
  for (const child of doc.childNodes) {
    out += tree.isDocumentTypeNode(child) ? serializeDoctype(child) : serializeOuter(child, SERIALIZE_OPTIONS);
  }
  // Reading turns every CR and CRLF in the input into LF, so a CR in the tree
  // came from a character reference (&#13;). Written raw it would come back as
  // an LF; written as a reference it would be read as whitespace by a browser
  // and as text by parse5, which only counts tab, LF, FF and space, and ends a
  // <head> at it. Nothing legitimate spells one, so the page is refused.
  if (out.length > maxOutput) throw new Refusal('output_too_large');
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
  return {
    ...tree,
    createDocumentFragment: () => {
      built();
      return tree.createDocumentFragment();
    },
    createElement: (name, namespace, attributes) => {
      attrs(attributes.length);
      built();
      return tree.createElement(name, namespace, attributes);
    },
    createCommentNode: (data) => {
      built();
      return tree.createCommentNode(data);
    },
    createTextNode: (value) => {
      built();
      return tree.createTextNode(value);
    },
    insertText: (parent, text) => {
      const before = parent.childNodes.length;
      tree.insertText(parent, text);
      if (parent.childNodes.length > before) built();
      else lap();
    },
    // The default adapter looks for the reference from the front of the child list. It is nearly always the
    // last child: the <table> that content is foster-parented in front of. From the front, each of N
    // foster-parented siblings costs a walk past the N before it.
    insertTextBefore: (parent, text, reference) => {
      heavy();
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
    const cut = scrub(doc, run.maxOutput);
    putGuardFirst(doc);
    checkClock(run);
    const next = render(doc, run.maxOutput);
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

/** What a call may take: a floor, and a share per MiB of page. */
function budgetFor(chars: number): number {
  return BUDGET_BASE_MS + (BUDGET_PER_MIB_MS * chars) / (1024 * 1024);
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
 * result would be several times the page's size; or the parser threw. It never
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
 * Synchronous, on the caller's thread, and bounded by what the parse builds
 * and by the clock, not by the page's size (see the limits above): an ordinary
 * page takes under a quarter of a second per MB of HTML (two parses of it; 4 MiB
 * of script is 0.4 s), and every hostile shape measured is refused in under a
 * second, most in milliseconds (the costliest page that stays inside every
 * limit is about 0.3 s). Still hand it a bounded page: even a refusal costs the
 * time it took to get there.
 *
 * `limits` is for tests; leave it out.
 */
export function prepareArtifactHtml(html: string, limits: PrepareLimits = {}): PrepareResult {
  try {
    const now = limits.now ?? defaultClock;
    const run: Run = {
      now,
      calls: 0,
      deadline: now() + (limits.budgetMs ?? budgetFor(html.length)),
      maxNodes: limits.maxNodes ?? MAX_NODES,
      maxCalls: limits.maxCalls ?? MAX_CALLS,
      look: Math.max(1, Math.floor(limits.lookEvery ?? LOOK_EVERY)),
      maxOutput: OUTPUT_FACTOR * html.length + OUTPUT_SLACK,
    };
    return { ok: true, html: settle(html, run) };
  } catch (err) {
    return { ok: false, reason: err instanceof Refusal ? err.reason : 'parse_error' };
  }
}
