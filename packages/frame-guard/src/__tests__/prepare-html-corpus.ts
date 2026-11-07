// Inputs for prepareArtifactHtml's tests, kept apart from the assertions so the
// same lists can be loaded into a real browser (the node tests only see
// parse5's reading of them; a browser is the other half of the evidence).
//
// Every HOSTILE vector tries to leave a child browsing context (or a closed
// declarative shadow root, which hides one) in the page after the transform.
// Most do it in the page as written; the "revealed" ones look clean on the
// first parse and only grow an element when the tree is written out and read
// again, which is why the transform goes round more than once.

export interface Vector {
  /** What the input is, in a few words. */
  name: string;
  /** The page as the agent wrote it. */
  html: string;
}

/** A child frame that is a real browsing context everywhere (srcdoc needs no network). */
const IFRAME = '<iframe srcdoc="x"></iframe>';
/** The same, inside a closed declarative shadow root: no `shadowRoot`, nothing for an observer to see. */
const closedShadow = (inner: string, attrs = 'shadowrootmode="closed"') => `<div><template ${attrs}>${inner}</template></div>`;

export const HOSTILE_VECTORS: readonly Vector[] = [
  // ---- frame-making elements, as written ----
  { name: 'iframe', html: `<p>before</p>${IFRAME}<p>after</p>` },
  { name: 'iframe, upper case', html: '<p>a</p><IFRAME SRCDOC="x"></IFRAME><p>b</p>' },
  { name: 'iframe, mixed case', html: '<iFrAmE srcdoc="x"></iFrAmE>' },
  { name: 'iframe, slash instead of space', html: '<iframe/srcdoc=x></iframe>' },
  { name: 'iframe, attribute spread over lines', html: '<iframe\n\tsrcdoc\n=\n"x"\n></iframe>' },
  { name: 'iframe, never closed (swallows the rest of the page)', html: '<p>before</p><iframe srcdoc="x"><p>after</p>' },
  { name: 'iframe in the head', html: `<html><head><title>t</title>${IFRAME}</head><body>b</body></html>` },
  { name: 'iframe after the document ended', html: `<html><body>b</body></html>${IFRAME}` },
  { name: 'iframe inside a table', html: `<table>${IFRAME}<tr><td>cell</td></tr></table>` },
  { name: 'iframe in a table cell', html: `<table><tr><td>${IFRAME}</td></tr></table>` },
  { name: 'iframe in a paragraph and a link', html: `<p><a href="#a">${IFRAME}</a></p>` },
  { name: 'iframe after an abruptly closed comment', html: `<!-->${IFRAME}` },
  { name: 'iframe after a comment ended with --!>', html: `<!-- a --!>${IFRAME}` },
  { name: 'iframe after a processing-instruction lookalike', html: `<?xml version="1.0" ?>${IFRAME}` },
  { name: 'object', html: '<object data="about:blank" type="text/html"></object>' },
  { name: 'object with an iframe as fallback content', html: `<object data="x">${IFRAME}</object>` },
  { name: 'embed', html: '<embed src="about:blank" type="text/html">' },
  { name: 'portal', html: '<portal src="about:blank"></portal>' },
  { name: 'fencedframe', html: '<fencedframe></fencedframe>' },
  {
    name: 'frameset document',
    html: '<!doctype html><html><head><title>f</title></head><frameset cols="*,*"><frame src="a.html"><frame src="b.html"></frameset></html>',
  },
  { name: 'frameset with noframes', html: `<frameset><frame src="a.html"><noframes>${IFRAME}</noframes></frameset>` },

  // ---- declarative shadow roots, hiding a frame ----
  { name: 'closed shadow root', html: closedShadow(IFRAME) },
  { name: 'open shadow root', html: closedShadow(IFRAME, 'shadowrootmode="open"') },
  { name: 'shadowrootmode, upper case', html: closedShadow(IFRAME, 'SHADOWROOTMODE="closed"') },
  { name: 'shadowrootmode, spaces around the equals sign', html: closedShadow(IFRAME, "shadowrootmode = 'closed'") },
  { name: 'shadowrootmode, tabs and newlines', html: closedShadow(IFRAME, '\n\tshadowrootmode\n\t=\n\tclosed\n') },
  { name: 'shadowrootmode, unquoted', html: closedShadow(IFRAME, 'shadowrootmode=closed') },
  { name: 'shadowrootmode, separated from <template by a slash', html: `<div><template/shadowrootmode=closed>${IFRAME}</template></div>` },
  { name: 'shadowrootmode, valueless', html: closedShadow(IFRAME, 'shadowrootmode') },
  { name: 'shadowrootmode, given twice', html: closedShadow(IFRAME, 'shadowrootmode=closed shadowrootmode=open') },
  { name: 'shadowrootmode with delegatesfocus', html: closedShadow(IFRAME, 'shadowrootmode=closed shadowrootdelegatesfocus') },
  { name: 'legacy shadowroot attribute', html: closedShadow(IFRAME, 'shadowroot="closed"') },
  {
    name: 'nested shadow roots',
    html: `<div><template shadowrootmode="open"><div><template shadowrootmode="closed">${IFRAME}</template></div></template></div>`,
  },
  {
    name: 'shadow root template inside an inert template',
    html: `<template><div><template shadowrootmode="closed">${IFRAME}</template></div></template>`,
  },
  { name: 'shadow root template in the head', html: `<head><template shadowrootmode="closed">${IFRAME}</template></head><body></body>` },
  { name: 'shadow root template in a table', html: `<table><template shadowrootmode="closed">${IFRAME}</template></table>` },
  { name: 'shadow root template in a table row', html: `<table><tr><td><template shadowrootmode="closed">${IFRAME}</template></td></tr></table>` },
  { name: 'shadow root template in svg', html: `<svg><foreignObject><div>${closedShadow(IFRAME)}</div></foreignObject></svg>` },
  { name: 'shadow root attribute on a template that svg owns', html: `<svg><template shadowrootmode="closed">${IFRAME}</template></svg>` },
  { name: 'shadow root attribute on a template that mathml owns', html: `<math><template shadowrootmode="closed">${IFRAME}</template></math>` },
  { name: 'shadow root template next to a script', html: closedShadow(`<script>1</script>${IFRAME}`) },
  { name: 'shadow root template in a select', html: `<select><div>${closedShadow(IFRAME)}</div></select>` },

  // ---- <noscript>: raw text with scripting on, markup with it off ----
  { name: 'noscript hiding an iframe in an attribute (head)', html: `<noscript><p title="</noscript>${IFRAME}"></noscript>` },
  { name: 'noscript hiding an iframe in an attribute (body)', html: `<body><noscript><p title="</noscript>${IFRAME}"></noscript></body>` },
  { name: 'noscript with an open style', html: `<noscript><style></noscript>${IFRAME}</style></noscript>` },
  { name: 'noscript with an iframe in it', html: `<body><noscript>${IFRAME}</noscript></body>` },

  // ---- foreign content ----
  { name: 'svg foreignObject', html: `<svg><foreignObject>${IFRAME}</foreignObject></svg>` },
  { name: 'svg desc', html: `<svg><desc>${IFRAME}</desc></svg>` },
  { name: 'svg title', html: `<svg><title>${IFRAME}</title></svg>` },
  { name: 'svg with a paragraph that breaks out', html: `<svg><p>${IFRAME}</p></svg>` },
  { name: 'svg with an iframe of its own', html: `<svg>${IFRAME}</svg>` },
  { name: 'svg with a frame of its own (no frameset around it)', html: '<svg><frame src="about:blank"></frame><g></g></svg>' },
  { name: 'svg with an object of its own', html: '<svg><object data="about:blank"></object></svg>' },
  { name: 'svg with an embed (breaks out of svg)', html: '<svg><embed src="about:blank"></svg>' },
  { name: 'math annotation-xml text/html', html: `<math><annotation-xml encoding="text/html">${IFRAME}</annotation-xml></math>` },
  { name: 'math mtext', html: `<math><mtext>${IFRAME}</mtext></math>` },
  { name: 'svg in a foreignObject in an svg', html: `<svg><foreignObject><svg><foreignObject>${IFRAME}</foreignObject></svg></foreignObject></svg>` },

  // ---- revealed by writing the tree out and reading it again (mutation XSS) ----
  {
    name: 'revealed: mtext, table, mglyph and a style',
    html: '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;iframe srcdoc=x&gt;">',
  },
  { name: 'revealed: forms nested through foreign content', html: `<form><math><mtext></form><form><mglyph><style></math>${IFRAME}` },
  {
    name: 'revealed: an iframe in a style that changes namespace on the second read',
    html: '<math><mtext><table><mglyph><style><iframe srcdoc=x>',
  },
  {
    name: 'revealed: after a cut, an embed to cut and then an iframe the cut uncovers',
    html: '<form><math><mtext></form><form><embed src=y><mglyph><style></math><iframe srcdoc=x>',
  },
  { name: 'a link inside a table inside a link (the tree changes when read back)', html: `<a><table><a>${IFRAME}</a></table></a>` },
  { name: 'style hiding an iframe inside an svg', html: `<svg></p><style><a id="</style>${IFRAME}">` },
  { name: 'xmp hiding an iframe in an attribute', html: `<xmp><a id="</xmp>${IFRAME}"></xmp>` },
  { name: 'textarea hiding an iframe in an attribute', html: `<textarea><a id="</textarea>${IFRAME}"></textarea>` },
  { name: 'table caption with svg style', html: `<table><caption><svg><style></style>${IFRAME}` },

  // ---- inside <select>, where a browser's parser and parse5's differ ----
  { name: 'select with an iframe', html: `<select>${IFRAME}</select>` },
  { name: 'select with a div around an iframe', html: `<select><div>${IFRAME}</div></select>` },
  { name: 'select option with an iframe', html: `<select><option>a${IFRAME}</option></select>` },
  { name: 'select with a button and selectedcontent', html: `<select><button><selectedcontent>${IFRAME}</selectedcontent></button></select>` },
  { name: 'select with an object', html: '<select><object data="about:blank"></object></select>' },
  { name: 'select with an embed', html: '<select><embed src="about:blank"></select>' },
];

/** Markup that mentions frame-making tags only as text, and must still be there afterwards. */
export interface TextVector extends Vector {
  /** Substrings of the transformed output that must be present, character for character. */
  keep: readonly string[];
}

export const TEXT_VECTORS: readonly TextVector[] = [
  { name: 'iframe tag inside a textarea', html: '<textarea><iframe src="x"></iframe></textarea>', keep: ['<textarea>&lt;iframe src="x"&gt;&lt;/iframe&gt;</textarea>'] },
  { name: 'iframe tag inside xmp', html: '<xmp><iframe src="x"></iframe></xmp>', keep: ['<xmp><iframe src="x"></iframe></xmp>'] },
  { name: 'iframe tag inside a script string', html: '<script>var s = "<iframe src=x></iframe>"; if (1 < 2) {}</script>', keep: ['var s = "<iframe src=x></iframe>"; if (1 < 2) {}</script>'] },
  { name: 'iframe tag inside a comment', html: '<!-- <iframe src="x"></iframe> --><p>after</p>', keep: ['<!-- <iframe src="x"></iframe> -->', '<p>after</p>'] },
  { name: 'iframe tag inside a style', html: '<style>/* <iframe> */ p { color: red }</style>', keep: ['<style>/* <iframe> */ p { color: red }</style>'] },
  { name: 'iframe tag inside a title', html: '<title><iframe></title><p>x</p>', keep: ['<title>&lt;iframe&gt;</title>'] },
  { name: 'iframe tag inside noembed', html: '<noembed><iframe src="x"></iframe></noembed>', keep: ['<noembed><iframe src="x"></iframe></noembed>'] },
  { name: 'iframe tag inside an attribute', html: '<p title="<iframe src=x></iframe>">p</p>', keep: ['<p title="<iframe src=x></iframe>">p</p>'] },
  { name: 'iframe tag as escaped text', html: '<p>Use the &lt;iframe&gt; element &amp; &lt;object&gt;.</p>', keep: ['<p>Use the &lt;iframe&gt; element &amp; &lt;object&gt;.</p>'] },
  { name: 'iframe tag inside a CDATA-looking comment', html: '<![CDATA[<iframe srcdoc=x></iframe>]]><p>after</p>', keep: ['<!--[CDATA[<iframe srcdoc=x-->', ']]&gt;<p>after</p>'] },
  { name: 'iframe tag inside svg CDATA', html: '<svg><![CDATA[<iframe srcdoc="x">]]></svg>', keep: ['&lt;iframe srcdoc="x"&gt;'] },
  { name: 'iframe with a replacement character in its name', html: '<ifr\ufffdame srcdoc="x">t</ifr\ufffdame>', keep: ['<ifr\ufffdame srcdoc="x">t</ifr\ufffdame>'] },
  { name: 'iframe built from a character reference', html: '<&#105;frame srcdoc="x">', keep: ['&lt;iframe srcdoc="x"&gt;'] },
  { name: 'shadowrootmode as text', html: '<p>Set shadowrootmode="closed" on a template.</p><textarea>shadowrootmode=closed</textarea>', keep: ['<p>Set shadowrootmode="closed" on a template.</p>', '<textarea>shadowrootmode=closed</textarea>'] },
  { name: 'shadowrootmode on something that is not a template', html: '<div shadowrootmode="closed">d</div>', keep: ['<div shadowrootmode="closed">d</div>'] },
  { name: 'noscript as text', html: '<p>Use &lt;noscript&gt; for fallbacks.</p>', keep: ['<p>Use &lt;noscript&gt; for fallbacks.</p>'] },
  { name: 'script that builds an iframe at run time', html: '<script>document.body.innerHTML = "<iframe srcdoc=x></iframe>"</script>', keep: ['document.body.innerHTML = "<iframe srcdoc=x></iframe>"'] },
];

/**
 * Pages with every kind of head (or none): the guard has to end up first in the
 * one the parser builds, wherever the page put its own head, comments and scripts.
 */
export const STRUCTURE_PAGES: Readonly<Record<string, string>> = {
  'a fragment': '<p>x</p>',
  'bare text': 'hello',
  'nothing at all': '',
  'a full document': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body class="a"><h1>Hi</h1></body></html>',
  'a doctype and nothing else': '<!doctype html>',
  'comments before the doctype': '<!-- one --><!-- two --><!doctype html><p>x</p>',
  'a comment between the doctype and <html>': '<!doctype html><!-- c --><html><body>x</body></html>',
  'a comment inside <html> before <head>': '<html><!-- c --><head></head><body>x</body></html>',
  'a comment after </html>': '<html><body>x</body></html><!-- tail -->',
  'a script before <head>': '<script>window.early = 1</script><head><title>t</title></head><body>b</body>',
  'a script before <html>': '<script>window.early = 1</script><!doctype html><html><body>b</body></html>',
  'no <head>': '<html><body>b</body></html>',
  'a body and nothing else': '<body class="x">b</body>',
  'a <head> that never closes': '<html><head><title>t</title><body>b</body></html>',
  'two <head> elements': '<head><meta charset="utf-8"></head><head><title>t</title></head><body>b</body>',
  'a <head> after the body': '<body>b</body><head><title>late</title></head>',
  'a <title> that swallows the page': '<head><title>t<body>b',
  'whitespace and a comment first in <head>': '<head>\n  <!-- c -->\n  <meta charset="utf-8"></head>',
  'a <meta> before everything': '<meta charset="utf-8"><p>x</p>',
  'a <head> with attributes': '<head profile="x" class="y"><title>t</title></head><body>b</body>',
  'a template in the head': '<head><template><p>t</p></template></head><body>b</body>',
  'a frameset document':
    '<!doctype html><html><head><title>f</title></head><frameset cols="*,*"><frame src="a.html"><frame src="b.html"></frameset></html>',
  'a document that ends mid-tag': '<p>x</p><div class="a',
  'a table': '<table><tr><td>1</td><td>2</td></tr></table>',
};

/**
 * Text that opens with a newline in a <pre>, <listing> or <textarea>: the parser
 * eats the first one, and the serializer has to put it back when the author
 * wrote two. `tag` is the element whose first text is compared.
 */
export const NEWLINE_PAGES: ReadonlyArray<readonly [name: string, html: string, tag: string]> = [
  ["two newlines: one is the parser's, one is the author's", '<pre>\n\nfoo</pre>', 'pre'],
  ["one newline: the parser's, nothing to put back", '<pre>\nfoo</pre>', 'pre'],
  ['no newline', '<pre>foo</pre>', 'pre'],
  ['three newlines', '<pre>\n\n\nfoo</pre>', 'pre'],
  ['a newline written as a character reference', '<pre>&#10;&#10;foo</pre>', 'pre'],
  ['a newline after CRLF normalization', '<pre>\r\n\r\nfoo</pre>', 'pre'],
  ['a textarea with two newlines', '<textarea>\n\nfoo</textarea>', 'textarea'],
  ['a textarea with one', '<textarea>\nfoo</textarea>', 'textarea'],
  ['a textarea of one newline and nothing else', '<textarea>\n\n</textarea>', 'textarea'],
  ['a listing with two newlines', '<listing>\n\nfoo</listing>', 'listing'],
  ['a pre inside a template', '<template><pre>\n\nfoo</pre></template>', 'pre'],
  ['a pre inside a table cell', '<table><tr><td><pre>\n\nfoo</pre></td></tr></table>', 'pre'],
  ['a pre inside svg foreignObject', '<svg><foreignObject><pre>\n\nfoo</pre></foreignObject></svg>', 'pre'],
  ['a pre whose first child is an element', '<pre><b>\n\nfoo</b></pre>', 'pre'],
  ['a pre whose first child is a comment', '<pre><!--c-->\nfoo</pre>', 'pre'],
];

/** The kind of page an agent publishes, with nothing hostile in it: it must come out rendering the same. */
export const REALISTIC_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sales</title><style>table{border-collapse:collapse}td{padding:4px}</style></head>' +
  '<body><h1>Q3 &amp; Q4</h1><table><thead><tr><th>Region</th><th>\u20ac</th></tr></thead><tbody><tr><td>North</td><td>1,200</td></tr></tbody></table>' +
  '<canvas id="c" width="200" height="100"></canvas><pre>\n  indented\n</pre>' +
  '<svg width="10" height="10"><circle cx="5" cy="5" r="4"></circle></svg>' +
  '<script>const c = document.getElementById("c").getContext("2d"); c.fillRect(0, 0, 10, 10); if (1 < 2) { document.title = "ok"; }</script>' +
  '<a href="#c">jump</a></body></html>';
