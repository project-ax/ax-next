import {
  defaultTreeAdapter as tree,
  html as spec,
  parse,
  serializeOuter,
  type DefaultTreeAdapterTypes as Tree,
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
// answer to "I can't be sure" is null: the caller serves its ordinary 404.

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
 * recursive serializer well clear of the call stack limit.
 */
const MAX_DEPTH = 512;

const NUL = '\u0000';

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
      if (depth + 1 > MAX_DEPTH) throw new Error(`nested more than ${MAX_DEPTH} elements deep`);
      pending.push([child, depth + 1]);
      const content = templateContent(child);
      if (content !== null) pending.push([content, depth + 1]);
    }
  }
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

/** The document as markup the browser parses back into the same tree. Reshapes `doc`. */
function render(doc: Tree.Document): string {
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
  if (out.includes('\r')) throw new Error('the page holds a carriage return written as a character reference');
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

function settle(source: string): string | null {
  // A NUL is the one character parse5 and Chromium, Firefox and WebKit all read
  // differently while a <head> is open: the browsers skip it and keep the head
  // going, parse5 ends the head there. Text that holds one is not text we can
  // read the way a browser will, and no real page has one.
  if (source.includes(NUL)) return null;
  let current = source;
  let mode: string | undefined;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const doc = parse(current, PARSE_OPTIONS);
    const modeNow = tree.getDocumentMode(doc);
    mode ??= modeNow;
    const cut = scrub(doc);
    putGuardFirst(doc);
    const next = render(doc);
    // Nothing left to cut, and writing the tree back out, guard and all, gives
    // the string we just read (so the guard was already first in <head>, and
    // this string is one parse5 reproduces from its own reading of it):
    // `current` is the page to serve.
    if (!cut && next === current) return modeNow === mode ? current : null;
    current = next;
  }
  return null;
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
 * Returns null when it can't vouch for the result, and the caller must refuse
 * the page: it holds a NUL character or a carriage return written as a
 * character reference (&#13;), the markup never settles (re-reading it keeps
 * revealing frame-makers, or keeps changing as `<plaintext>` does), it nests
 * deeper than a browser does, its doctype can't be written back without
 * changing the page's quirks mode, or the parser threw. It never throws.
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
 * Synchronous and linear in the page size (a few parses of it), on the
 * caller's thread: roughly 0.15 to 0.2 s per MB of HTML, so bound what you hand it.
 */
export function prepareArtifactHtml(html: string): string | null {
  try {
    return settle(html);
  } catch {
    return null;
  }
}
