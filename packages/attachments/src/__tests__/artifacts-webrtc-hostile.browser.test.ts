// @vitest-environment node
//
// Artifact HTML on the content origin, tested in a real browser. An agent wrote
// those bytes, so they are hostile until proven otherwise. The content origin
// gives them a strict CSP (`connect-src 'none'`, no forms, an opaque origin),
// and CSP does not govern WebRTC: a page can still hand `RTCPeerConnection` a
// STUN or TURN server of its choosing and the browser will send packets there.
// A child browsing context (a srcdoc iframe, or a shadow root holding one) gets
// its own fresh, unlocked copy of every API, so locking the top window alone is
// not enough either.
//
// It was red on purpose until the guard landed (TASK-1082, T1 of
// docs/plans/2026-11-07-task-1082-artifact-webrtc-guard-plan.md): the page
// reached the canaries. T5 wired prepareArtifactHtml into the origin and this
// went green. The "unguarded control" tests are what make a silent canary mean
// something: they show the canaries hear what this Chromium sends.
//
// The rig, all real except the artifact lookup:
// - the real startContentOrigin, with a stub `serve` that returns hostile HTML,
//   `frameAncestors` set to the test app's origin, and tokens from the real
//   signViewToken;
// - an app page that frames /v/<token> the way ArtifactPreview.tsx does
//   (sandbox="allow-scripts allow-downloads", no referrer), under the frame-src
//   a deploy with a content origin gives the shell;
// - a CONTROL server that serves the same hostile HTML with the origin's own
//   response headers and no guard;
// - one canary per probe, so probes can run side by side and one leak can't
//   hide another: a UDP socket (visual-hostile's TCP canary can't hear STUN)
//   and an HTTP server. The probe's iceServers point STUN at the first and
//   TURN-over-TCP at the second, because a bare TCP connection is the other
//   thing CSP never sees.
//
// Every cell of {framed by the app, opened top-level} x {default, site-isolated
// Chromium} runs every probe against the origin and against the control. The
// two process models are the ones visual-hostile.browser.test.ts uses, for the
// same reason: Playwright's default Chromium keeps a page and its frames in one
// renderer, real Chrome gives a sandboxed frame its own.
//
// The probes above are routes a page's own script takes. Four more families
// finish the job (TASK-1082 T6), each run in every cell:
// - Parse-time vectors. T4's corpus of tricky pages (mutation XSS, closed and
//   open declarative shadow roots, nested templates, <noscript> smuggling, svg
//   and math foreign content, framesets, <select>...) is served through the
//   origin with a script-running frame in place of its inert one. The whole
//   corpus runs in one cell, the hardest 15 in all four. A page is clean only
//   if every layer agrees: no frame-making element ever reached the document
//   (an insertion watch installed before the page's first byte records it, so a
//   guard that cleans up after a weak transform can't hide the weakness), no
//   frame anywhere in the frame tree (which, unlike `window.length`, sees
//   inside closed shadow roots), the guard was running and never had to fire,
//   and the canaries heard nothing. The unguarded control proves the corpus
//   still bites in this Chromium.
// - An ordinary artifact (table, canvas script, inline SVG, <pre> with a
//   leading newline, an #anchor link): it renders as it does with no guard,
//   its script ran, the anchor works.
// - The kill switch: the one honest way to a live child frame with the guard
//   intact, and what the guard does about it.
// - A page navigating itself (meta refresh, location=): refused when the app
//   frames it, and, MEASURED, not refused when the origin's URL is opened on
//   its own. That second half is a known gap with a follow-up card; its tests
//   state today's behavior and will be flipped by the fix.
//
// Locally this skips when Playwright's Chromium isn't installed. In CI it never
// skips: CI installs Chromium (.github/workflows/ci.yml), and if that ever
// stops working the suite fails instead of going quietly green.
import { randomBytes } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startContentOrigin, type ContentOriginHandle } from '../artifacts/content-origin.js';
import { VIEW_TOKEN_TTL_SECONDS, signViewToken } from '../artifacts/view-token.js';
// T4's corpus: the one list the transform's Node tests and this browser suite share.
// (Test files may reach into peer packages; see eslint.config.mjs.)
import { HOSTILE_VECTORS, IFRAME } from '../../../frame-guard/src/__tests__/prepare-html-corpus.js';

const IN_CI = !!process.env.CI;
const CHROMIUM_MISSING = !existsSync(chromium.executablePath());

/** After a page loads, how long it has to reach a canary. A STUN packet lands within ~250 ms locally. */
const SETTLE_MS = 2500;
/** The same wait for the families that only watch a page finish its parse-time work (the frame tree is there at `load`). */
const QUICK_SETTLE_MS = 1500;
/** A probe the control must reach the canary with may take this long, so a slow runner can't fake a dead canary. */
const LIVE_MS = 10_000;
/** Pages open at once when a family runs many (each framed page in isolated mode is two renderer processes). */
const PAGE_CONCURRENCY = 16;

// Chrome puts a sandboxed frame in its own renderer process (IsolateSandboxedIframes),
// but Playwright's --disable-field-trial-config leaves that off.
const ISOLATED_ARGS = ['--site-per-process', '--enable-features=IsolateSandboxedIframes'];

type Mode = 'default' | 'isolated';
type Framing = 'framed' | 'top-level';
type Target = 'origin' | 'control';

const CELLS = [
  { mode: 'default', framing: 'framed', label: 'default process model, framed by the app' },
  { mode: 'default', framing: 'top-level', label: 'default process model, opened top-level' },
  { mode: 'isolated', framing: 'framed', label: 'isolated process model, framed by the app' },
  { mode: 'isolated', framing: 'top-level', label: 'isolated process model, opened top-level' },
] as const;

// ---- the probes -----------------------------------------------------------

/** Escapes text for a double-quoted attribute, in HTML and in XML. */
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A JS string literal that can sit inside a <script>: `<` is escaped so a `</script>` in it can't end the script. */
const js = (s: string) => JSON.stringify(s).replace(/</g, '\\u003c');
/** An inline script that swallows its own errors: a locked API throwing is the guard working, not the page failing. */
const script = (code: string) => `<script>try { ${code} } catch (e) {}</script>`;

/** What every probe ends up running somewhere: reach for the canaries through WebRTC. */
function rtcScript(c: Canary): string {
  const iceServers = [
    // STUN is UDP: nothing in CSP ever sees it.
    { urls: `stun:127.0.0.1:${c.udpPort}` },
    // TURN over TCP is the other way out: a plain TCP connection to the HTTP canary.
    { urls: `turn:127.0.0.1:${c.httpPort}?transport=tcp`, username: 'ax', credential: 'ax' },
  ];
  return (
    `var pc = new RTCPeerConnection({ iceServers: ${JSON.stringify(iceServers)} }); pc.createDataChannel('x'); ` +
    'pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {});'
  );
}

/** A child document that reaches for the canaries, as an iframe srcdoc. */
const childFrame = (rtc: string) => `<iframe srcdoc="${attr(script(rtc))}"></iframe>`;
/** The same child, parsed straight into a closed shadow root: no `shadowRoot` to find, no observer that sees in. */
const closedShadow = (rtc: string) => `<div><template shadowrootmode="closed">${childFrame(rtc)}</template></div>`;

/**
 * An XSLT stylesheet whose output is an iframe. XSLT reads `{...}` in a literal
 * result element's attributes as an expression, so the braces in the script are
 * doubled; without that the transform quietly produces nothing.
 */
function xsltSheet(rtc: string): string {
  const srcdoc = attr(script(rtc)).replace(/\{/g, '{{').replace(/\}/g, '}}');
  return (
    '<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns="http://www.w3.org/1999/xhtml">' +
    `<xsl:output method="html"/><xsl:template match="/"><div><iframe srcdoc="${srcdoc}"></iframe></div></xsl:template></xsl:stylesheet>`
  );
}

interface Probe {
  name: string;
  /** The artifact's body, given the script that reaches for this probe's canaries. */
  body(rtc: string): string;
}

// Each probe is its own artifact: the route to WebRTC it tries, and nothing else.
// The shadow-root and markup-parsing probes use a CLOSED shadow root on purpose:
// a mutation observer on the document can't see into one, so only a lock on the
// API (or removing the markup before the browser parses it) stops them.
// There is no `setHTML` / `parseHTML` probe: the Sanitizer API's safe variants
// drop iframes and shadow roots even under a permissive config (measured in
// Chromium 147), so they can't make a child context to leak from.
const PROBES: readonly Probe[] = [
  // The page's own realm.
  { name: 'direct', body: (rtc) => script(rtc) },
  // A child browsing context, made four ways, each of which gets its own fresh RTCPeerConnection.
  { name: 'static-iframe', body: (rtc) => childFrame(rtc) },
  {
    name: 'script-iframe',
    body: (rtc) => script(`var f = document.createElement('iframe'); f.srcdoc = ${js(script(rtc))}; document.body.appendChild(f);`),
  },
  { name: 'document-write', body: (rtc) => script(`document.write(${js(childFrame(rtc))});`) },
  {
    name: 'xslt',
    body: (rtc) =>
      script(
        `var p = new XSLTProcessor(); p.importStylesheet(new DOMParser().parseFromString(${js(xsltSheet(rtc))}, 'application/xml')); ` +
          "document.body.appendChild(p.transformToFragment(new DOMParser().parseFromString('<a/>', 'application/xml'), document));",
      ),
  },
  // A child inside a closed shadow root, made three ways at run time and once at parse time.
  {
    name: 'set-html-unsafe',
    body: (rtc) => `<div id="host"></div>` + script(`document.getElementById('host').setHTMLUnsafe(${js(closedShadow(rtc))});`),
  },
  {
    name: 'parse-html-unsafe',
    body: (rtc) => script(`document.body.appendChild(Document.parseHTMLUnsafe(${js(closedShadow(rtc))}).body.firstChild);`),
  },
  {
    name: 'attach-shadow-closed',
    body: (rtc) =>
      `<div id="host"></div>` +
      script(`document.getElementById('host').attachShadow({ mode: 'closed' }).innerHTML = ${js(childFrame(rtc))};`),
  },
  { name: 'closed-dsd', body: (rtc) => closedShadow(rtc) },
];

const PROBE_NAMES = PROBES.map((p) => p.name);

/**
 * The probes the unguarded control MUST reach the canary with. The rest are
 * reported but not required: an API a future Chromium drops (XSLT is on its way
 * out) stops being a way to leak, and that is not this suite's failure.
 */
const CONTROL_MUST_REACH = ['direct', 'static-iframe', 'closed-dsd'];

/** The whole artifact. Its first script says the probe started, so a silent canary can't be a probe that never ran. */
const artifactDoc = (name: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title></head><body>` +
  `<script>console.log('ax-probe:${name}')</script><p>${name}</p>${body}</body></html>`;

// ---- the pages of the other families ----------------------------------------

/** The element names that can hold a child browsing context (the guard's own list). */
const FRAME_TAGS = 'iframe,frame,frameset,object,embed,portal,fencedframe';

/**
 * Playwright installs this before the page's first byte. It notes every
 * frame-making element and every open shadow root that ever reaches the
 * document, whoever removes it afterwards. That is what tells "the server cut
 * it" from "the server let it through and the guard's observer cleaned up", which
 * the end state alone can't. Content of a <template> or of a closed shadow root
 * isn't in the document tree, so it isn't seen here; the frame tree is what sees
 * a frame inside a closed shadow root.
 */
const INSERTION_WATCH = `(() => {
  var seen = new Set();
  window.__axInserted = [];
  new MutationObserver(function (records) {
    for (var r = 0; r < records.length; r++) {
      var added = records[r].addedNodes;
      for (var a = 0; a < added.length; a++) {
        if (added[a].nodeType !== 1) continue;
        // An added node's ancestors were added in the same batch, so look at each element once.
        var all = [added[a]].concat(Array.from(added[a].querySelectorAll('*')));
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (seen.has(el)) continue;
          seen.add(el);
          if (el.matches(${js(FRAME_TAGS)})) window.__axInserted.push(el.localName);
          if (el.shadowRoot) window.__axInserted.push('open-shadow:' + el.localName);
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
})();`;

/** What the page looks like to a script in it, read from the page itself. */
const DOM_FACTS = `(() => ({
  inserted: window.__axInserted || ['the insertion watch did not run'],
  lightFrames: document.querySelectorAll(${js(FRAME_TAGS)}).length,
  windowLength: window.length,
  rtc: typeof RTCPeerConnection,
  root: document.documentElement !== null,
  bodyText: document.body ? document.body.innerText : null,
}))()`;

/** The corpus page with its inert `<iframe srcdoc="x">` swapped for a frame that reaches for the canaries. */
const withLiveFrame = (html: string, rtc: string) => html.split(IFRAME).join(childFrame(rtc));

const httpUrl = (c: Canary) => `http://127.0.0.1:${c.httpPort}`;

// An ordinary artifact: what an agent publishes when nothing is wrong.
const ORDINARY_ID = 'ordinary';
const ORDINARY_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quarterly numbers</title>' +
  '<style>table{border-collapse:collapse}td,th{border:1px solid #888;padding:4px}#spacer{height:1600px}</style></head><body>' +
  '<h1>Quarterly numbers</h1>' +
  '<table id="t"><thead><tr><th>Region</th><th>Revenue</th></tr></thead>' +
  '<tbody><tr><td>North</td><td>1,200</td></tr><tr><td>South</td><td>950</td></tr></tbody></table>' +
  '<canvas id="c" width="40" height="20"></canvas>' +
  '<svg id="s" width="120" height="60" viewBox="0 0 120 60"><circle id="dot" cx="30" cy="30" r="20" fill="rgb(0, 128, 0)"></circle>' +
  '<rect x="70" y="10" width="40" height="40" fill="navy"></rect></svg>' +
  // The parser eats the first newline after <pre> and <textarea>; the second is the author's.
  '<pre id="two">\n\ntwo newlines before this line\n  indented</pre>' +
  '<pre id="one">\none newline before this line</pre>' +
  '<textarea id="ta">\n\nbox</textarea>' +
  '<p><a id="jump" href="#end">Jump to the end</a></p>' +
  '<div id="spacer"></div><h2 id="end">The end</h2>' +
  '<script>' +
  'var ctx = document.getElementById("c").getContext("2d");' +
  'ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 20, 20);' +
  'ctx.fillStyle = "#0000ff"; ctx.fillRect(20, 0, 20, 10);' +
  'document.getElementById("t").setAttribute("data-ready", "yes");' +
  '</script></body></html>';

/** Facts about the ordinary page, read from inside it. One canvas read-back, or Chromium nags about read-backs. */
const ORDINARY_FACTS = `(() => {
  var data = document.getElementById('c').getContext('2d').getImageData(0, 0, 40, 20).data;
  var px = function (x, y) { var i = (y * 40 + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
  var circle = document.getElementById('dot');
  var target = document.querySelector(':target');
  return {
    ready: document.getElementById('t').getAttribute('data-ready'),
    title: document.title,
    quirks: document.compatMode !== 'CSS1Compat',
    rows: Array.from(document.querySelectorAll('#t tbody tr')).map(function (tr) {
      return Array.from(tr.cells).map(function (td) { return td.textContent; });
    }),
    canvas: { red: px(5, 5), blue: px(30, 5), untouched: px(30, 15) },
    circle: { fill: getComputedStyle(circle).fill, width: circle.getBoundingClientRect().width },
    preTwo: document.getElementById('two').textContent,
    preOne: document.getElementById('one').textContent,
    textarea: document.getElementById('ta').value,
    text: document.body.innerText,
    hash: location.hash,
    scrolled: window.scrollY > 0,
    target: target ? target.id : null,
  };
})()`;

// The kill switch. The guard blanks the page when a child frame is alive after
// its purge. The purge removes a frame as soon as it shows up, so the one honest
// way to a live child is to make one DURING the purge: a customized built-in
// <iframe> whose disconnectedCallback runs inside the guard's own remove() call,
// after the guard took its mutation records, and inserts a second iframe. The
// guard's check() then finds window.length > 0 before its observer sees the new
// frame. The page logs from inside the callback (`ax-kill:reentered 1`: the bait
// is gone, the second frame is the one child), which is how a test knows this
// route was taken: with a broken purge the bait itself would be the live child,
// and the page would blank all the same. The page also tries to rebuild itself
// afterwards: it must stay blank.
const KILL_ID = 'kill-reentrant';
const KILL_WARNING = 'blocked: this page tried to open a nested frame';
const killPage = (c: Canary) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>kill</title></head><body><p id="alive">alive</p><script>' +
  `try {
  class Bait extends HTMLIFrameElement {
    disconnectedCallback() {
      var f = document.createElement('iframe');
      f.srcdoc = ${js(script(rtcScript(c)))};
      document.body.appendChild(f);
      console.log('ax-kill:reentered ' + window.length);
    }
  }
  customElements.define('x-bait', Bait, { extends: 'iframe' });
  console.log('ax-kill:armed');
  setTimeout(function () {
    var html = document.createElement('html');
    var body = document.createElement('body');
    body.textContent = 'REBUILT';
    html.appendChild(body);
    document.appendChild(html);
    console.log('ax-kill:rebuilt');
  }, 400);
  document.body.appendChild(document.createElement('iframe', { is: 'x-bait' }));
  console.log('ax-kill:inserted');
} catch (e) { console.log('ax-kill:setup-failed ' + e); }` +
  '</script></body></html>';

// The ordinary case of the same layer: a script-created frame is purged on the
// spot, and the page, which did nothing the guard couldn't undo, carries on.
const PURGE_ID = 'kill-purge-keeps-page';
const purgePage = (c: Canary) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>purge</title></head><body><p id="alive">alive</p>' +
  script(
    `setTimeout(function () { document.getElementById('alive').textContent = 'still alive'; }, 700);` +
      `var f = document.createElement('iframe'); f.srcdoc = ${js(script(rtcScript(c)))}; document.body.appendChild(f);`,
  ) +
  '</body></html>';

// A page that navigates itself away. The document's CSP can't govern this: a
// navigation is not a load the page makes, it is the page being replaced. Two
// destinations: an http URL (the canary's HTTP server), and a data: document that
// would run, unguarded, with working WebRTC (it reaches for the UDP canary).
const dataDocUrl = (c: Canary) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>data</title><script>${rtcScript(c)}</script>`)}`;

interface NavProbe {
  name: string;
  /** Where on the HTTP canary an http probe sends the page; null for the data: probes. */
  path: string | null;
  body(c: Canary): string;
}
const NAV_PROBES: readonly NavProbe[] = [
  { name: 'location-http', path: '/nav-location', body: (c) => script(`location = ${js(`${httpUrl(c)}/nav-location`)};`) },
  { name: 'location-data', path: null, body: (c) => script(`location = ${js(dataDocUrl(c))};`) },
  { name: 'meta-http', path: '/nav-meta', body: (c) => `<meta http-equiv="refresh" content="0;url=${attr(`${httpUrl(c)}/nav-meta`)}">` },
  { name: 'meta-data', path: null, body: (c) => `<meta http-equiv="refresh" content="0;url=${attr(dataDocUrl(c))}">` },
  // Top-level this is the page itself; framed it is the app, which the sandbox flags forbid.
  { name: 'top-location-http', path: '/nav-top', body: (c) => script(`top.location = ${js(`${httpUrl(c)}/nav-top`)};`) },
];
const navProbe = (name: string): NavProbe => {
  const probe = NAV_PROBES.find((p) => p.name === name);
  if (probe === undefined) throw new Error(`no navigation probe named ${name}`);
  return probe;
};
const navId = (probe: string) => `nav-${probe}`;
/**
 * The framed probes that can reach a canary, run again from a shell with no
 * frame-src (the artifact URL framed by a page with no CSP). They are the control
 * for the framed navigation tests: the refusal is the shell's, and the canaries
 * hear a page that is allowed to go. Own artifacts, so own canaries.
 */
const OPEN_SHELL_CONTROLS = ['location-http', 'location-data'] as const;
const navOpenId = (probe: string) => `navopen-${probe}`;

/** The hardest corpus pages, by name, run in every cell. One per way the pages go wrong. */
const SUBSET: readonly string[] = [
  'iframe',
  'iframe, never closed (swallows the rest of the page)',
  'iframe after an abruptly closed comment',
  'object with an iframe as fallback content',
  'frameset document',
  'closed shadow root',
  'shadowrootmode, upper case',
  'nested shadow roots',
  'shadow root template in svg',
  'noscript hiding an iframe in an attribute (head)',
  'svg foreignObject',
  'math annotation-xml text/html',
  'revealed: mtext, table, mglyph and a style',
  'revealed: forms nested through foreign content',
  'select with a div around an iframe',
];

// ---- the canaries ---------------------------------------------------------

interface Canary {
  udpPort: number;
  httpPort: number;
  /** Datagrams the UDP canary has received since the last reset. */
  datagrams: number;
  /** What the HTTP canary has seen since the last reset: requests, upgrades, CONNECTs and bare TCP connections. */
  hits: string[];
  reset(): void;
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((done) => {
    if (!server) return done();
    server.closeAllConnections();
    server.close(() => done());
  });
}

function bindUdp(socket: UdpSocket): Promise<number> {
  return new Promise((done, fail) => {
    socket.once('error', fail);
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', fail);
      done(socket.address().port);
    });
  });
}

async function startCanary(): Promise<Canary> {
  const udp = createSocket('udp4');
  const http = createServer((req: IncomingMessage, res) => {
    canary.hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('canary');
  });
  const canary: Canary = {
    udpPort: 0,
    httpPort: 0,
    datagrams: 0,
    hits: [],
    reset: () => {
      canary.datagrams = 0;
      canary.hits = [];
    },
    close: async () => {
      await Promise.all([new Promise<void>((done) => udp.close(() => done())), closeServer(http)]);
    },
  };
  udp.on('message', () => {
    canary.datagrams += 1;
  });
  // A TURN allocation is not HTTP, so Node reports it as a connection and then a client error, never a request.
  http.on('connection', () => canary.hits.push('tcp connection'));
  http.on('clientError', (_err, socket) => socket.destroy());
  // A WebSocket handshake arrives as 'upgrade', CONNECT as 'connect'.
  http.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    canary.hits.push(`upgrade ${req.url}`);
    socket.destroy();
  });
  http.on('connect', (req: IncomingMessage, socket: Socket) => {
    canary.hits.push(`connect ${req.url}`);
    socket.destroy();
  });
  canary.udpPort = await bindUdp(udp);
  canary.httpPort = await listen(http);
  return canary;
}

// ---- the runs -------------------------------------------------------------

interface ProbeResult {
  /** The status the artifact URL answered with, or null if it never did. */
  status: number | null;
  /** The artifact's own first script ran. */
  ran: boolean;
  /** Why the page never loaded, if it didn't. */
  error: string | null;
  datagrams: number;
  hits: string[];
}

type Results = Map<string, ProbeResult>;

function result(results: Results, probe: string): ProbeResult {
  const r = results.get(probe);
  if (r === undefined) throw new Error(`no result for the ${probe} probe`);
  return r;
}

/** Polls until `done()` holds, or `ms` pass. Never throws: the caller asserts what it found. */
async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

/** Runs the tasks, at most `limit` at a time, and hands back what they returned in order. */
async function runPooled<T>(limit: number, tasks: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < tasks.length; i = next++) out[i] = await tasks[i]!();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

// The other families look at a page more closely than the probes do.

/** A shell the artifact is framed by: the real one (frame-src <content origin>/v/), or one with no CSP at all. */
type Shell = 'real' | 'open';

interface ConsoleLine {
  /** Playwright's console message type, or `pageerror` for an uncaught exception. */
  type: string;
  text: string;
}

/** What a script in the artifact frame can read about its own page. */
interface DomFacts {
  /** Frame-making elements and open shadow roots that ever reached the document (INSERTION_WATCH). */
  inserted: string[];
  /** `document.querySelectorAll` over the frame-making tags. */
  lightFrames: number;
  /** `window.length`: child browsing contexts in the document tree. */
  windowLength: number;
  /** `typeof RTCPeerConnection`: 'undefined' once the guard has run. */
  rtc: string;
  /** `document.documentElement` exists. False once the guard has blanked the page. */
  root: boolean;
  /** The body's text, or null when there is no body (a blanked page). */
  bodyText: string | null;
}

interface Report<T = undefined> {
  artifactUrl: string;
  /** The status the artifact URL answered with, or null if it never did. */
  status: number | null;
  /** Why the page was not fully examined, if it wasn't. */
  error: string | null;
  /** The page's own URL when it settled. A page that navigated itself away is somewhere else. */
  pageUrl: string | null;
  /** The artifact frame's URL when it settled. */
  frameUrl: string | null;
  /** Every URL any frame committed, in order. */
  navigations: string[];
  console: ConsoleLine[];
  /** Child frames anywhere below the artifact frame, in closed shadow roots too (Playwright's frame tree). */
  descendants: number | null;
  dom: DomFacts | null;
  /** What the `act` hook handed back. */
  acted: T | undefined;
  datagrams: number;
  hits: string[];
}

function countDescendants(frame: Frame): number {
  return frame.childFrames().reduce((n, child) => n + 1 + countDescendants(child), 0);
}

/** The frame the artifact runs in: the page itself, or the one iframe of the app page. */
function artifactFrame(page: Page, framing: Framing): Frame {
  if (framing === 'top-level') return page.mainFrame();
  const frame = page.mainFrame().childFrames()[0];
  if (frame === undefined) throw new Error('the app page has no artifact frame');
  return frame;
}

function report<T>(reports: Map<string, Report<T>>, key: string): Report<T> {
  const r = reports.get(key);
  if (r === undefined) throw new Error(`no report for ${key}`);
  return r;
}

const guardWarnings = (r: Report<unknown>) => r.console.filter((line) => line.text.includes(KILL_WARNING));

/**
 * What a hostile page served by the origin must leave behind. Every line is a
 * different layer's claim, and each can fail alone:
 * - the origin served it and the guard ran in it (or "nothing leaked" is vacuous);
 * - nothing that can hold a frame ever reached the document (the server's cut),
 *   none exists in the frame tree (the end state, closed shadow roots included);
 * - the guard's kill switch never had to fire (it blanks the page, which would
 *   also make the checks above read zero);
 * - the canaries heard nothing.
 */
function expectContained(r: Report<unknown>, label: string): void {
  expect.soft(r.error, `${label}: the page was examined`).toBeNull();
  expect.soft(r.status, `${label}: the origin served it (a refusal would pass the rest for nothing)`).toBe(200);
  expect.soft(r.dom?.rtc, `${label}: the guard is running (RTCPeerConnection is locked)`).toBe('undefined');
  expect.soft(r.dom?.inserted, `${label}: frame-making elements or shadow roots that ever reached the document`).toEqual([]);
  expect.soft(r.dom?.lightFrames, `${label}: iframe/frame/object/embed/... in the document`).toBe(0);
  expect.soft(r.dom?.windowLength, `${label}: window.length`).toBe(0);
  expect.soft(r.descendants, `${label}: child frames anywhere in the frame tree (closed shadow roots included)`).toBe(0);
  expect.soft(r.dom?.root, `${label}: the page was not blanked`).toBe(true);
  expect.soft(guardWarnings(r), `${label}: the guard's kill switch had to fire`).toEqual([]);
  expect.soft(r.datagrams, `${label}: UDP packets that reached the canary`).toBe(0);
  expect.soft(r.hits, `${label}: HTTP canary hits`).toEqual([]);
}

/** A page that tried to leave and was stopped: no frame ever committed the canary or a data: URL, and no canary heard anything. */
function expectNothingSent(r: Report<unknown>, label: string, canaryUrl: string): void {
  const committed = r.navigations.filter((url) => url.startsWith('data:') || url.startsWith(canaryUrl));
  expect.soft(committed, `${label}: navigations committed to the canary or a data: URL`).toEqual([]);
  expect.soft(r.datagrams, `${label}: UDP packets that reached the canary`).toBe(0);
  expect.soft(r.hits, `${label}: HTTP canary hits`).toEqual([]);
}

/** A corpus page as stored: its artifact id, its name, and whether its frame runs a script. */
interface CorpusPage {
  id: string;
  name: string;
  live: boolean;
}

/** The facts of the ordinary page (ORDINARY_FACTS). */
interface OrdinaryFacts {
  ready: string | null;
  title: string;
  quirks: boolean;
  rows: string[][];
  canvas: { red: number[]; blue: number[]; untouched: number[] };
  circle: { fill: string; width: number };
  preTwo: string;
  preOne: string;
  textarea: string;
  text: string;
  hash: string;
  scrolled: boolean;
  target: string | null;
}

interface OrdinaryRun {
  before: OrdinaryFacts;
  after: OrdinaryFacts;
}

/** Reads the ordinary page once its script has run, clicks its #anchor link, and reads it again. */
async function exerciseOrdinary(frame: Frame): Promise<OrdinaryRun> {
  // The page's script marks its table when it has run. If it never does, the facts say `ready: null`.
  await frame
    .waitForFunction("document.getElementById('t') && document.getElementById('t').getAttribute('data-ready') === 'yes'", undefined, {
      timeout: 5000,
    })
    .catch(() => undefined);
  const before = (await frame.evaluate(ORDINARY_FACTS)) as OrdinaryFacts;
  await frame.click('#jump');
  await frame.waitForFunction("location.hash === '#end'", undefined, { timeout: 2000 }).catch(() => undefined);
  const after = (await frame.evaluate(ORDINARY_FACTS)) as OrdinaryFacts;
  return { before, after };
}

/** Everything the families run in one cell, by what they ran. */
interface Scenarios {
  /** The subset of the corpus, through the origin, by page name. */
  vectors: Map<string, Report>;
  ordinary: { origin: Report<OrdinaryRun>; control: Report<OrdinaryRun> };
  /** The kill-switch pages, by artifact id. */
  kill: Map<string, Report>;
  /** The navigation probes through the origin, by probe name. */
  nav: Map<string, Report>;
  /** Framed cells only: the OPEN_SHELL_CONTROLS, by probe name. */
  navOpen: Map<string, Report>;
}

describe.skipIf(CHROMIUM_MISSING && !IN_CI)('artifact HTML in Chromium (hostile content, WebRTC)', () => {
  const key = randomBytes(32);
  const canaries = new Map<string, Canary>();
  /** probe name -> the artifact HTML the origin and the control both serve. */
  const artifacts = new Map<string, string>();
  /** path -> the app page served there. */
  const pages = new Map<string, string>();
  let app: Server;
  let appOrigin: string;
  let origin: ContentOriginHandle;
  let control: Server;
  let controlUrl: string;
  let defaultBrowser: Browser;
  let isolatedBrowser: Browser;
  /** The corpus pages as stored (filled in by the first beforeAll). */
  const corpus: CorpusPage[] = [];

  beforeAll(async () => {
    if (CHROMIUM_MISSING) {
      // Only reachable in CI: locally a missing browser skips the suite above.
      throw new Error(
        `Playwright Chromium is not installed at ${chromium.executablePath()}. CI must run this suite, not skip it: ` +
          'check the "Install Playwright Chromium" step in .github/workflows/ci.yml.',
      );
    }
    for (const probe of PROBES) {
      const canary = await startCanary();
      canaries.set(probe.name, canary);
      artifacts.set(probe.name, artifactDoc(probe.name, probe.body(rtcScript(canary))));
    }

    // The other families' pages. Each has canaries of its own, so pages that run side by side can't hide each other's leaks.
    for (const [i, vector] of HOSTILE_VECTORS.entries()) {
      const id = `vec-${i}`;
      const canary = await startCanary();
      canaries.set(id, canary);
      artifacts.set(id, withLiveFrame(vector.html, rtcScript(canary)));
      corpus.push({ id, name: vector.name, live: vector.html.includes(IFRAME) });
    }
    artifacts.set(ORDINARY_ID, ORDINARY_HTML);
    for (const [id, page] of [
      [KILL_ID, killPage],
      [PURGE_ID, purgePage],
    ] as const) {
      const canary = await startCanary();
      canaries.set(id, canary);
      artifacts.set(id, page(canary));
    }
    for (const [id, probe] of [
      ...NAV_PROBES.map((p) => [navId(p.name), p] as const),
      ...OPEN_SHELL_CONTROLS.map((name) => [navOpenId(name), navProbe(name)] as const),
    ]) {
      const canary = await startCanary();
      canaries.set(id, canary);
      artifacts.set(id, artifactDoc(id, probe.body(canary)));
    }

    app = createServer((req, res) => {
      const page = pages.get(req.url ?? '');
      if (page === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
    });
    appOrigin = `http://127.0.0.1:${await listen(app)}`;

    origin = await startContentOrigin({
      host: '127.0.0.1',
      port: 0,
      frameAncestors: [appOrigin],
      key,
      serve: async (claims) => {
        const html = artifacts.get(claims.artifactId);
        if (html === undefined) return null;
        return {
          bytes: new TextEncoder().encode(html),
          mediaType: 'text/html',
          preview: 'html',
          filename: `${claims.artifactId}.html`,
        };
      },
    });

    // The control serves the stored bytes as they are, with the headers the real
    // origin answers with (its CSP included, read off a real response rather than
    // restated here). What it lacks is whatever the origin does to those bytes:
    // the guard.
    const sample = await fetch(viewUrl('origin', 'direct'));
    if (sample.status !== 200) throw new Error(`the content origin answered its own view token with ${sample.status}`);
    const skip = new Set(['content-length', 'date', 'connection', 'keep-alive', 'transfer-encoding']);
    const headers = Object.fromEntries([...sample.headers].filter(([name]) => !skip.has(name)));
    control = createServer((req, res) => {
      const name = /^\/v\/([\w-]+)$/.exec(req.url ?? '')?.[1];
      const html = name === undefined ? undefined : artifacts.get(name);
      if (html === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { ...headers, 'content-length': String(Buffer.byteLength(html)) }).end(html);
    });
    controlUrl = `http://127.0.0.1:${await listen(control)}`;

    defaultBrowser = await chromium.launch();
    isolatedBrowser = await chromium.launch({ args: ISOLATED_ARGS });
    console.info(`[artifacts-webrtc-hostile] Chromium ${defaultBrowser.version()}`);
  });

  afterAll(async () => {
    await isolatedBrowser?.close();
    await defaultBrowser?.close();
    await closeServer(control);
    await origin?.close();
    await closeServer(app);
    await Promise.all([...canaries.values()].map((c) => c.close()));
  });

  /** A view URL: a token the real origin will accept, or a plain path on the control. */
  function viewUrl(target: Target, probe: string): string {
    if (target === 'control') return `${controlUrl}/v/${probe}`;
    const token = signViewToken(key, {
      artifactId: probe,
      version: 1,
      purpose: 'view',
      linkBinding: null,
      expiresAt: Math.floor(Date.now() / 1000) + VIEW_TOKEN_TTL_SECONDS,
    });
    return `${origin.url}/v/${token}`;
  }

  /**
   * The app page: the iframe ArtifactPreview renders, attribute for attribute,
   * under the CSP a deploy with a content origin gives the shell
   * (@ax/static-files widens `frame-src 'none'` to `frame-src <content origin>/v/`).
   * The 'open' shell has no CSP at all: the control for what that one refuses.
   */
  function appPage(artifactUrl: string, probe: string, shell: Shell = 'real'): string {
    const frameSrc = `${new URL(artifactUrl).origin}/v/`;
    const csp = shell === 'real' ? `<meta http-equiv="Content-Security-Policy" content="frame-src ${frameSrc}">` : '';
    return (
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      csp +
      '<title>artifact viewer</title></head><body>' +
      `<iframe src="${attr(artifactUrl)}" sandbox="allow-scripts allow-downloads" referrerpolicy="no-referrer" ` +
      `title="${attr(probe)}" style="width:640px;height:480px"></iframe></body></html>`
    );
  }

  /** One probe on one page: load it (via the app page, or straight), then give it time to leak. */
  async function visit(
    browser: Browser,
    framing: Framing,
    target: Target,
    probe: string,
  ): Promise<Pick<ProbeResult, 'status' | 'ran' | 'error'>> {
    const canary = canaries.get(probe)!;
    const artifactUrl = viewUrl(target, probe);
    let entry = artifactUrl;
    if (framing === 'framed') {
      const path = `/${target}/${probe}`;
      pages.set(path, appPage(artifactUrl, probe));
      entry = `${appOrigin}${path}`;
    }
    const seen = { status: null as number | null, ran: false };
    const page = await browser.newPage();
    page.on('response', (r) => {
      if (r.url() === artifactUrl) seen.status = r.status();
    });
    page.on('console', (m) => {
      if (m.text() === `ax-probe:${probe}`) seen.ran = true;
    });
    let error: string | null = null;
    try {
      await page.goto(entry);
      await page.waitForTimeout(SETTLE_MS);
      if (target === 'control' && CONTROL_MUST_REACH.includes(probe)) await until(() => canary.datagrams > 0, LIVE_MS);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      await page.close();
    }
    return { ...seen, error };
  }

  /** Every probe, side by side, each against its own canaries. */
  async function runCell(mode: Mode, framing: Framing, target: Target, label: string): Promise<Results> {
    for (const c of canaries.values()) c.reset();
    const browser = mode === 'default' ? defaultBrowser : isolatedBrowser;
    const visits = await Promise.all(PROBE_NAMES.map((probe) => visit(browser, framing, target, probe)));
    const results: Results = new Map();
    PROBE_NAMES.forEach((probe, i) => {
      const canary = canaries.get(probe)!;
      results.set(probe, { ...visits[i]!, datagrams: canary.datagrams, hits: [...canary.hits] });
    });
    console.info(
      `[artifacts-webrtc-hostile] ${label}, ${target}: ` +
        PROBE_NAMES.map((p) => `${p} ${result(results, p).datagrams} UDP + ${result(results, p).hits.length} hit`).join(', '),
    );
    return results;
  }

  interface InspectOptions<T> {
    browser: Browser;
    framing: Framing;
    target: Target;
    /** The artifact's id: its canaries are the ones this page may reach. */
    id: string;
    /** How long to leave the page alone once it has loaded (and `act` is done). */
    settleMs: number;
    /** Frame the artifact from a shell with no frame-src. Framed pages only. */
    shell?: Shell;
    /** Does something to the loaded page and hands back what it found. */
    act?: (frame: Frame, page: Page) => Promise<T>;
    /** Runs after the settle wait: waits for a canary the page should have reached. */
    afterSettle?: (frame: Frame, canary: Canary | undefined) => Promise<void>;
    /** False for pages that are expected to leave: there is no document to read the facts from. */
    dom?: boolean;
  }

  /**
   * One page, examined closely: load it (via the app page, or straight), let it
   * act, give it time to leak, then read what it left behind from the outside
   * (the frame tree, the console, the canaries) and from the inside (DOM_FACTS).
   */
  async function inspect<T = undefined>(o: InspectOptions<T>): Promise<Report<T>> {
    const canary = canaries.get(o.id);
    canary?.reset();
    const artifactUrl = viewUrl(o.target, o.id);
    let entry = artifactUrl;
    if (o.framing === 'framed') {
      const shell = o.shell ?? 'real';
      const path = `/${o.target}/${shell}/${o.id}`;
      pages.set(path, appPage(artifactUrl, o.id, shell));
      entry = `${appOrigin}${path}`;
    }
    const page = await o.browser.newPage();
    await page.addInitScript(INSERTION_WATCH);
    const lines: ConsoleLine[] = [];
    const navigations: string[] = [];
    const seen = { status: null as number | null };
    page.on('response', (r) => {
      if (r.url() === artifactUrl) seen.status = r.status();
    });
    page.on('console', (m) => lines.push({ type: m.type(), text: m.text() }));
    page.on('pageerror', (e) => lines.push({ type: 'pageerror', text: e.message }));
    page.on('framenavigated', (f) => navigations.push(f.url()));
    const out = {
      error: null as string | null,
      pageUrl: null as string | null,
      frameUrl: null as string | null,
      descendants: null as number | null,
      dom: null as DomFacts | null,
      acted: undefined as T | undefined,
    };
    try {
      await page.goto(entry);
      const frame = artifactFrame(page, o.framing);
      if (o.act !== undefined) out.acted = await o.act(frame, page);
      await page.waitForTimeout(o.settleMs);
      if (o.afterSettle !== undefined) await o.afterSettle(frame, canary);
      out.pageUrl = page.url();
      out.frameUrl = frame.url();
      out.descendants = countDescendants(frame);
      if (o.dom !== false) out.dom = (await frame.evaluate(DOM_FACTS)) as DomFacts;
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
    } finally {
      await page.close();
    }
    return {
      artifactUrl,
      status: seen.status,
      navigations,
      console: lines,
      datagrams: canary?.datagrams ?? 0,
      hits: [...(canary?.hits ?? [])],
      ...out,
    };
  }

  function corpusPage(name: string): CorpusPage {
    const found = corpus.find((p) => p.name === name);
    if (found === undefined) throw new Error(`the corpus has no page named "${name}"; rename it in SUBSET too`);
    return found;
  }

  /** Everything the other families look at in one cell, page after page through a pool. */
  async function runScenarios(mode: Mode, framing: Framing): Promise<Scenarios> {
    const browser = mode === 'default' ? defaultBrowser : isolatedBrowser;
    const base = { browser, framing, target: 'origin' } as const;
    const vectors = new Map<string, Report>();
    const kill = new Map<string, Report>();
    const nav = new Map<string, Report>();
    const navOpen = new Map<string, Report>();
    const ran: { ordinary?: Scenarios['ordinary'] } = {};
    const tasks: Array<() => Promise<void>> = [
      // Two visits to one page, so one task: the slowest goes first.
      async () => {
        const origin = await inspect({ ...base, id: ORDINARY_ID, settleMs: 300, act: exerciseOrdinary });
        const control = await inspect({ ...base, target: 'control', id: ORDINARY_ID, settleMs: 300, act: exerciseOrdinary });
        ran.ordinary = { origin, control };
      },
      ...SUBSET.map((name) => async () => {
        vectors.set(name, await inspect({ ...base, id: corpusPage(name).id, settleMs: QUICK_SETTLE_MS }));
      }),
      ...[KILL_ID, PURGE_ID].map((id) => async () => {
        kill.set(id, await inspect({ ...base, id, settleMs: QUICK_SETTLE_MS }));
      }),
      ...NAV_PROBES.map((p) => async () => {
        nav.set(p.name, await inspect({ ...base, id: navId(p.name), settleMs: QUICK_SETTLE_MS, dom: false }));
      }),
    ];
    if (framing === 'framed') {
      for (const name of OPEN_SHELL_CONTROLS) {
        tasks.push(async () => {
          navOpen.set(
            name,
            await inspect({
              ...base,
              id: navOpenId(name),
              shell: 'open',
              settleMs: QUICK_SETTLE_MS,
              dom: false,
              // Let a slow runner arrive: a page that is allowed to go reaches one canary or the other.
              afterSettle: async (_frame, c) => {
                if (c !== undefined) await until(() => c.datagrams > 0 || c.hits.some((h) => h.startsWith('GET ')), LIVE_MS);
              },
            }),
          );
        });
      }
    }
    await runPooled(PAGE_CONCURRENCY, tasks);
    if (ran.ordinary === undefined) throw new Error('the ordinary page was never examined');
    return { vectors, ordinary: ran.ordinary, kill, nav, navOpen };
  }

  describe.each(CELLS)('$label', ({ mode, framing, label }) => {
    let fromOrigin: Results;
    let fromControl: Results;
    let scenarios: Scenarios;

    beforeAll(async () => {
      fromOrigin = await runCell(mode, framing, 'origin', label);
      fromControl = await runCell(mode, framing, 'control', label);
    });

    beforeAll(async () => {
      scenarios = await runScenarios(mode, framing);
      const where = (r: Report) => (framing === 'framed' ? r.frameUrl : r.pageUrl);
      console.info(
        `[artifacts-webrtc-hostile] ${label}: ` +
          `corpus subset ${[...scenarios.vectors.values()].filter((r) => r.dom?.inserted.length === 0 && r.descendants === 0).length}/${SUBSET.length} clean; ` +
          `kill: ${[...scenarios.kill].map(([id, r]) => `${id} root=${r.dom?.root} warnings=${guardWarnings(r).length}`).join(', ')}; ` +
          `navigation: ${[...scenarios.nav].map(([name, r]) => `${name} -> ${where(r)?.replace(/\?.*/, '').slice(0, 40)} (${r.datagrams} UDP, ${r.hits.length} hit)`).join(', ')}`,
      );
    });

    it('serves every probe and every probe starts, on the origin and on the control', () => {
      const broken = (target: Target, results: Results) =>
        PROBE_NAMES.filter((p) => {
          const r = result(results, p);
          return r.error !== null || r.status !== 200 || !r.ran;
        }).map((p) => `${target}/${p}: ${JSON.stringify(result(results, p), ['status', 'ran', 'error'])}`);
      expect([...broken('origin', fromOrigin), ...broken('control', fromControl)]).toEqual([]);
    });

    describe('the real content origin', () => {
      it.each(PROBE_NAMES)('%s reaches neither canary', (name) => {
        const r = result(fromOrigin, name);
        expect.soft(r.datagrams, `UDP packets from the ${name} probe that reached the canary`).toBe(0);
        expect.soft(r.hits, `HTTP canary hits (requests or connections) from the ${name} probe`).toEqual([]);
      });
    });

    describe("the unguarded control (the origin's headers, the stored bytes, no guard)", () => {
      it.each(CONTROL_MUST_REACH)('%s reaches the UDP canary, so a silent canary means something', (name) => {
        expect(result(fromControl, name).datagrams, `UDP packets from the unguarded ${name} probe`).toBeGreaterThan(0);
      });
    });

    describe('parse-time vectors from the corpus (the hardest 15; the whole corpus runs in one cell below)', () => {
      it.each(SUBSET)('%s leaves nothing that can hold a frame', (name) => {
        expectContained(report(scenarios.vectors, name), name);
      });
    });

    describe('an ordinary artifact (table, canvas script, inline SVG, <pre>, #anchor link)', () => {
      it('renders: the table, the canvas the script drew, the inline SVG, the <pre> and the <textarea>', () => {
        const { origin } = scenarios.ordinary;
        const page = origin.acted?.before;
        expect.soft(origin.error, 'the page was exercised').toBeNull();
        expect.soft(origin.status).toBe(200);
        expect.soft(page?.title).toBe('Quarterly numbers');
        expect.soft(page?.quirks, 'quirks mode (the doctype survived the rewrite)').toBe(false);
        expect.soft(page?.rows).toEqual([
          ['North', '1,200'],
          ['South', '950'],
        ]);
        expect.soft(page?.canvas, 'pixels the page script drew').toEqual({
          red: [255, 0, 0, 255],
          blue: [0, 0, 255, 255],
          untouched: [0, 0, 0, 0],
        });
        expect.soft(page?.circle, 'the inline SVG laid out and painted').toEqual({ fill: 'rgb(0, 128, 0)', width: 40 });
        // The parser eats the first newline after <pre> and <textarea>; the author's second one has to survive the rewrite.
        expect.soft(page?.preTwo).toBe('\ntwo newlines before this line\n  indented');
        expect.soft(page?.preOne).toBe('one newline before this line');
        expect.soft(page?.textarea).toBe('\nbox');
      });

      it('its script ran, under the guard, and the guard did not get in its way', () => {
        const { origin } = scenarios.ordinary;
        expect.soft(origin.acted?.before.ready, "the page's own script marked the table").toBe('yes');
        expect.soft(origin.dom?.rtc, 'the guard is running').toBe('undefined');
        expect.soft(origin.dom?.root).toBe(true);
        expect.soft(origin.dom?.windowLength).toBe(0);
        expect.soft(origin.console.filter((l) => l.type === 'pageerror'), 'uncaught errors in the page').toEqual([]);
        expect.soft(guardWarnings(origin), "the guard's kill switch").toEqual([]);
      });

      it('an #anchor link still scrolls to its target', () => {
        const { origin } = scenarios.ordinary;
        expect.soft(origin.acted?.before).toMatchObject({ hash: '', scrolled: false, target: null });
        expect.soft(origin.acted?.after).toMatchObject({ hash: '#end', scrolled: true, target: 'end' });
        expect.soft(origin.frameUrl, 'the frame stayed on the same document').toMatch(/#end$/);
      });

      it('looks exactly as it does with no guard at all', () => {
        const { origin, control } = scenarios.ordinary;
        expect(control.error, 'the control page was exercised').toBeNull();
        expect(control.dom?.rtc, 'the control really runs no guard').toBe('function');
        expect(origin.acted).toEqual(control.acted);
      });
    });

    describe('the kill switch', () => {
      it('a child frame made inside the guard\'s own purge blanks the page, says why, and never runs', () => {
        const r = report(scenarios.kill, KILL_ID);
        expect.soft(r.error, 'the page was examined').toBeNull();
        expect.soft(
          r.console.map((l) => l.text),
          "the page armed the trap, and the guard's purge sprang it: its callback ran with the bait gone and one new child",
        ).toEqual(expect.arrayContaining(['ax-kill:armed', 'ax-kill:inserted', 'ax-kill:reentered 1']));
        expect.soft(guardWarnings(r), "the guard's console warning, once").toHaveLength(1);
        expect.soft(r.dom?.root, 'the page is blank').toBe(false);
        expect.soft(r.dom?.bodyText, 'nothing of the page is left').toBeNull();
        expect.soft(r.dom?.windowLength).toBe(0);
        expect.soft(r.descendants, 'no frame survives the teardown').toBe(0);
        expect.soft(r.datagrams, 'UDP packets from the frame that was torn down').toBe(0);
        expect.soft(r.hits, 'HTTP canary hits').toEqual([]);
      });

      it('and the page stays blank when its own timer rebuilds a root afterwards', () => {
        const r = report(scenarios.kill, KILL_ID);
        expect.soft(
          r.console.map((l) => l.text),
          'the rebuild ran',
        ).toContain('ax-kill:rebuilt');
        expect.soft(r.dom?.root, 'the rebuilt root was removed again').toBe(false);
        expect.soft(r.dom?.rtc, "the guard's locks outlive the page").toBe('undefined');
      });

      it('a script-created frame is purged on the spot, and the page carries on (the kill switch stays out of it)', () => {
        const r = report(scenarios.kill, PURGE_ID);
        expect.soft(r.error, 'the page was examined').toBeNull();
        expect.soft(r.dom?.root, 'the page is not blank').toBe(true);
        expect.soft(r.dom?.bodyText, "the page's own timer ran after the purge").toBe('still alive');
        expect.soft(r.dom?.lightFrames, 'the frame is gone').toBe(0);
        expect.soft(r.dom?.windowLength).toBe(0);
        expect.soft(r.descendants).toBe(0);
        expect.soft(guardWarnings(r), "the guard's kill switch").toEqual([]);
        expect.soft(r.datagrams, 'UDP packets from the frame').toBe(0);
        expect.soft(r.hits, 'HTTP canary hits').toEqual([]);
      });
    });

    if (framing === 'framed') {
      // The shell's meta is restated here, as for every framed page in this file: channel-web's
      // visual-hostile test pins that index.html carries `frame-src 'none'`, and @ax/static-files'
      // tests pin its widening to `frame-src <content origin>/v/`.
      describe('a page navigating itself, framed by the app (the shell allows only <content origin>/v/)', () => {
        const canaryUrl = (probe: string) => httpUrl(canaries.get(navId(probe))!);
        /** The app page `inspect` served for this probe, on the real shell. */
        const appUrl = (probe: string) => `${appOrigin}/origin/real/${navId(probe)}`;

        it.each(['location-http', 'location-data', 'meta-http', 'meta-data'])('%s is refused by the shell, and nothing is sent', (name) => {
          const r = report(scenarios.nav, name);
          expect.soft(r.error, 'the page was examined').toBeNull();
          expect.soft(r.status).toBe(200);
          // Chromium commits its own error page in a frame whose navigation the parent's CSP refused.
          expect.soft(r.frameUrl, 'what the frame ended on').toBe('chrome-error://chromewebdata/');
          expect.soft(
            r.console.some((l) => /violates the following Content Security Policy directive: "frame-src /.test(l.text)),
            "the shell's frame-src said so in the console",
          ).toBe(true);
          expect.soft(r.pageUrl, 'the app page itself did not move').toBe(appUrl(name));
          expectNothingSent(r, name, canaryUrl(name));
        });

        it('top.location = <http url> is refused by the sandbox, and nothing is sent', () => {
          const r = report(scenarios.nav, 'top-location-http');
          expect.soft(r.error, 'the page was examined').toBeNull();
          expect.soft(r.pageUrl, 'the app page did not move').toBe(appUrl('top-location-http'));
          expect.soft(r.frameUrl, 'the frame was not navigated either').toBe(r.artifactUrl);
          expectNothingSent(r, 'top-location-http', canaryUrl('top-location-http'));
        });

        it.each(OPEN_SHELL_CONTROLS)('control: %s from a shell with no frame-src does get out, so the refusal above is the shell', (name) => {
          const r = report(scenarios.navOpen, name);
          expect.soft(r.error, 'the page was examined').toBeNull();
          if (name === 'location-http') {
            expect.soft(r.hits, 'HTTP canary hits from the frame').toContain('GET /nav-location');
          } else {
            expect.soft(r.datagrams, 'UDP packets from the data: document the frame loaded').toBeGreaterThan(0);
          }
        });
      });
    } else {
      describe('a page navigating itself, opened top-level (no app around it, so no shell CSP)', () => {
        const canaryUrl = (probe: string) => httpUrl(canaries.get(navId(probe))!);

        // KNOWN GAP (a follow-up card owns the fix). A document can always navigate
        // itself: sandbox flags only restrict navigating OTHER contexts, and CSP
        // `navigate-to` is not implemented. Framed, the app's frame-src stops it;
        // opened on its own, nothing does. These tests state what happens TODAY, so
        // the fix has to flip them. Do not make them pass by pretending otherwise.
        it.each(NAV_PROBES.filter((p) => p.path !== null))(
          'known gap: top-level /v/ page can navigate itself away ($name)',
          (probe) => {
            const r = report(scenarios.nav, probe.name);
            expect.soft(r.error, 'the page was examined').toBeNull();
            expect.soft(r.status).toBe(200);
            expect.soft(r.pageUrl, 'where the page ended up').toBe(`${canaryUrl(probe.name)}${probe.path}`);
            expect.soft(r.hits, 'HTTP canary hits: the page the artifact became').toContain(`GET ${probe.path}`);
          },
        );

        it.each(NAV_PROBES.filter((p) => p.path === null))(
          "Chromium itself refuses a top-level navigation to a data: URL ($name), so the unguarded document never loads (not our control)",
          (probe) => {
            const r = report(scenarios.nav, probe.name);
            expect.soft(r.error, 'the page was examined').toBeNull();
            expect.soft(r.pageUrl, 'the page did not move').toBe(r.artifactUrl);
            expect.soft(
              r.console.some((l) => /Not allowed to navigate top frame to data URL/.test(l.text)),
              "Chromium's own console error",
            ).toBe(true);
            expectNothingSent(r, probe.name, canaryUrl(probe.name));
          },
        );
      });
    }
  });

  // The whole corpus, in the cell that is closest to production: the app frames
  // the artifact. The parse is the same in every process model, so one cell is
  // enough here; the cells above run the hardest 15.
  describe('the whole corpus (default process model, framed by the app)', () => {
    let fromOrigin: Map<string, Report>;
    let fromControl: Map<string, Report>;

    beforeAll(async () => {
      const common = { browser: defaultBrowser, framing: 'framed' } as const;
      fromOrigin = new Map();
      fromControl = new Map();
      await runPooled(
        PAGE_CONCURRENCY,
        corpus.map((page) => async () => {
          fromOrigin.set(page.id, await inspect({ ...common, target: 'origin', id: page.id, settleMs: QUICK_SETTLE_MS }));
        }),
      );
      // The control needs no fixed wait: a frame is in the frame tree once the page has loaded, and a frame that
      // runs a script reaches the canary within a few hundred ms (polled, so a slow runner can't fake a dead canary).
      await runPooled(
        PAGE_CONCURRENCY,
        corpus.map((page) => async () => {
          fromControl.set(
            page.id,
            await inspect({
              ...common,
              target: 'control',
              id: page.id,
              settleMs: 300,
              afterSettle: async (frame, c) => {
                if (page.live && c !== undefined && countDescendants(frame) > 0) await until(() => c.datagrams > 0, LIVE_MS);
              },
            }),
          );
        }),
      );
      const frames = (r: Report) => r.descendants ?? 0;
      console.info(
        `[artifacts-webrtc-hostile] whole corpus, ${corpus.length} pages: through the origin ` +
          `${[...fromOrigin.values()].filter((r) => r.dom?.inserted.length === 0 && frames(r) === 0 && r.datagrams === 0).length} clean; ` +
          `unguarded control: ${[...fromControl.values()].filter((r) => frames(r) > 0).length} build a child frame, ` +
          `${[...fromControl.values()].filter((r) => r.datagrams > 0).length} reach the UDP canary; inert as written: ` +
          corpus
            .filter((p) => frames(report(fromControl, p.id)) === 0)
            .map((p) => p.name)
            .join('; '),
      );
    });

    it('swaps a frame that runs a script into most of the corpus', () => {
      expect(corpus.filter((p) => p.live).length, 'pages whose inert frame was swapped').toBeGreaterThanOrEqual(40);
    });

    describe('the real content origin', () => {
      it.each(HOSTILE_VECTORS.map((v, i) => ({ i, name: v.name })))('$name leaves nothing that can hold a frame', ({ i, name }) => {
        const page = corpus[i]!;
        expect(page.name).toBe(name);
        expectContained(report(fromOrigin, page.id), name);
      });
    });

    describe("the unguarded control (the origin's headers, the stored pages, no guard): the corpus still bites", () => {
      it('runs no guard', () => {
        const guarded = corpus.filter((p) => report(fromControl, p.id).dom?.rtc !== 'function').map((p) => p.name);
        expect(guarded).toEqual([]);
      });

      // Measured in Chromium 147: 51 of the 72 build a child frame, 41 reach the UDP canary. The floors leave
      // room for a point release to turn a few pages inert, and still go red if the corpus stops biting.
      it('most pages build a child frame in this Chromium', () => {
        const biting = corpus.filter((p) => (report(fromControl, p.id).descendants ?? 0) > 0);
        expect(biting.length, `of ${corpus.length} pages`).toBeGreaterThanOrEqual(45);
      });

      it('and the frames that run a script reach the UDP canary', () => {
        const heard = corpus.filter((p) => p.live && report(fromControl, p.id).datagrams > 0);
        expect(heard.length, `of ${corpus.filter((p) => p.live).length} pages with a live frame`).toBeGreaterThanOrEqual(32);
        expect(heard.map((p) => p.name), 'the plainest page of all').toContain('iframe');
      });

      it('the insertion watch is live: it records the frame the parser put in the plainest page', () => {
        expect(report(fromControl, corpusPage('iframe').id).dom?.inserted).toContain('iframe');
      });

      it('and the frame tree sees what the document cannot: a frame in a closed shadow root', () => {
        const r = report(fromControl, corpusPage('closed shadow root').id);
        expect.soft(r.dom?.lightFrames, 'querySelectorAll').toBe(0);
        expect.soft(r.dom?.windowLength, 'window.length').toBe(0);
        expect.soft(r.dom?.inserted, 'the insertion watch').toEqual([]);
        expect.soft(r.descendants, "Playwright's frame tree").toBe(1);
      });
    });
  });
});
