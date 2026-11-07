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
// Locally this skips when Playwright's Chromium isn't installed. In CI it never
// skips: CI installs Chromium (.github/workflows/ci.yml), and if that ever
// stops working the suite fails instead of going quietly green.
import { randomBytes } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startContentOrigin, type ContentOriginHandle } from '../artifacts/content-origin.js';
import { VIEW_TOKEN_TTL_SECONDS, signViewToken } from '../artifacts/view-token.js';

const IN_CI = !!process.env.CI;
const CHROMIUM_MISSING = !existsSync(chromium.executablePath());

/** After a page loads, how long it has to reach a canary. A STUN packet lands within ~250 ms locally. */
const SETTLE_MS = 2500;
/** A probe the control must reach the canary with may take this long, so a slow runner can't fake a dead canary. */
const LIVE_MS = 10_000;

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
   */
  function appPage(artifactUrl: string, probe: string): string {
    const frameSrc = `${new URL(artifactUrl).origin}/v/`;
    return (
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      `<meta http-equiv="Content-Security-Policy" content="frame-src ${frameSrc}">` +
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

  describe.each(CELLS)('$label', ({ mode, framing, label }) => {
    let fromOrigin: Results;
    let fromControl: Results;

    beforeAll(async () => {
      fromOrigin = await runCell(mode, framing, 'origin', label);
      fromControl = await runCell(mode, framing, 'control', label);
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
  });
});
