// The shared in-page guard for agent-authored HTML that runs in a sandboxed
// frame. Plain ES2020, no imports: it is inlined as source text into a
// <script> element that comes before any agent markup, then called as
// `axFrameGuard(window, opts)`. Because it sits inside a <script> element it
// must never contain a script-closing tag or an HTML comment opener; a test
// keeps it that way.
//
// It runs inside the untrusted box and grants nothing: the sandbox and CSP
// are the boundary. What it adds is hardening the CSP can't. CSP doesn't
// govern WebRTC, so the guard pins the WebRTC constructors to undefined. That
// only holds in this realm: a child frame, even a srcdoc one (frame-src
// 'none' doesn't stop those), gets fresh ones. So the frame must never get a
// child browsing context. Four layers, in order:
//   1. The consumer strips frame-making elements and declarative shadow roots
//      from the markup before the browser parses it. That isn't this file's
//      job: each consumer has its own parser. CHILD_FRAME_TAGS and DSD_ATTRS
//      (index.ts) are the lists they strip.
//   2. A MutationObserver removes frame-making elements a script inserts, and
//      any element that carries an open shadow root (frames of this kind have
//      no use for shadow DOM; the observer can't see inside one). It runs in a
//      microtask, before an async child load can start running.
//   3. Locks on the APIs that build shadow roots or parse markup, so a
//      frame can't be made where the observer and window.length can't see
//      (attachShadow, setHTML/setHTMLUnsafe, parseHTML/parseHTMLUnsafe,
//      XSLTProcessor, document.write/open). Not every lock covers a route the
//      observer is blind to on its own: measured in Chromium, a plain iframe
//      written with document.write is seen and purged anyway. What only the
//      document.write lock stops is the streaming parser building a CLOSED
//      declarative shadow root at run time, and that frame is invisible to
//      both the observer and window.length. The contentWindow,
//      contentDocument and getSVGDocument getters also answer null, but
//      that's defense in depth only: window[n] and frames[n] can't be
//      locked. What actually keeps a script out of a child is that every
//      sandboxed document gets its own opaque origin, so touching a child's
//      window throws SecurityError (verified in Chromium, Firefox, WebKit).
//   4. A backstop that doesn't depend on that list: window.length counts the
//      child browsing contexts in the document tree. If it's ever above zero
//      after a purge, the guard removes the whole document (discarding every
//      child) and calls opts.onKill. It's checked in the observer, every
//      animation frame, and on a timer for frames the browser isn't painting.
//      After a kill the observer, the checks and the locks keep running, and
//      any new document element is removed too. What the consumer does about
//      the kill (the chat visual stops reporting and tells its parent) is its
//      own business.
//
// Residual, measured in Chromium, Firefox and WebKit:
// - Layer 4 is blind to a child inside a shadow root: window.length only
//   counts document-tree children. So a closed shadow root from some API not
//   locked in layer 3 would get a live child past everything here. We know of
//   no unlocked route to one; setHTML/parseHTML did ship and are locked now.
//   A closed declarative shadow root in the parsed markup is the other way in,
//   which is why layer 1 matters and can't be skipped.
// - Layer 4 tears a child down; it doesn't prevent it. A child it catches has
//   usually already run its first script by the next frame.
// - CSP's `webrtc 'block'` would cover children too, but no engine honors it.
// This is in-realm hardening, installed before agent code runs, not a browser
// boundary. isLocked() is advisory: it means every lock above was installed.
// It never proves a child frame is impossible, and nobody should make a
// security decision on it.
//
//   var guard = axFrameGuard(window, { onKill, onTick, refusalMessage });
//
//   opts.onKill()          Called once, after the document is torn down the
//                          first time a child frame is found. A throw is
//                          swallowed: the guard has to keep running.
//   opts.onTick()          Called on every timer check, after the child check
//                          (see slowTimer). A throw is the caller's to handle.
//   opts.refusalMessage    Text of the TypeError a locked API throws.
//   guard.check()          Run the child check now. The consumer calls it
//                          when it's about to trust the frame (a load event
//                          from the timer can beat the per-frame check).
//   guard.slowTimer()      Once the frame is settled, drop the timer from every
//                          250 ms to every second.
//   guard.isLocked()       Every lock was installed.
//   guard.isKilled()       A child frame was found and the document removed.
window.axFrameGuard = function axFrameGuard(win, opts) {
  'use strict';

  var onKill = opts && typeof opts.onKill === 'function' ? opts.onKill : null;
  var onTick = opts && typeof opts.onTick === 'function' ? opts.onTick : null;
  var refusalMessage =
    opts && typeof opts.refusalMessage === 'string' && opts.refusalMessage
      ? opts.refusalMessage
      : 'Not available in this frame.';

  var locked = true;
  var killed = false;

  // Non-writable and non-configurable, so agent code can't put the original
  // back. A failure is recorded, never swallowed: the consumer hears about it.
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
    throw new TypeError(refusalMessage);
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

  // A child frame exists that the layers above didn't stop. Only the
  // consumer's reporting stops after this; every guard keeps running.
  function kill() {
    removeRoot();
    if (killed) return;
    killed = true;
    if (!onKill) return;
    try {
      onKill();
    } catch {
      // The callback is the consumer's; the checks that called us must go on.
    }
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
  // so a timer backs it up: every 250 ms until slowTimer, then every second.
  if (typeof raf === 'function') {
    var everyFrame = function () {
      check();
      apply(raf, win, [everyFrame]);
    };
    apply(raf, win, [everyFrame]);
  }
  var clearTimer = win.clearInterval;
  // The consumer's own periodic work rides on the same timer, after the child
  // check, so there is only ever one interval.
  function tick() {
    check();
    if (onTick) onTick();
  }
  var timer = typeof setTimer === 'function' ? apply(setTimer, win, [tick, 250]) : undefined;
  function slowTimer() {
    if (timer === undefined || typeof clearTimer !== 'function') return;
    apply(clearTimer, win, [timer]);
    timer = apply(setTimer, win, [tick, 1000]);
  }

  return {
    check: check,
    slowTimer: slowTimer,
    isLocked: function () {
      return locked;
    },
    isKilled: function () {
      return killed;
    },
  };
};
