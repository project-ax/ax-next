// The chat-visual frame runtime. Plain ES2020, no imports: it is inlined as
// source text into the sandboxed srcdoc (see visual-doc.ts), after the
// libraries and before the agent's markup, and called as
// `axVisualRuntime(window, parent)`.
//
// It runs inside the untrusted box and grants nothing: the sandbox and CSP
// are the boundary. It reports size/ready/error to the parent, applies live
// theme changes, exports a PNG, themes Chart.js, and keeps charts fitted to
// their containers.
//
// Messages it takes, only from the parent window (`event.source === host`):
//   { type: 'ax-visual:theme', mode: 'light'|'dark', tokens }  live theme
//   { type: 'ax-visual:export', requestId, format: 'png' }      PNG snapshot
//   { type: 'ax-visual:visible' }                               card came into view: refit charts
//
// It also adds hardening the CSP can't. CSP doesn't govern WebRTC, so the
// runtime pins the WebRTC constructors to undefined. That only holds in this
// realm: a child frame, even a srcdoc one (frame-src 'none' doesn't stop
// those), gets fresh ones. So the frame must never get a child browsing
// context. Four layers, in order:
//   1. visual-doc.ts strips frame-making elements and declarative shadow
//      roots from the markup.
//   2. A MutationObserver removes frame-making elements a script inserts, and
//      any element that carries an open shadow root (visuals have no use for
//      shadow DOM; the observer can't see inside one). It runs in a
//      microtask, before an async child load can start running.
//   3. Locks on the APIs that build shadow roots or parse markup outside the
//      observer's sight (attachShadow, setHTML/setHTMLUnsafe,
//      parseHTML/parseHTMLUnsafe, XSLTProcessor, document.write/open). The
//      contentWindow/contentDocument/getSVGDocument getters answer null, but
//      that's defense in depth only: window[n] and frames[n] can't be
//      locked. What actually keeps a script out of a child is that every
//      sandboxed document gets its own opaque origin, so touching a child's
//      window throws SecurityError (verified in Chromium, Firefox, WebKit).
//   4. A backstop that doesn't depend on that list: window.length counts the
//      child browsing contexts in the document tree. If it's ever above zero
//      after a purge, the runtime removes the whole document (discarding
//      every child) and reports `ax-visual:error`; the parent unmounts the
//      frame on any error. It's checked in the observer, every animation
//      frame, and on a timer for frames the browser isn't painting.
//      After a kill only the reporting stops (ready, size, theme, export):
//      the observer, the checks and the locks keep running, and any new
//      document element is removed too.
//
// Residual, measured in Chromium, Firefox and WebKit:
// - Layer 4 is blind to a child inside a shadow root: window.length only
//   counts document-tree children. So a closed shadow root from some API not
//   locked in layer 3 would get a live child past everything here. We know of
//   no unlocked route to one; setHTML/parseHTML did ship and are locked now.
// - Layer 4 tears a child down; it doesn't prevent it. A child it catches has
//   usually already run its first script by the next frame.
// - CSP's `webrtc 'block'` would cover children too, but no engine honors it.
// This is in-realm hardening, installed before agent code runs, not a browser
// boundary. `ready.locked` is advisory: it means every lock above was
// installed. It never proves a child frame is impossible, and the parent must
// not make a security decision on it.
//
// The token allow-list and value pattern restate VISUAL_TOKEN_NAMES and
// VISUAL_TOKEN_VALUE from visual-doc.ts (this file can't import them); a test
// keeps the two in sync.
window.axVisualRuntime = function axVisualRuntime(win, host) {
  'use strict';

  var locked = true;
  var killed = false;

  // Non-writable and non-configurable, so agent code can't put the original
  // back. A failure is recorded, never swallowed: the parent hears about it.
  function lock(target, name, value) {
    if (!target) return;
    try {
      Object.defineProperty(target, name, {
        value: value,
        writable: false,
        configurable: false,
        enumerable: false,
      });
      if (target[name] !== value) locked = false;
    } catch {
      locked = false;
    }
  }

  function noWindow() {
    return null;
  }

  // An accessor that always answers null, for the contentWindow-style getters.
  // Defense in depth only (window[n] can't be locked); the opaque origin is
  // what keeps a child's window out of reach.
  function lockGetter(target, name) {
    if (!target) return;
    try {
      Object.defineProperty(target, name, {
        get: noWindow,
        set: undefined,
        enumerable: true,
        configurable: false,
      });
      var d = Object.getOwnPropertyDescriptor(target, name);
      if (!d || d.get !== noWindow) locked = false;
    } catch {
      locked = false;
    }
  }

  function refuse() {
    throw new TypeError('Not available in a chat visual.');
  }

  function proto(name) {
    var ctor = win[name];
    return ctor && ctor.prototype;
  }

  [
    'RTCPeerConnection',
    'webkitRTCPeerConnection',
    'RTCDataChannel',
    'RTCSessionDescription',
    'RTCIceCandidate',
    'XSLTProcessor',
  ].forEach(function (name) {
    lock(win, name, undefined);
  });

  var elementProto = proto('Element');
  lock(elementProto, 'attachShadow', refuse);
  lock(elementProto, 'setHTML', refuse);
  lock(elementProto, 'setHTMLUnsafe', refuse);
  lock(proto('ShadowRoot'), 'setHTML', refuse);
  lock(proto('ShadowRoot'), 'setHTMLUnsafe', refuse);
  lock(win.Document, 'parseHTML', refuse);
  lock(win.Document, 'parseHTMLUnsafe', refuse);
  var documentProto = proto('Document');
  lock(documentProto, 'parseHTML', refuse);
  lock(documentProto, 'write', refuse);
  lock(documentProto, 'writeln', refuse);
  lock(documentProto, 'open', refuse);

  ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement'].forEach(function (name) {
    lockGetter(proto(name), 'contentWindow');
    lockGetter(proto(name), 'contentDocument');
  });
  lock(proto('HTMLObjectElement'), 'getSVGDocument', noWindow);
  lock(proto('HTMLEmbedElement'), 'getSVGDocument', noWindow);

  // Everything below uses methods captured here, so agent code that later
  // patches Element.prototype.remove (or NodeList, MutationRecord,
  // window.length) can't blind it.
  var CHILD_FRAMES = 'iframe,frame,frameset,object,embed,portal,fencedframe';
  var apply = Reflect.apply;
  function getter(target, name) {
    var d = target && Object.getOwnPropertyDescriptor(target, name);
    return d && d.get;
  }
  var nodeProto = proto('Node');
  var getNodeType = getter(nodeProto, 'nodeType');
  var getAddedNodes = getter(proto('MutationRecord'), 'addedNodes');
  var getListLength = getter(proto('NodeList'), 'length');
  var listItem = proto('NodeList') && proto('NodeList').item;
  var getShadowRoot = getter(elementProto, 'shadowRoot');
  var getDocumentElement = getter(documentProto, 'documentElement');
  var getChildCount = getter(win, 'length') || getter(proto('Window'), 'length');
  var matches = elementProto && elementProto.matches;
  var queryAll = elementProto && elementProto.querySelectorAll;
  var removeEl = elementProto && elementProto.remove;
  var setTimer = win.setInterval;
  var setTimeoutFn = win.setTimeout;
  var raf = win.requestAnimationFrame;

  // No self-navigation. The app's frame-src 'none' refuses any navigation of
  // this frame, and Chrome then shows its own error page in the card. Links
  // are ordinary agent output, so a click on one (and a form submit) does
  // nothing instead. The listeners go on the window in the capture phase,
  // before any agent code: they run first, agent code never sees the handler
  // to remove it, and every call goes through primitives captured here.
  // Script navigation (location.href, meta refresh) can't be stopped from in
  // here; the parent treats a second load of the iframe as a failure.
  var LINKS = 'a[href],area[href],a[*|href]';
  var eventProto = proto('Event');
  var addListener = proto('EventTarget') && proto('EventTarget').addEventListener;
  var preventDefault = eventProto && eventProto.preventDefault;
  var getTarget = getter(eventProto, 'target');
  var getParentNode = getter(nodeProto, 'parentNode');
  var closest = elementProto && elementProto.closest;
  function onLinkClick(event) {
    try {
      var node = apply(getTarget, event, []);
      while (node && apply(getNodeType, node, []) !== 1) node = apply(getParentNode, node, []);
      if (node && apply(closest, node, [LINKS])) apply(preventDefault, event, []);
    } catch {
      // Not a link we can see: the parent's second-load check still catches a navigation.
    }
  }
  function onSubmit(event) {
    try {
      apply(preventDefault, event, []);
    } catch {
      // The frame CSP refuses form actions anyway.
    }
  }
  try {
    apply(addListener, win, ['click', onLinkClick, true]);
    apply(addListener, win, ['auxclick', onLinkClick, true]);
    apply(addListener, win, ['submit', onSubmit, true]);
  } catch {
    // As above: the parent's second-load check is the backstop.
  }

  // Frame-making elements go, and so does any element hosting an open shadow
  // root (the observer can't see inside it).
  function forbidden(el) {
    return apply(matches, el, [CHILD_FRAMES]) || apply(getShadowRoot, el, []) !== null;
  }

  function purge(node) {
    if (apply(getNodeType, node, []) !== 1) return;
    if (forbidden(node)) {
      apply(removeEl, node, []);
      return;
    }
    var all = apply(queryAll, node, ['*']);
    var n = apply(getListLength, all, []);
    for (var i = 0; i < n; i++) {
      var el = apply(listItem, all, [i]);
      if (forbidden(el)) apply(removeEl, el, []);
    }
  }

  function childCount() {
    return getChildCount ? apply(getChildCount, win, []) : win.length;
  }

  // Removing the document element discards every child browsing context in
  // the document tree, wherever it was.
  function removeRoot() {
    try {
      var rootEl = apply(getDocumentElement, win.document, []);
      if (rootEl) apply(removeEl, rootEl, []);
    } catch {
      // Keep going: the caller still reports, and the next check tries again.
    }
  }

  // A child frame exists that the layers above didn't stop. Only reporting
  // stops after this; every guard keeps running.
  function kill() {
    removeRoot();
    if (killed) return;
    killed = true;
    post({ type: 'ax-visual:error' });
  }

  // Once killed, the frame stays empty: agent timers still run in this realm
  // and could rebuild the page, so any new root goes too.
  function check() {
    if (killed || childCount() > 0) kill();
  }

  try {
    if (
      !getNodeType ||
      !getAddedNodes ||
      !getListLength ||
      !listItem ||
      !getShadowRoot ||
      !getDocumentElement ||
      !getChildCount ||
      !matches ||
      !queryAll ||
      !removeEl
    ) {
      locked = false;
    }
    new win.MutationObserver(function (records) {
      try {
        for (var r = 0; r < records.length; r++) {
          var added = apply(getAddedNodes, records[r], []);
          var count = apply(getListLength, added, []);
          for (var a = 0; a < count; a++) purge(apply(listItem, added, [a]));
        }
      } finally {
        check();
      }
    }).observe(win.document, { childList: true, subtree: true });
  } catch {
    locked = false;
  }

  // One property read per frame, for the life of the frame (a kill doesn't
  // stop it). rAF stops in a frame that isn't painted (offscreen, hidden tab),
  // so a timer backs it up: every 250 ms until ready, then every second.
  if (typeof raf === 'function') {
    var everyFrame = function () {
      check();
      apply(raf, win, [everyFrame]);
    };
    apply(raf, win, [everyFrame]);
  }
  var clearTimer = win.clearInterval;
  // The timer also refits charts once ready (see fitCharts). The child check
  // always runs first, and fitCharts catches its own errors.
  function tick() {
    check();
    if (ready && !killed) fitCharts();
  }
  var timer = typeof setTimer === 'function' ? apply(setTimer, win, [tick, 250]) : undefined;
  function slowTimer() {
    if (timer === undefined || typeof clearTimer !== 'function') return;
    apply(clearTimer, win, [timer]);
    timer = apply(setTimer, win, [tick, 1000]);
  }

  var TOKEN_NAMES = [
    '--background',
    '--foreground',
    '--card',
    '--card-foreground',
    '--popover',
    '--popover-foreground',
    '--muted',
    '--muted-foreground',
    '--border',
    '--primary',
    '--primary-foreground',
    '--accent',
    '--accent-foreground',
    '--destructive',
    '--warning',
    '--ring',
    '--radius',
    '--chart-1',
    '--chart-2',
    '--chart-3',
    '--chart-4',
    '--chart-5',
  ];
  var TOKEN_VALUE = /^(?:\d+(?:\.\d+)?(?:deg)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%|\d+(?:\.\d+)?(?:rem|px))$/;
  var FONT_FAMILY = 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
  var PER_POINT_TYPES = { pie: true, doughnut: true, polarArea: true };
  var FRAME_FALLBACK_MS = 100;
  // Body children that draw nothing: a body holding only these rendered nothing.
  var NON_RENDERING = { SCRIPT: true, STYLE: true, TEMPLATE: true, NOSCRIPT: true, LINK: true, META: true };

  var doc = win.document;
  var root = doc.documentElement;
  var maxHeight = parseInt(root.getAttribute('data-max-height') || '', 10) || 1200;
  var ready = false;
  var errorSent = false;
  var lastHeight = -1;
  var framePending = false;

  function post(msg) {
    try {
      // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- the frame (opaque origin) can't name the app's origin; the parent accepts only messages whose source is this frame and origin is 'null', and payloads are sizes/flags/a PNG of the frame's own content
      host.postMessage(msg, '*');
    } catch {
      // The parent went away; nothing to tell.
    }
  }

  // The next frame, or FRAME_FALLBACK_MS, whichever comes first. rAF never
  // runs in a frame the browser isn't painting (scrolled offscreen, hidden
  // tab), and a visual has to say ready and report its size there too.
  // measure() forces layout, so a height read from the timer is still right.
  function nextFrame(fn) {
    var done = false;
    function once() {
      if (done) return;
      done = true;
      fn();
    }
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(once);
    if (typeof setTimeoutFn === 'function') apply(setTimeoutFn, win, [once, FRAME_FALLBACK_MS]);
  }

  // Only a broken render matters, and only until it's shown. The error text
  // stays in here: it's the agent's, and the parent has no use for it.
  function onError() {
    if (ready || errorSent) return;
    errorSent = true;
    post({ type: 'ax-visual:error' });
  }
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onError);

  // ---- theme helpers ------------------------------------------------------

  function tokenValue(name) {
    var prop = name.indexOf('--') === 0 ? name : '--' + name;
    return win.getComputedStyle(root).getPropertyValue(prop).trim();
  }

  // A finite number clamped to [0, 1], or undefined for anything else.
  function alphaOf(alpha) {
    if (typeof alpha !== 'number' || !isFinite(alpha)) return undefined;
    return Math.min(1, Math.max(0, alpha));
  }

  // Every color string ax.color has handed out, and what it was made from.
  // Agents often read a color once and write the string into chart options;
  // on a theme change those strings are swapped for the new theme's (see
  // healChart). Capped so a data-driven alpha can't grow it without bound.
  var issued = new Map();
  var ISSUED_MAX = 512;
  function remember(value, name, alpha) {
    if (issued.size >= ISSUED_MAX && !issued.has(value)) return;
    issued.set(value, { name: name, alpha: alpha });
  }

  var ax = {
    color: function (name, alpha) {
      var a = alphaOf(alpha);
      var token = tokenValue(name);
      var value = a === undefined ? 'hsl(' + token + ')' : 'hsl(' + token + ' / ' + a + ')';
      if (token) remember(value, name, a);
      return value;
    },
    // A Chart.js scriptable option: re-read on every chart update.
    chartColor: function (name, alpha) {
      return function () {
        return ax.color(name, alpha);
      };
    },
    resolve: function (css) {
      return String(css).replace(
        /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([^()]*))?\)/g,
        function (match, name, fallback) {
          var value = tokenValue(name);
          if (value) return value;
          return fallback !== undefined ? fallback.trim() : match;
        },
      );
    },
  };
  win.ax = ax;

  // ---- size ---------------------------------------------------------------

  function measure() {
    var h = Math.ceil(root.scrollHeight);
    root.style.overflowY = h > maxHeight ? 'auto' : '';
    return h;
  }

  function reportSize() {
    if (killed) return;
    var h = measure();
    if (h === lastHeight) return;
    lastHeight = h;
    post({ type: 'ax-visual:size', height: h });
  }

  function scheduleSize() {
    if (framePending) return;
    framePending = true;
    nextFrame(function () {
      framePending = false;
      reportSize();
    });
  }

  if (typeof win.ResizeObserver === 'function') {
    try {
      var observer = new win.ResizeObserver(scheduleSize);
      observer.observe(root);
      // We run in <head>, so <body> doesn't exist yet.
      doc.addEventListener('DOMContentLoaded', function () {
        if (doc.body) observer.observe(doc.body);
      });
    } catch {
      // No observer: ready still reports one height.
    }
  }

  // Something a person can see: an element that draws, or non-blank text.
  // Script and style text don't count, and neither does the body's padding.
  function hasContent(body) {
    if (!body) return false;
    var nodes = body.childNodes;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.nodeType === 1 && !NON_RENDERING[String(node.nodeName).toUpperCase()]) return true;
      if (node.nodeType === 3 && node.nodeValue.trim() !== '') return true;
    }
    return false;
  }

  win.addEventListener('load', function () {
    nextFrame(function () {
      nextFrame(function () {
        // From the timer this can beat the per-frame check: run it first, so
        // a frame with a child says error, never ready.
        check();
        if (ready || killed) return;
        ready = true;
        slowTimer();
        var h = measure();
        lastHeight = h;
        post({ type: 'ax-visual:ready', height: h, rendered: hasContent(doc.body) && h >= 8, locked: locked });
        fitCharts();
      });
    });
  });

  // ---- Chart.js -----------------------------------------------------------

  function applyChartDefaults() {
    var Chart = win.Chart;
    if (!Chart || !Chart.defaults) return;
    var d = Chart.defaults;
    if (!d.font) d.font = {};
    d.font.family = FONT_FAMILY;
    d.font.size = 12;
    d.color = ax.color('muted-foreground');
    d.borderColor = ax.color('border');
    var tooltip = d.plugins && d.plugins.tooltip;
    if (tooltip) {
      tooltip.backgroundColor = ax.color('popover');
      tooltip.titleColor = ax.color('popover-foreground');
      tooltip.bodyColor = ax.color('popover-foreground');
      tooltip.footerColor = ax.color('popover-foreground');
      tooltip.borderColor = ax.color('border');
      tooltip.borderWidth = 1;
    }
  }

  function paletteColor(perPoint, fallbackIndex) {
    return function (ctx) {
      var i = perPoint ? ctx && ctx.dataIndex : ctx && ctx.datasetIndex;
      if (typeof i !== 'number') i = fallbackIndex;
      return ax.color('chart-' + ((i % 5) + 1));
    };
  }

  function hasVar(value) {
    return typeof value === 'string' && value.indexOf('var(--') !== -1;
  }

  // One entry of a per-point color array, as Chart.js would want it resolved.
  function resolveEntry(item, ctx) {
    if (typeof item === 'function') item = item(ctx);
    if (hasVar(item)) return ax.resolve(item);
    var known = typeof item === 'string' && issued.get(item);
    return known ? ax.color(known.name, known.alpha) : item;
  }

  // Canvas can't read CSS variables, so a color the model wrote as
  // `hsl(var(--chart-1))` is resolved on every update instead.
  function themedValue(value, perPoint, datasetIndex, noPalette) {
    if (value === undefined || value === null) return noPalette ? value : paletteColor(perPoint, datasetIndex);
    if (hasVar(value)) {
      return function () {
        return ax.resolve(value);
      };
    }
    // An indexable array: Chart.js picks item[index % length], but it only
    // calls a scriptable function when it's the whole value, never an entry.
    // So an array holding ax.chartColor(...) or var() entries becomes one
    // function that resolves the entry itself. The result is a function, so a
    // later update leaves it alone.
    if (Array.isArray(value) && value.some(function (item) { return typeof item === 'function' || hasVar(item); })) {
      return function (ctx) {
        var i = ctx && typeof ctx.index === 'number' ? ctx.index : ctx && ctx.dataIndex;
        if (typeof i !== 'number') i = ctx && ctx.datasetIndex;
        return resolveEntry(value[(typeof i === 'number' ? i : 0) % value.length], ctx);
      };
    }
    return value;
  }

  // Colors that only get resolved, never filled from the palette.
  var EXTRA_COLOR_KEYS = ['hoverBackgroundColor', 'hoverBorderColor', 'pointBackgroundColor', 'pointBorderColor'];

  // An hsl() color: space or comma separated, optional alpha after / or a
  // comma, spacing loose. Group 1-3 are the triplet, group 4 the alpha.
  var HSL_COLOR =
    /^\s*hsl\(\s*([0-9.]+(?:deg)?)\s*[\s,]\s*([0-9.]+%)\s*[\s,]\s*([0-9.]+%)\s*(?:[,/]\s*([0-9.]+%?)\s*)?\)\s*$/;
  var HSL_TRIPLET = /^\S+\s+\S+%\s+\S+%$/;

  // Old token triplet -> the token it most likely came from, for a theme
  // change. A model that reads a token with getComputedStyle and wraps it in
  // hsl() writes exactly that triplet, and an exact match on one is almost
  // never a coincidence. When tokens shared an old value, prefer the token
  // whose NEW value the most of them share (so the answer is the same
  // whichever one the agent meant); on a tie, the earliest in TOKEN_NAMES.
  function tokensByOldValue(oldValues) {
    var groups = new Map();
    TOKEN_NAMES.forEach(function (name, i) {
      var old = oldValues[i].split(/\s+/).join(' ');
      if (!HSL_TRIPLET.test(old)) return;
      if (!groups.has(old)) groups.set(old, []);
      groups.get(old).push(name);
    });
    var byOld = new Map();
    groups.forEach(function (names, old) {
      var best = null;
      var bestCount = 0;
      names.forEach(function (name) {
        var fresh = tokenValue(name);
        var count = names.filter(function (other) {
          return tokenValue(other) === fresh;
        }).length;
        if (count > bestCount) {
          best = name;
          bestCount = count;
        }
      });
      if (best) byOld.set(old, best);
    });
    return byOld;
  }

  // The current-theme version of a color string from the old theme, or
  // undefined to leave it alone. ax.color's own strings first, then an
  // hsl() whose triplet was an old token value. Anything else is the
  // agent's own color.
  function freshColor(value, byOld) {
    var known = issued.get(value);
    if (known) return ax.color(known.name, known.alpha);
    if (!byOld || !byOld.size) return undefined;
    var m = HSL_COLOR.exec(value);
    if (!m) return undefined;
    var name = byOld.get(m[1] + ' ' + m[2] + ' ' + m[3]);
    if (!name) return undefined;
    var token = tokenValue(name);
    if (!token) return undefined;
    return m[4] === undefined ? 'hsl(' + token + ')' : 'hsl(' + token + ' / ' + m[4] + ')';
  }

  // A color string ax.color handed out under the old theme, swapped for the
  // same token's current value. Walks plain objects and arrays only, to a
  // fixed depth and node budget, so a huge or cyclic options tree stays cheap.
  // `skip` names one key to leave out (a dataset's data points).
  function healColors(node, depth, budget, byOld, skip) {
    if (depth > 8 || budget.left <= 0 || !node || typeof node !== 'object') return;
    var isArray = Array.isArray(node);
    if (!isArray) {
      // A plain object from any realm: its prototype is null or a root one.
      // Class instances (a chart, a DOM node) are left alone.
      var p = Object.getPrototypeOf(node);
      if (p !== null && Object.getPrototypeOf(p) !== null) return;
    }
    var keys = isArray ? null : Object.keys(node);
    var n = isArray ? node.length : keys.length;
    for (var i = 0; i < n && budget.left > 0; i++) {
      budget.left--;
      var key = isArray ? i : keys[i];
      if (key === skip) continue;
      var value;
      try {
        value = node[key];
      } catch {
        continue;
      }
      if (typeof value === 'string') {
        var fresh = freshColor(value, byOld);
        if (fresh === undefined || fresh === value) continue;
        try {
          node[key] = fresh;
        } catch {
          // A frozen object keeps its color.
        }
      } else if (value && typeof value === 'object') {
        healColors(value, depth + 1, budget, byOld);
      }
    }
  }

  function healChart(chart, byOld) {
    if (!issued.size && !byOld.size) return;
    var budget = { left: 5000 };
    // config.options is what the agent wrote; chart.options is a resolver over
    // it and every default.
    healColors(chart.config && chart.config.options ? chart.config.options : chart.options, 0, budget, byOld);
    var datasets = chart.data && chart.data.datasets;
    if (!Array.isArray(datasets)) return;
    datasets.forEach(function (ds) {
      healColors(ds, 1, budget, byOld, 'data');
    });
  }

  if (win.Chart) {
    try {
      applyChartDefaults();
      win.Chart.register({
        id: 'axTheme',
        beforeUpdate: function (chart) {
          var datasets = chart && chart.data && chart.data.datasets;
          if (!Array.isArray(datasets)) return;
          var chartType = chart.config && chart.config.type;
          datasets.forEach(function (ds, di) {
            if (!ds || typeof ds !== 'object') return;
            var perPoint = !!PER_POINT_TYPES[ds.type || chartType];
            ds.backgroundColor = themedValue(ds.backgroundColor, perPoint, di);
            ds.borderColor = themedValue(ds.borderColor, perPoint, di);
            EXTRA_COLOR_KEYS.forEach(function (key) {
              if (ds[key] !== undefined) ds[key] = themedValue(ds[key], perPoint, di, true);
            });
          });
        },
      });
    } catch {
      // A broken Chart global shouldn't take the runtime down with it.
    }
  }

  // Chrome can run this frame in its own process, and the document may parse
  // before the frame's size arrives: a chart built then measures a 0x0 page.
  // Chart.js would catch up through ResizeObserver plus requestAnimationFrame,
  // and neither runs in a frame the browser isn't painting (offscreen, hidden
  // tab), so the chart can stay blank. This refits from the timer, on ready,
  // and when the parent says the card came into view: a responsive chart
  // more than a pixel off the width Chart.js itself would give it (or 0 wide,
  // if that can't be measured) is refit. Cheap when nothing is wrong; every
  // step, the walk over Chart.instances included, is inside a try.
  function fitCharts() {
    try {
      var instances = win.Chart && win.Chart.instances;
      if (!instances || typeof instances !== 'object') return;
      var keys = Object.keys(instances);
      for (var i = 0; i < keys.length; i++) {
        try {
          fitChart(instances[keys[i]]);
        } catch {
          // One broken chart shouldn't stop the rest.
        }
      }
    } catch {
      // A hostile Chart global: nothing to fit.
    }
  }

  function fitChart(chart) {
    if (!chart || (chart.options && chart.options.responsive === false)) return;
    // Measured the way Chart.js measures, so a canvas it legitimately keeps
    // narrower than its box (max-width, margin, padding, border) isn't
    // "wrong". If that can't be measured, only a 0-wide chart is refit.
    var target;
    try {
      var size = chart.platform.getMaximumSize(chart.canvas);
      target = size && size.width;
    } catch {
      target = undefined;
    }
    if (typeof target === 'number' && isFinite(target)) {
      if (Math.abs(target - chart.width) <= 1) return;
    } else if (chart.width !== 0) {
      return;
    }
    // While an animation is running, resize() only queues the new size for
    // the next draw, and in an unpainted frame the intro animation never
    // finishes (it runs on requestAnimationFrame). Stopping it first makes
    // the resize and redraw happen now. Only here, where the size really
    // changes: stop() freezes any animation in flight.
    if (typeof chart.stop === 'function') chart.stop();
    chart.resize();
  }


  // ---- messages from the parent -------------------------------------------

  function applyTheme(data) {
    var mode = data.mode;
    if (mode !== 'light' && mode !== 'dark') return;
    var tokens = data.tokens;
    if (!tokens || typeof tokens !== 'object') return;
    var oldValues = TOKEN_NAMES.map(tokenValue);
    TOKEN_NAMES.forEach(function (name) {
      if (!Object.prototype.hasOwnProperty.call(tokens, name)) return;
      var raw = tokens[name];
      if (typeof raw !== 'string') return;
      var value = raw.trim();
      if (TOKEN_VALUE.test(value)) root.style.setProperty(name, value);
    });
    root.style.colorScheme = mode;
    root.dataset.theme = mode;

    var Chart = win.Chart;
    if (Chart) {
      try {
        var byOld = tokensByOldValue(oldValues);
        applyChartDefaults();
        var instances = Chart.instances || {};
        Object.keys(instances).forEach(function (key) {
          try {
            healChart(instances[key], byOld);
            instances[key].update('none');
          } catch {
            // One broken chart shouldn't stop the rest from re-theming.
          }
        });
      } catch {
        // As above.
      }
    }
    win.dispatchEvent(new win.Event('ax:theme'));
  }

  function exportImage(data) {
    var requestId = data.requestId;
    if (typeof requestId !== 'string') return;
    function fail() {
      post({ type: 'ax-visual:export-result', requestId: requestId, ok: false });
    }
    var helper = win.htmlToImage;
    if (data.format !== 'png' || !helper || typeof helper.toBlob !== 'function') {
      fail();
      return;
    }
    var fonts = doc.getElementById('ax-fonts');
    Promise.resolve()
      .then(function () {
        return helper.toBlob(doc.body, {
          pixelRatio: 2,
          // CSP blocks html-to-image's own font fetch; hand it our @font-face.
          fontEmbedCSS: fonts ? fonts.textContent || '' : '',
          backgroundColor: ax.color('card'),
        });
      })
      .then(function (blob) {
        if (!blob) {
          fail();
          return;
        }
        post({ type: 'ax-visual:export-result', requestId: requestId, ok: true, blob: blob });
      }, fail);
  }

  win.addEventListener('message', function (event) {
    if (killed || event.source !== host) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'ax-visual:theme') applyTheme(data);
    else if (data.type === 'ax-visual:export') exportImage(data);
    else if (data.type === 'ax-visual:visible') fitCharts();
  });
};
