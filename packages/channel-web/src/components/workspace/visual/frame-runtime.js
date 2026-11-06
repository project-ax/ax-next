// The chat-visual frame runtime. Plain ES2020, no imports: it is inlined as
// source text into the sandboxed srcdoc (see visual-doc.ts), after the
// libraries and before the agent's markup, and called as
// `axVisualRuntime(window, parent)`.
//
// It runs inside the untrusted box and grants nothing, so it is not a security
// boundary — the sandbox and CSP are. It reports size/ready/error to the
// parent, applies live theme changes, exports a PNG, and themes Chart.js.
//
// The token allow-list and value pattern restate VISUAL_TOKEN_NAMES and
// VISUAL_TOKEN_VALUE from visual-doc.ts (this file can't import them); a test
// keeps the two in sync.
window.axVisualRuntime = function axVisualRuntime(win, host) {
  'use strict';

  // CSP doesn't govern WebRTC, so a peer connection could still reach the
  // network from inside the frame. Pin the constructors to undefined before
  // any agent script runs: non-writable and non-configurable, so they can't be
  // put back. A nested frame (a fresh realm) is blocked by frame-src 'none'.
  [
    'RTCPeerConnection',
    'webkitRTCPeerConnection',
    'RTCDataChannel',
    'RTCSessionDescription',
    'RTCIceCandidate',
  ].forEach(function (name) {
    try {
      Object.defineProperty(win, name, {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      // Already locked (or not ours to redefine); nothing more we can do.
    }
  });

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
        post({ type: 'ax-visual:ready', height: h, rendered: hasContent && h >= 8 });
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
