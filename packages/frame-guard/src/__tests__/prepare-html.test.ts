import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultTreeAdapter as tree, parse, serialize, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import { CHILD_FRAME_TAGS, DSD_ATTRS, FRAME_GUARD_SOURCE, prepareArtifactHtml as transform } from '../index.js';
import { HOSTILE_VECTORS, NEWLINE_PAGES, REALISTIC_PAGE, STRUCTURE_PAGES as STRUCTURES, TEXT_VECTORS } from './prepare-html-corpus.js';

// prepareArtifactHtml takes an agent's page and hands back the page to serve:
// frame-making markup cut out, the guard first in <head>. These tests read the
// result the way a browser would (parse5 with scripting on, the same setting
// the transform parses with) and check the guard script by running it in
// jsdom. They cannot show that a real browser agrees with parse5; that check
// loads the same corpus into Chromium (see the T4 notes in the plan).

// ---- reading a result -------------------------------------------------------

/** The page, or null when it was refused: the assertions that only care whether it was served. */
function prepare(html: string): string | null {
  const result = transform(html);
  return result.ok ? result.html : null;
}

/** Why a page was refused, or 'served' when it was not. */
function verdict(html: string): string {
  const result = transform(html);
  return result.ok ? 'served' : result.reason;
}

/** What a frame-making page looks like to a parse: these names, wherever they are. */
const FRAME_MAKING = ['iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe', 'noscript'];
const SHADOW_ROOT_ATTRS = ['shadowrootmode', 'shadowroot'];

const read = (html: string): Tree.Document => parse(html, { scriptingEnabled: true });

/** Every element under `root`, <template> contents included. */
function elementsOf(root: Tree.ParentNode): Tree.Element[] {
  const found: Tree.Element[] = [];
  const pending: Tree.ParentNode[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const child of node.childNodes) {
      if (!tree.isElementNode(child)) continue;
      found.push(child);
      pending.push(child);
      if ('content' in child) pending.push((child as Tree.Template).content);
    }
  }
  return found;
}

/** What a parse of `html` finds that the transform exists to remove. Empty is the goal. */
function dangerIn(html: string): string[] {
  const found: string[] = [];
  for (const el of elementsOf(read(html))) {
    const name = el.tagName.toLowerCase();
    if (FRAME_MAKING.includes(name)) found.push(name);
    if (name === 'template') {
      for (const attr of el.attrs) if (SHADOW_ROOT_ATTRS.includes(attr.name.toLowerCase())) found.push(`template[${attr.name}]`);
    }
  }
  return found;
}

function headOf(html: string): Tree.Element {
  const root = read(html).childNodes.find((n): n is Tree.Element => tree.isElementNode(n) && n.tagName === 'html');
  const head = root?.childNodes.find((n): n is Tree.Element => tree.isElementNode(n) && n.tagName === 'head');
  if (head === undefined) throw new Error('no <head> in the result');
  return head;
}

function textOf(node: Tree.Node): string {
  if (tree.isTextNode(node)) return node.value;
  if (!('childNodes' in node)) return '';
  const own = node.childNodes.map(textOf).join('');
  return 'content' in node ? own + (node as Tree.Template).content.childNodes.map(textOf).join('') : own;
}

/** The text a reader sees: the body's, not the head's scripts. */
function bodyTextOf(html: string): string {
  const body = elementsOf(read(html)).find((e) => e.tagName === 'body');
  return body === undefined ? '' : textOf(body);
}

const modeOf = (html: string) => tree.getDocumentMode(read(html));

function doctypeOf(html: string): { name: string; publicId: string; systemId: string } | null {
  const node = read(html).childNodes.find((n): n is Tree.DocumentType => tree.isDocumentTypeNode(n));
  return node === undefined ? null : { name: node.name, publicId: node.publicId, systemId: node.systemId };
}

/** The guard script, if `html` has one first in <head>: its text. */
function leadingGuardText(html: string): string | null {
  const first = headOf(html).childNodes[0];
  if (first === undefined || !tree.isElementNode(first) || first.tagName !== 'script' || first.attrs.length > 0) return null;
  const text = first.childNodes[0];
  return text !== undefined && tree.isTextNode(text) && text.value.startsWith(FRAME_GUARD_SOURCE) ? text.value : null;
}

/** How many scripts in `html` carry the guard. */
const guardsIn = (html: string) => html.split('window.axFrameGuard = function axFrameGuard(').length - 1;

const GUARD = '<GUARD/>';

/** The page with its guard script swapped for a marker, so an expectation can spell out the rest exactly. */
function unguarded(out: string): string {
  const open = out.indexOf(`<script>${FRAME_GUARD_SOURCE}`);
  expect(open, 'the page should carry the guard script').toBeGreaterThanOrEqual(0);
  const close = out.indexOf('</script>', open) + '</script>'.length;
  return out.slice(0, open) + GUARD + out.slice(close);
}

function prepared(html: string): string {
  const result = transform(html);
  if (!result.ok) throw new Error(`expected a page, got "${result.reason}" for ${JSON.stringify(html.slice(0, 120))}`);
  return result.html;
}

/** The page's body (and head) with the guard marker, for exact expectations. */
const page = (html: string) => unguarded(prepared(html));
const GUARDED_HEAD = `<html><head>${GUARD}</head><body>`;

// ---- the guard script --------------------------------------------------------

describe('the guard script', () => {
  it('goes first in the head of a fragment, exactly', () => {
    expect(page('<div>hi</div>')).toBe(`${GUARDED_HEAD}<div>hi</div></body></html>`);
  });

  it('goes first in the head of a full document, and nothing else about the document moves', () => {
    expect(page(STRUCTURES['a full document']!)).toBe(
      `<!DOCTYPE html><html lang="en"><head>${GUARD}<meta charset="utf-8"><title>T</title></head><body class="a"><h1>Hi</h1></body></html>`,
    );
  });

  it('makes a page out of nothing at all', () => {
    expect(page('')).toBe(`${GUARDED_HEAD}</body></html>`);
  });

  it('is a plain inline script: the guard source, then a call that starts it, logs a kill, and removes the global', () => {
    const out = prepared('<p>x</p>');
    const text = leadingGuardText(out);
    expect(text).not.toBeNull();
    expect(text!.slice(FRAME_GUARD_SOURCE.length)).toBe(
      '\nwindow.axFrameGuard(window,{onKill:function(){try{console.warn("blocked: this page tried to open a nested frame")}catch(e){}}});delete window.axFrameGuard;',
    );
    expect(text!.toLowerCase()).not.toContain('</script');
    expect(text).not.toContain('<!--');
    // The element itself is bare: no type, src, defer, async or nonce for a parser to treat differently.
    expect(out).toContain(`<head><script>${FRAME_GUARD_SOURCE}`);
  });

  it.each(Object.entries(STRUCTURES))('is the first child of <head> for %s', (_name, html) => {
    const out = prepared(html);
    expect(leadingGuardText(out)).not.toBeNull();
    expect(guardsIn(out)).toBe(1);
  });

  it('comes before a script the page already had in front of its head', () => {
    expect(page(STRUCTURES['a script before <head>']!)).toBe(
      `<html><head>${GUARD}<script>window.early = 1</script><title>t</title></head><body>b</body></html>`,
    );
  });

  it('comes before the comments and whitespace that open a head', () => {
    expect(page(STRUCTURES['whitespace and a comment first in <head>']!)).toBe(
      `<html><head>${GUARD}\n  <!-- c -->\n  <meta charset="utf-8"></head><body></body></html>`,
    );
  });

  it('is built for a page with no head at all', () => {
    expect(page('<html><body>b</body></html>')).toBe(`${GUARDED_HEAD}b</body></html>`);
  });

  it('keeps comments where they were: before the doctype, and after the document', () => {
    expect(page(STRUCTURES['comments before the doctype']!)).toBe(
      `<!-- one --><!-- two --><!DOCTYPE html>${GUARDED_HEAD}<p>x</p></body></html>`,
    );
    expect(page(STRUCTURES['a comment after </html>']!)).toBe(`${GUARDED_HEAD}x</body></html><!-- tail -->`);
  });

  it('leaves the agent head content in order after it', () => {
    expect(page(STRUCTURES['a <head> that never closes']!)).toBe(
      `<html><head>${GUARD}<title>t</title></head><body>b</body></html>`,
    );
    expect(page(STRUCTURES['two <head> elements']!)).toBe(
      `<html><head>${GUARD}<meta charset="utf-8"><title>t</title></head><body>b</body></html>`,
    );
    expect(page(STRUCTURES['a <head> with attributes']!)).toBe(
      `<html><head profile="x" class="y">${GUARD}<title>t</title></head><body>b</body></html>`,
    );
  });
});

// ---- what gets cut -------------------------------------------------------------

describe('frame-making markup', () => {
  it('is the list the guard package exports', () => {
    expect([...CHILD_FRAME_TAGS].sort()).toEqual([...FRAME_MAKING].sort());
    expect([...DSD_ATTRS].sort()).toEqual([...SHADOW_ROOT_ATTRS].sort());
  });

  it.each(FRAME_MAKING)('cuts <%s> out from between two paragraphs', (tag) => {
    expect(page(`<p>a</p><${tag} src="x"></${tag}><p>b</p>`)).toBe(`${GUARDED_HEAD}<p>a</p><p>b</p></body></html>`);
  });

  it.each(SHADOW_ROOT_ATTRS)('cuts the %s attribute off a template and keeps what is inside it', (attr) => {
    expect(page(`<div><template ${attr}="closed"><p>in</p></template></div>`)).toBe(
      `${GUARDED_HEAD}<div><template><p>in</p></template></div></body></html>`,
    );
  });

  it('cuts an iframe and what it swallowed when it is never closed', () => {
    expect(page('<p>before</p><iframe srcdoc="x"><p>after</p>')).toBe(`${GUARDED_HEAD}<p>before</p></body></html>`);
  });

  it('cuts an iframe out of a table, where the parser first moves it in front of the table', () => {
    expect(page('<table><iframe srcdoc="x"></iframe><tr><td>cell</td></tr></table>')).toBe(
      `${GUARDED_HEAD}<table><tbody><tr><td>cell</td></tr></tbody></table></body></html>`,
    );
  });

  it('cuts a closed shadow root and the frame inside it', () => {
    expect(page('<div><template shadowrootmode="closed"><iframe srcdoc="x"></iframe></template></div>')).toBe(
      `${GUARDED_HEAD}<div><template></template></div></body></html>`,
    );
  });

  it('cuts shadow-root attributes at every level of nested templates', () => {
    const html =
      '<div><template shadowrootmode="open"><div><template shadowrootmode="closed"><iframe srcdoc="x"></iframe></template></div></template></div>';
    expect(page(html)).toBe(`${GUARDED_HEAD}<div><template><div><template></template></div></template></div></body></html>`);
  });

  it('cuts a frame out of svg and mathml integration points', () => {
    expect(page('<svg><foreignObject><iframe srcdoc="x"></iframe><p>keep</p></foreignObject></svg>')).toBe(
      `${GUARDED_HEAD}<svg><foreignObject><p>keep</p></foreignObject></svg></body></html>`,
    );
    expect(page('<math><annotation-xml encoding="text/html"><object data="x"></object></annotation-xml></math>')).toBe(
      `${GUARDED_HEAD}<math><annotation-xml encoding="text/html"></annotation-xml></math></body></html>`,
    );
  });

  it('cuts a frame set document down to a blank page with the guard in it', () => {
    expect(page(STRUCTURES['a frameset document']!)).toBe(
      `<!DOCTYPE html><html><head>${GUARD}<title>f</title></head><body></body></html>`,
    );
  });

  it('cuts <noscript> and keeps reading the way a browser with scripts on does', () => {
    // Scripts on: the noscript body ends at the first </noscript>, so the iframe after it is a real iframe and
    // the stray quote and bracket are text. Scripts off would read a <p> with a long title and no iframe at all.
    expect(page('<noscript><p title="</noscript><iframe src=x></iframe>"></noscript><div id=after>after</div>')).toBe(
      `${GUARDED_HEAD}"&gt;<div id="after">after</div></body></html>`,
    );
  });

  it('drops what parse5 refuses to keep inside a <select> instead of passing it on', () => {
    // A newer browser keeps some of these; the page we serve is rebuilt from parse5's tree, so none of it reaches
    // the browser to be read the other way.
    const out = page('<select><iframe srcdoc="x"></iframe><div><object data="x"></object></div><option>a</option></select>');
    expect(out).toBe(`${GUARDED_HEAD}<select><option>a</option></select></body></html>`);
  });

  it.each(HOSTILE_VECTORS.map((v) => [v.name, v.html] as const))('leaves nothing to cut after: %s', (_name, html) => {
    const out = prepared(html);
    expect(dangerIn(out)).toEqual([]);
    expect(leadingGuardText(out)).not.toBeNull();
    expect(prepare(out)).toBe(out);
  });

  it('has a corpus whose size is pinned, so deleting rows is noticed (and adding some means updating this)', () => {
    expect(HOSTILE_VECTORS).toHaveLength(72);
    expect(TEXT_VECTORS).toHaveLength(17);
    expect(Object.keys(STRUCTURES)).toHaveLength(24);
    expect(NEWLINE_PAGES).toHaveLength(15);
  });

  it('writes shadowrootmode and shadowroot out in no spelling', () => {
    for (const vector of HOSTILE_VECTORS) {
      const body = unguarded(prepared(vector.html));
      expect(body.toLowerCase(), vector.name).not.toMatch(/<template[^>]*\sshadowroot(mode)?[\s=>]/);
    }
  });
});

describe('markup that only talks about frames', () => {
  it.each(TEXT_VECTORS.map((v) => [v.name, v] as const))('keeps %s as text', (_name, v) => {
    const out = prepared(v.html);
    expect(dangerIn(out)).toEqual([]);
    for (const piece of v.keep) expect(out).toContain(piece);
    expect(prepare(out)).toBe(out);
  });
});

describe('markup that only turns into a frame when it is written out and read back', () => {
  // The first two look clean as written; serializing the tree and parsing the
  // result grows an iframe (mutation XSS: the namespace a <style> or <img>
  // lands in changes with the second parse). The third has a frame to cut and
  // another behind it. A browser agrees on all of them (the Chromium run in
  // the T4 notes), so a transform that cuts once and ships would ship a frame.
  const REVEALED = HOSTILE_VECTORS.filter((v) => v.name.startsWith('revealed:'));

  /** One round of what a single-pass transform would do: parse, cut, write out. */
  function cutOnce(html: string): string {
    const doc = read(html);
    for (const el of elementsOf(doc)) {
      const name = el.tagName.toLowerCase();
      if (FRAME_MAKING.includes(name) && el.parentNode !== null) {
        el.parentNode.childNodes = el.parentNode.childNodes.filter((c) => c !== el);
      } else if (name === 'template') {
        el.attrs = el.attrs.filter((a) => !SHADOW_ROOT_ATTRS.includes(a.name.toLowerCase()));
      }
    }
    return serialize(doc, { scriptingEnabled: true });
  }

  it('has vectors for it', () => {
    expect(REVEALED).toHaveLength(4);
  });

  it.each(REVEALED.map((v) => [v.name, v.html] as const))('needs a second pass, and gets one: %s', (_name, html) => {
    expect(dangerIn(cutOnce(html)), 'one cut-and-write-out round leaves something to cut').not.toEqual([]);
    expect(dangerIn(prepared(html))).toEqual([]);
  });
});

// ---- pages that must survive ----------------------------------------------------

describe('quirks mode', () => {
  it('keeps a page with no doctype free of one', () => {
    const out = prepared('<p>x</p>');
    expect(out).not.toMatch(/<!doctype/i);
    expect(doctypeOf(out)).toBeNull();
    expect(modeOf(out)).toBe('quirks');
  });

  it('keeps <!doctype html> and standards mode', () => {
    const out = prepared('<!doctype html><p>x</p>');
    expect(out.startsWith('<!DOCTYPE html><html>')).toBe(true);
    expect(modeOf(out)).toBe('no-quirks');
  });

  const DOCTYPES: Array<[string, string, string]> = [
    ['html5', '<!DOCTYPE html>', 'no-quirks'],
    ['html4 strict', '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">', 'no-quirks'],
    ['html4 transitional, no system identifier', '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">', 'quirks'],
    ['html4 transitional, with one', '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">', 'limited-quirks'],
    ['xhtml 1.0 transitional', '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">', 'limited-quirks'],
    ['xhtml 1.0 strict', '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">', 'no-quirks'],
    ['legacy compat', '<!DOCTYPE html SYSTEM "about:legacy-compat">', 'no-quirks'],
    ['html 3.2, single quotes', "<!DOCTYPE html PUBLIC '-//W3C//DTD HTML 3.2 Final//EN'>", 'quirks'],
    ['an identifier with an apostrophe in it', `<!DOCTYPE html PUBLIC "-//Acme's//DTD//EN" "x">`, 'no-quirks'],
    ['an identifier with a double quote in it', `<!DOCTYPE html PUBLIC '-//Acme"s//DTD//EN' 'x'>`, 'no-quirks'],
    ['a name that is not html', '<!DOCTYPE foo>', 'quirks'],
    ['no name at all', '<!DOCTYPE>', 'quirks'],
  ];

  it.each(DOCTYPES)('writes the doctype back as it was and keeps the mode: %s', (_name, doctype, mode) => {
    const html = `${doctype}<p>x</p>`;
    expect(modeOf(html), 'the input itself').toBe(mode);
    const out = prepared(html);
    expect(modeOf(out)).toBe(mode);
    expect(doctypeOf(out)).toEqual(doctypeOf(html));
  });

  it('writes the identifiers out quoted so they read back the same', () => {
    expect(page(`<!DOCTYPE html PUBLIC "-//Acme's//DTD//EN" "x">`)).toBe(`<!DOCTYPE html PUBLIC "-//Acme's//DTD//EN" "x">${GUARDED_HEAD}</body></html>`);
    expect(page(`<!DOCTYPE html PUBLIC '-//Acme"s//DTD//EN' 'x'>`)).toBe(`<!DOCTYPE html PUBLIC '-//Acme"s//DTD//EN' "x">${GUARDED_HEAD}</body></html>`);
  });

  it('refuses a doctype whose quirks mode it cannot write back, rather than change the page', () => {
    // The mode comes from a flag the tokenizer sets on malformed doctypes, which the tree does not keep.
    for (const doctype of ['<!DOCTYPE html foo>', '<!DOCTYPE html PUBLIC>', '<!DOCTYPE html "x">']) {
      expect(modeOf(`${doctype}<p>x</p>`), doctype).toBe('quirks');
      expect(verdict(`${doctype}<p>x</p>`), doctype).toBe('quirks');
    }
  });

  it('refuses an empty system identifier that decides between quirks and limited-quirks', () => {
    // `""` and a missing identifier are different to the browser and the same in parse5's tree.
    const html = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "">';
    expect(modeOf(`${html}<p>x</p>`)).toBe('limited-quirks');
    expect(verdict(`${html}<p>x</p>`)).toBe('quirks');
  });
});

describe('the newline a parser drops after <pre>, <listing> and <textarea>', () => {
  /** The text a reader gets from the first element of this name: all of it, not just a leading text node. */
  const textContentOf = (html: string, name: string): string | undefined => {
    const el = elementsOf(read(html)).find((e) => e.tagName === name);
    return el === undefined ? undefined : textOf(el);
  };

  it.each(NEWLINE_PAGES.map((c) => [...c] as [string, string, string]))('keeps the text a browser would show: %s', (_name, html, tag) => {
    const out = prepared(html);
    const before = textContentOf(html, tag);
    expect(before, 'the input has such an element').toBeDefined();
    expect(textContentOf(out, tag)).toBe(before);
  });

  it('counts the newline after a cut element as the author\'s, since nothing ahead of it ate one', () => {
    expect(page('<pre><iframe srcdoc="x"></iframe>\nfoo</pre>')).toBe(`${GUARDED_HEAD}<pre>\n\nfoo</pre></body></html>`);
  });

  it('writes the missing newline back into the markup', () => {
    expect(page('<pre>\n\nfoo</pre>')).toBe(`${GUARDED_HEAD}<pre>\n\nfoo</pre></body></html>`);
    expect(page('<pre>\nfoo</pre>')).toBe(`${GUARDED_HEAD}<pre>foo</pre></body></html>`);
    expect(page('<textarea>\n\nfoo</textarea>')).toBe(`${GUARDED_HEAD}<textarea>\n\nfoo</textarea></body></html>`);
    expect(page('<listing>\n\nfoo</listing>')).toBe(`${GUARDED_HEAD}<listing>\n\nfoo</listing></body></html>`);
    expect(page('<div><template><pre>\n\nfoo</pre></template></div>')).toBe(`${GUARDED_HEAD}<div><template><pre>\n\nfoo</pre></template></div></body></html>`);
  });
});

describe('text, entities and attributes', () => {
  it('keeps the characters the author meant', () => {
    const html = '<p title="a &amp; b &quot;q&quot; &lt;i&gt;">&amp; &lt;b&gt; " &#169; &copy; &nbsp;| &#x1F600; &bogus; &amp</p>';
    const out = prepared(html);
    expect(bodyTextOf(out)).toBe(bodyTextOf(html));
    expect(elementsOf(read(out)).find((e) => e.tagName === 'p')?.attrs).toEqual(elementsOf(read(html)).find((e) => e.tagName === 'p')?.attrs);
    // Characters stay characters; only the ones HTML needs escaped are escaped.
    expect(out).toContain('&amp; &lt;b&gt; " © © &nbsp;| 😀 &amp;bogus; &amp;</p>');
  });

  it('keeps non-ASCII text as characters', () => {
    const text = 'héllo 日本語 😀 שלום ñ é ‏';
    const out = prepared(`<p title="é😀">${text}</p>`);
    expect(out).toContain(`<p title="é😀">${text}</p>`);
  });

  it('leaves the text of scripts and styles exactly as written', () => {
    const script = 'window.x = a < b && c > d; var s = "</div>"; /* <!-- */';
    const style = 'p > a::before { content: "<"; } /* & */';
    const out = prepared(`<style>${style}</style><script>${script}</script>`);
    expect(out).toContain(`<style>${style}</style>`);
    expect(out).toContain(`<script>${script}</script>`);
  });

  it('keeps svg, with the case its attributes and elements need', () => {
    const svg = '<svg viewBox="0 0 10 10"><linearGradient id="g"></linearGradient><use xlink:href="#g"></use><foreignObject><p>x</p></foreignObject></svg>';
    expect(page(svg)).toBe(`${GUARDED_HEAD}${svg}</body></html>`);
  });

  it('normalizes the way a parser does, and no further', () => {
    expect(page('<br/><img src=a.png alt><input disabled><P CLASS=A>x<p>y')).toBe(
      `${GUARDED_HEAD}<br><img src="a.png" alt=""><input disabled=""><p class="A">x</p><p>y</p></body></html>`,
    );
    expect(page('<table><tr><td>1</td></tr></table>')).toBe(`${GUARDED_HEAD}<table><tbody><tr><td>1</td></tr></tbody></table></body></html>`);
    // A script that never ends is closed (so it now runs, where a browser skips one cut off by the end of the
    // document; measured in Chromium), and a script this early belongs to the head.
    expect(page('<script>alert(1)')).toBe(`<html><head>${GUARD}<script>alert(1)</script></head><body></body></html>`);
  });

  it('keeps a page that mixes everything an artifact usually has', () => {
    const out = prepared(REALISTIC_PAGE);
    // Only what a parse normalizes changes: the doctype's spelling, and the newline right after <pre>.
    expect(unguarded(out)).toBe(
      REALISTIC_PAGE.replace('<!doctype html>', '<!DOCTYPE html>')
        .replace('<head>', `<head>${GUARD}`)
        .replace('<pre>\n  indented', '<pre>  indented'),
    );
  });
});

// ---- running it twice -----------------------------------------------------------

describe('running it on its own output', () => {
  const ALL: Array<[string, string]> = [
    ...Object.entries(STRUCTURES),
    ...HOSTILE_VECTORS.map((v) => [v.name, v.html] as [string, string]),
    ...TEXT_VECTORS.map((v) => [v.name, v.html] as [string, string]),
  ];

  it.each(ALL)('gives the same string back: %s', (_name, html) => {
    const once = prepared(html);
    expect(prepare(once)).toBe(once);
  });

  it('does not put a second guard in a page that already has one first', () => {
    const once = prepared('<head><title>t</title></head><body>x</body>');
    expect(guardsIn(once)).toBe(1);
    expect(guardsIn(prepared(once))).toBe(1);
  });

  it('accepts the guard it would have written, wherever the rest of the page came from', () => {
    const guard = leadingGuardText(prepared('<p>x</p>'))!;
    const withGuard = `<head><script>${guard}</script><title>t</title></head><body>x</body>`;
    expect(prepared(withGuard)).toBe(prepared('<head><title>t</title></head><body>x</body>'));
  });

  it('does not trust a copy of the guard that is not first', () => {
    const guard = leadingGuardText(prepared('<p>x</p>'))!;
    const out = prepared(`<head><meta charset="utf-8"><script>${guard}</script></head><body>x</body>`);
    expect(guardsIn(out)).toBe(2);
    expect(leadingGuardText(out)).toBe(guard);
    expect(unguarded(out).startsWith(`<html><head>${GUARD}<meta charset="utf-8"><script>${FRAME_GUARD_SOURCE}`)).toBe(true);
  });

  it.each([
    ['a type that stops it running', (g: string) => `<script type="text/plain">${g}</script>`],
    ['a module type', (g: string) => `<script type="module">${g}</script>`],
    ['an async attribute', (g: string) => `<script async>${g}</script>`],
    ['a nonce', (g: string) => `<script nonce="n">${g}</script>`],
  ])('does not trust a lookalike with %s', (_name, wrap) => {
    const guard = leadingGuardText(prepared('<p>x</p>'))!;
    const out = prepared(`<head>${wrap(guard)}</head><body>x</body>`);
    expect(guardsIn(out)).toBe(2);
    expect(leadingGuardText(out)).toBe(guard);
  });

  it.each([
    ['in the guard itself', (g: string) => g.replace('Object.defineProperty(', 'Object.defineProperty (')],
    ['in the call that starts it (it leaves its global behind)', (g: string) => g.replace('delete window.axFrameGuard;', '')],
    ['in the call that starts it (it reports nothing)', (g: string) => g.replace('console.warn(', 'void (')],
    ['by one trailing character', (g: string) => `${g} `],
  ])('does not trust a guard whose text was edited %s', (_name, edit) => {
    const guard = leadingGuardText(prepared('<p>x</p>'))!;
    const edited = edit(guard);
    expect(edited).not.toBe(guard);
    const out = prepared(`<head><script>${edited}</script></head><body>x</body>`);
    expect(guardsIn(out)).toBe(2);
    expect(leadingGuardText(out)).toBe(guard);
  });
});

// ---- pages it will not serve ------------------------------------------------------

describe('failing closed', () => {
  const nested = (open: string, close: string, depth: number) => open.repeat(depth) + 'x' + close.repeat(depth);

  it('refuses nesting thousands deep as too deep, and does not throw', () => {
    expect(() => transform('<div>'.repeat(8000))).not.toThrow();
    expect(verdict('<div>'.repeat(8000))).toBe('too_deep');
    expect(verdict(nested('<div>', '</div>', 8000))).toBe('too_deep');
    expect(verdict('<template>'.repeat(8000))).toBe('too_deep');
    expect(verdict('<svg>'.repeat(8000))).toBe('too_deep');
  });

  it('draws the line at the depth browsers stop nesting at (html and body count)', () => {
    // 510 divs + html + body = 512 open elements; one more is past the cap.
    expect(verdict(nested('<div>', '</div>', 510))).toBe('served');
    expect(verdict(nested('<div>', '</div>', 511))).toBe('too_deep');
    // Nesting through templates counts, even though a template's children hang off its content.
    expect(verdict(nested('<template>', '</template>', 510))).toBe('served');
    expect(verdict(nested('<template>', '</template>', 511))).toBe('too_deep');
  });

  it('answers null for a page with a NUL in it, wherever it is', () => {
    // Chromium, Firefox and WebKit skip a NUL while <head> is open and parse5 ends the head at it, so the page
    // they build is not the one we checked. No real page has one.
    for (const html of [
      '\u0000<p>x</p>',
      '<head>\u0000<template shadowrootmode="closed"><iframe srcdoc="x"></iframe></template>',
      '<p>a\u0000b</p>',
      '<p title="a\u0000b">x</p>',
      '<script>var a = "\u0000"</script>',
      '<!--\u0000-->',
      '<p>x</p>\u0000',
    ]) {
      expect(verdict(html), JSON.stringify(html)).toBe('nul');
    }
  });

  it('writes no NUL, whatever the page spells with character references', () => {
    const out = prepared('<p title="&#0;&#x0;">&#0;&#x0;&#00000;</p><script>a&#0;b</script><!--&#0;--><svg><![CDATA[&#0;]]></svg>');
    expect(out).not.toContain('\u0000');
  });

  it('answers null for a carriage return written as a character reference, wherever it is', () => {
    // parse5 does not count CR as whitespace when it comes from a reference, so it ends a <head> at one that a
    // browser reads straight through. A raw CR or CRLF in the source is a different thing (it reads as LF).
    for (const html of [
      '&#13;<p>x</p>',
      '</head>&#13;<p>x</p>',
      '<p>a&#13;b</p>',
      '<p title="a&#xD;b">x</p>',
      '<textarea>a&#13;b</textarea>',
      '<title>a&#13;b</title>',
      '<p>&#00013;</p>',
    ]) {
      expect(verdict(html), html).toBe('cr_entity');
    }
    expect(prepared('<p>a\r\nb\rc</p>')).toContain('<p>a\nb\nc</p>');
  });

  it('refuses <plaintext>, which never settles', () => {
    // Everything after <plaintext> is text, so the </plaintext> the serializer adds becomes part of the text on
    // the next read, and the page grows by one on every pass.
    expect(verdict('<plaintext><p>x')).toBe('plaintext');
    expect(verdict('<div><template><plaintext>x</template></div>')).toBe('plaintext');
  });

  it('serves a <plaintext> that is only inside a frame it cuts, and one in SVG or MathML (an ordinary element there)', () => {
    expect(verdict('<object><plaintext>x</object>')).toBe('served');
    expect(verdict('<svg><plaintext>x</plaintext></svg><p>after</p>')).toBe('served');
    expect(verdict('<math><plaintext>x</plaintext></math><p>after</p>')).toBe('served');
  });

  it('refuses input that is not text, with the parser-error code, and does not throw', () => {
    expect(() => transform(undefined as unknown as string)).not.toThrow();
    expect(verdict(undefined as unknown as string)).toBe('parse_error');
    expect(verdict(42 as unknown as string)).toBe('parse_error');
  });

  it('serves a page with lots of siblings and long runs', () => {
    expect(verdict('<p>x</p>'.repeat(20000))).toBe('served');
    expect(verdict('<b>'.repeat(300) + 'x')).toBe('served');
    expect(verdict(`<p title="${'a'.repeat(200000)}">${'b'.repeat(200000)}</p>`)).toBe('served');
    expect(verdict('<'.repeat(100000))).toBe('served');
  });
});

// ---- the script itself, run ---------------------------------------------------------

// The pages below are our own fixtures, run inside jsdom's own vm context: one
// throwaway window per test (runScripts: 'dangerously' so the page's scripts
// run, as in a browser with scripts on), closed afterwards. `eval` is jsdom's
// window.eval on constant strings written here; nothing evaluates in the test
// process, and nothing in them is data from outside this file. jsdom ships no
// types and we don't add @types/jsdom for a few tests: describe the slice used.
interface PageWindow {
  eval(code: string): unknown;
  close(): void;
  document: { documentElement: unknown };
}
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: Record<string, unknown>) => { window: PageWindow };
  VirtualConsole: new () => { on(event: string, listener: (...args: unknown[]) => void): void };
};

const open: PageWindow[] = [];
afterEach(() => {
  for (const w of open.splice(0)) w.close();
});

/** Runs a prepared page's scripts in jsdom, as a browser with scripts on would. */
function runPage(html: string, beforeParse?: (w: PageWindow) => void) {
  const warnings: string[] = [];
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('warn', (...args) => warnings.push(args.join(' ')));
  virtualConsole.on('jsdomError', (error) => errors.push((error as Error).message));
  const { window } = new JSDOM(prepared(html), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole, beforeParse });
  open.push(window);
  return { window, warnings, errors };
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await wait(10);
}

describe('the guard script, running in a page', () => {
  it('runs without an error and leaves no axFrameGuard for the page to find', () => {
    const { window, errors } = runPage('<p>hi</p><script>window.sawGuard = typeof window.axFrameGuard</script>');
    expect(errors).toEqual([]);
    expect(window.eval('window.sawGuard')).toBe('undefined');
    expect(window.eval('typeof axFrameGuard')).toBe('undefined');
  });

  it('has its locks in place before the first script of the page runs', () => {
    const { window, errors } = runPage(
      '<script>' +
        'try { document.createElement("div").attachShadow({ mode: "open" }); window.attach = "allowed"; } catch (e) { window.attach = e.message; }' +
        'window.rtc = typeof RTCPeerConnection;' +
        '</script>',
      (w) => {
        w.eval('window.RTCPeerConnection = function RTCPeerConnection() {};');
      },
    );
    expect(errors).toEqual([]);
    expect(window.eval('window.attach')).toBe('Not available in this frame.');
    expect(window.eval('window.rtc')).toBe('undefined');
  });

  it('does not stop the page: its own scripts run and build the document', () => {
    const { window, errors } = runPage('<p id="p">before</p><script>document.getElementById("p").textContent = "after"; document.title = "ran";</script>');
    expect(errors).toEqual([]);
    expect(window.eval('document.getElementById("p").textContent')).toBe('after');
    expect(window.eval('document.title')).toBe('ran');
  });

  it('says why in the console when a child frame gets through and the page goes blank', async () => {
    const { window, warnings } = runPage('<p>hi</p>', (w) => {
      // A child the observer never saw: window.length counts it, which is what the kill switch reads.
      w.eval('Object.defineProperty(window, "length", { get() { return 1; }, configurable: true });');
    });
    await until(() => window.document.documentElement === null);
    expect(window.document.documentElement).toBeNull();
    expect(warnings).toEqual(['blocked: this page tried to open a nested frame']);
    // jsdom's window.close() walks window.length, so hand it the truth back before the afterEach closes the window.
    window.eval('Object.defineProperty(window, "length", { get() { return 0; }, configurable: true });');
  });
});
