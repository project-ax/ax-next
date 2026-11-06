// The chat-visual frame runtime. Plain ES2020, no imports: it is inlined as
// source text into the sandboxed srcdoc (see visual-doc.ts), after the
// libraries and before the agent's markup, and called as
// `axVisualRuntime(window, parent)`.
//
// It runs inside the untrusted box and grants nothing: the sandbox and CSP
// are the boundary. It reports size/ready/error to the parent, applies live
// theme changes, exports a PNG, and themes Chart.js.
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
//      parseHTML/parseHTMLUnsafe, XSLTProcessor, document.write/open), and on
//      the getters that would hand a script a child's window.
//   4. A backstop that doesn't depend on that list: window.length counts the
//      child browsing contexts in the document tree. If it's ever above zero
//      after a purge, the runtime removes the whole document (discarding
//      every child), reports an error and stops. It's checked in the
//      observer, every animation frame, and on a slow timer for frames the
//      browser isn't painting.
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

  // An accessor that always answers null, for the getters that hand out a
  // child frame's window or document.
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
  var raf = win.requestAnimationFrame;

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

  // A child frame exists that the layers above didn't stop. Removing the
  // document element discards every child browsing context, wherever it was.
  function kill() {
    if (killed) return;
    killed = true;
    try {
      var rootEl = apply(getDocumentElement, win.document, []);
      if (rootEl) apply(removeEl, rootEl, []);
    } catch {
      // Still report it.
    }
    post({ type: 'ax-visual:error' });
  }

  function check() {
    if (!killed && childCount() > 0) kill();
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
      if (killed) return;
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

  // One property read per frame. rAF stops in a frame that isn't painted
  // (offscreen, hidden tab), so a slow timer backs it up.
  if (typeof raf === 'function') {
    var everyFrame = function () {
      check();
      if (!killed) apply(raf, win, [everyFrame]);
    };
    apply(raf, win, [everyFrame]);
  }
  if (typeof setTimer === 'function') apply(setTimer, win, [check, 250]);

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

  var doc = win.document;
  var root = doc.documentElement;
  var maxHeight = parseInt(root.getAttribute('data-max-height') || '', 10) || 1200;
  var ready = false;
  var errorSent = false;
  var lastHeight = -1;
  var framePending = false;

  function post(msg) {
    try {
      host.postMessage(msg, '*');
    } catch {
      // The parent went away; nothing to tell.
    }
  }

  function nextFrame(fn) {
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(fn);
    else win.setTimeout(fn, 16);
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

  var ax = {
    color: function (name) {
      return 'hsl(' + tokenValue(name) + ')';
    },
    // A Chart.js scriptable option: re-read on every chart update.
    chartColor: function (name) {
      return function () {
        return ax.color(name);
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

  win.addEventListener('load', function () {
    nextFrame(function () {
      nextFrame(function () {
        if (ready || killed) return;
        ready = true;
        var h = measure();
        lastHeight = h;
        var body = doc.body;
        var hasContent = !!body && (body.children.length > 0 || body.textContent.trim() !== '');
        post({ type: 'ax-visual:ready', height: h, rendered: hasContent && h >= 8, locked: locked });
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

  // Canvas can't read CSS variables, so a color the model wrote as
  // `hsl(var(--chart-1))` is resolved on every update instead.
  function themedValue(value, perPoint, datasetIndex) {
    if (value === undefined || value === null) return paletteColor(perPoint, datasetIndex);
    if (hasVar(value)) {
      return function () {
        return ax.resolve(value);
      };
    }
    // An indexable array: Chart.js picks item[index % length].
    if (Array.isArray(value) && value.some(hasVar)) {
      return function (ctx) {
        var i = ctx && typeof ctx.dataIndex === 'number' ? ctx.dataIndex : ctx && ctx.datasetIndex;
        var item = value[(typeof i === 'number' ? i : 0) % value.length];
        return hasVar(item) ? ax.resolve(item) : item;
      };
    }
    return value;
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
          });
        },
      });
    } catch {
      // A broken Chart global shouldn't take the runtime down with it.
    }
  }

  // ---- messages from the parent -------------------------------------------

  function applyTheme(data) {
    var mode = data.mode;
    if (mode !== 'light' && mode !== 'dark') return;
    var tokens = data.tokens;
    if (!tokens || typeof tokens !== 'object') return;
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
        applyChartDefaults();
        var instances = Chart.instances || {};
        Object.keys(instances).forEach(function (key) {
          try {
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
  });
};
