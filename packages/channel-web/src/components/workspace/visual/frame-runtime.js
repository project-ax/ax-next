// The chat-visual frame runtime. Plain ES2020, no imports: it is inlined as
// source text into the sandboxed srcdoc (see visual-doc.ts), after the
// libraries and before the agent's markup, and called as
// `axVisualRuntime(window, parent)`.
//
// It runs inside the untrusted box and grants nothing: the sandbox and CSP
// are the boundary. It reports size/ready/error to the parent, applies live
// theme changes, exports a PNG, and themes Chart.js.
//
// It does add one hardening layer the CSP can't: CSP doesn't govern WebRTC,
// so the runtime pins the WebRTC constructors to undefined. That only holds in
// this realm — a child frame, even a srcdoc one (frame-src 'none' doesn't stop
// those), would get fresh ones. So the frame must never get a child browsing
// context: visual-doc.ts strips frame-making elements from the markup, and
// this runtime removes any that a script inserts later (a MutationObserver
// fires in a microtask, before the async child load can start running) and
// locks the APIs that could hide one from that observer (attachShadow,
// setHTMLUnsafe, parseHTMLUnsafe, document.write/writeln/open).
//
// Residual: this is in-realm hardening, written before agent code runs, not a
// browser boundary. A browser bug that loads a child synchronously, or a new
// API that builds a shadow root or child frame some other way, would get past
// it. A declarative shadow root the parser builds from the markup is invisible
// to the observer, so stripChildFrames() in visual-doc.ts is the only layer
// against those. If any lock can't be installed, `ready` says `locked: false`.
//
// The token allow-list and value pattern restate VISUAL_TOKEN_NAMES and
// VISUAL_TOKEN_VALUE from visual-doc.ts (this file can't import them); a test
// keeps the two in sync.
window.axVisualRuntime = function axVisualRuntime(win, host) {
  'use strict';

  var locked = true;

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

  function refuse() {
    throw new TypeError('Not available in a chat visual.');
  }

  [
    'RTCPeerConnection',
    'webkitRTCPeerConnection',
    'RTCDataChannel',
    'RTCSessionDescription',
    'RTCIceCandidate',
  ].forEach(function (name) {
    lock(win, name, undefined);
  });

  var elementProto = win.Element && win.Element.prototype;
  lock(elementProto, 'attachShadow', refuse);
  lock(elementProto, 'setHTMLUnsafe', refuse);
  if (win.ShadowRoot) lock(win.ShadowRoot.prototype, 'setHTMLUnsafe', refuse);
  if (win.Document) {
    lock(win.Document, 'parseHTMLUnsafe', refuse);
    lock(win.Document.prototype, 'write', refuse);
    lock(win.Document.prototype, 'writeln', refuse);
    lock(win.Document.prototype, 'open', refuse);
  }

  // Remove child-frame elements the moment they're inserted. The observer
  // only uses methods captured here, so agent code that later patches
  // Element.prototype.remove (or NodeList, or MutationRecord) can't blind it.
  var CHILD_FRAMES = 'iframe,frame,frameset,object,embed,portal,fencedframe';
  var apply = Reflect.apply;
  function getter(proto, name) {
    var d = proto && Object.getOwnPropertyDescriptor(proto, name);
    return d && d.get;
  }
  var nodeProto = win.Node && win.Node.prototype;
  var getNodeType = getter(nodeProto, 'nodeType');
  var getAddedNodes = getter(win.MutationRecord && win.MutationRecord.prototype, 'addedNodes');
  var getListLength = getter(win.NodeList && win.NodeList.prototype, 'length');
  var listItem = win.NodeList && win.NodeList.prototype.item;
  var matches = elementProto && elementProto.matches;
  var queryAll = elementProto && elementProto.querySelectorAll;
  var removeEl = elementProto && elementProto.remove;

  function purge(node) {
    if (apply(getNodeType, node, []) !== 1) return;
    if (apply(matches, node, [CHILD_FRAMES])) {
      apply(removeEl, node, []);
      return;
    }
    var found = apply(queryAll, node, [CHILD_FRAMES]);
    var n = apply(getListLength, found, []);
    for (var i = 0; i < n; i++) apply(removeEl, apply(listItem, found, [i]), []);
  }

  try {
    if (!getNodeType || !getAddedNodes || !getListLength || !listItem || !matches || !queryAll || !removeEl) {
      throw new Error('missing DOM primitives');
    }
    new win.MutationObserver(function (records) {
      for (var r = 0; r < records.length; r++) {
        var added = apply(getAddedNodes, records[r], []);
        var count = apply(getListLength, added, []);
        for (var a = 0; a < count; a++) purge(apply(listItem, added, [a]));
      }
    }).observe(win.document, { childList: true, subtree: true });
  } catch {
    locked = false;
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
        if (ready) return;
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
    if (event.source !== host) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'ax-visual:theme') applyTheme(data);
    else if (data.type === 'ax-visual:export') exportImage(data);
  });
};
