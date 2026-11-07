# TASK-1082 Artifact HTML gets the chat-visual WebRTC locks — implementation plan

> For agentic workers: use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** agent HTML served from the content origin (`/v/:token`) gets the same in-page WebRTC and child-context defense chat visuals have, injected server-side before any agent markup runs, from ONE shared implementation.

**Premise check (verified, not trusted).** True. Measured on this tree (Playwright Chromium, content-origin CSP, UDP canary on 127.0.0.1): a page that does `new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:<port>'}]}); createDataChannel; createOffer->setLocalDescription` delivered **4 UDP packets** to the canary. `grep -ri webrtc` finds the locks only in `channel-web/.../visual/` and `docs/plans/2026-11-05-chat-visuals-design.md`. Nothing is wrong with the card.

## Stale text that made this card look settled, or goes stale when it ships (rule 5)

- `packages/attachments/src/artifacts/content-origin.ts` header: "HTML gets the strict CSP: no network". True for CSP-governed loads, silent on WebRTC. Fix in T7.
- `packages/channel-web/src/components/workspace/ArtifactPreview.tsx` header ("no channel for the page") — add one line that the page is guarded server-side. T7.
- `docs/plans/2026-11-05-chat-visuals-design.md` lines ~70-89 ("The frame runtime therefore locks…", "airtight alternative is a separate origin"): add a note that artifacts share the same guard (`@ax/frame-guard`) and that a separate origin is NOT a fix. T7.
- `packages/tool-artifact-publish/src/descriptor.ts:24` tells the agent pages have "no internet access". Keep (it is the contract we enforce) but do not weaken tests that pin it.
- Memory lines (parent updates at merge, not this branch): `project_agent_artifacts.md` ("NO in-frame RTC locks… open leak path") and `project_chat_visuals_show_visual.md` ("TASK-1082 ports the visual locks").
- `.github/workflows/ci.yml` ~line 184 comment names only `visual-hostile.browser.test.ts` as the Chromium suite; add the new file. T7.

## Design decisions (full rationale in the decisions shard)

1. **Shared source = new leaf library package `@ax/frame-guard`** (no plugin, no hooks, deps: `parse5` only). It follows the `@ax/skills-parser` / `@ax/ipc-protocol` precedent: pure library, allow-listed in the `no-restricted-imports` group in `eslint.config.mjs` (add `'!@ax/frame-guard'` and extend the message). Rejected: putting it in `@ax/attachments` (channel-web can't import it either, inv. 2), or a second copy (drift is exactly what the card forbids).
2. **What is shared:** the guard runtime (`frame-guard.js`: WebRTC + shadow/markup-parse locks, contentWindow getters, MutationObserver purge, `window.length` kill switch, rAF/timer checks) and the constants (`CHILD_FRAME_TAGS`, `DSD_ATTRS`). **What stays per environment:** the pre-insertion sanitizer. The visual path keeps its `DOMParser` `stripChildFrames` (it must stay import-free for `visual-hostile.browser.test.ts`, which transpiles `visual-doc.ts` raw); the server uses parse5. A channel-web drift test pins the visual selector list to the package constants.
3. **Server-side sanitize, not guard-only.** The guard's MutationObserver cannot see inside a *closed* declarative shadow root (`Element.shadowRoot` is null; window.length does not count shadow-tree frames), so parse-time `<template shadowrootmode=closed><iframe srcdoc=…>` would get a fresh unlocked realm. The server therefore parses with parse5 (`scriptingEnabled: true`, so `<noscript>` is text, as in the browser), removes frame-making elements, `noscript`, and `shadowrootmode`/`shadowroot` attrs (template content included), re-serializes, re-parses to a fixpoint (max 4 passes, as `stripChildFrames`), and **fails closed** (answer the same 404, log route+code only) if it never settles or parse5 throws (e.g. RangeError on pathological nesting). Static `<iframe>` outside shadow DOM is double-covered: stripped, and the observer microtask runs before any later parser-inserted script (HTML spec runs a microtask checkpoint at `</script>`).
4. **Always re-serialize** (instead of byte-splicing) so the tree we inspected is the tree we ship, and injection is a tree operation: guard `<script>` becomes the first child of the *parse5-built* `<head>` (the parser makes an implied head for fragments, doctype-less docs, leading comments, malformed heads, and a leading `<script>` before `<head>`). No doctype is added or removed (quirks mode preserved). Known round-trip trap to test and fix: parse drops the first LF after `<pre>/<textarea>/<listing>`; the serializer does not re-add it, so re-serialize must re-add a LF when such an element's first text starts with LF.
5. **No CSP nonce/hash, CSP unchanged.** `script-src 'unsafe-inline'` already allows the guard and must keep allowing agent inline scripts; a hash or nonce would block them, and an agent can read a nonce anyway. A test pins `htmlCsp` text unchanged.
6. **Only `preview === 'html'` responses are transformed.** Images (SVG sandbox CSP), downloads, PDFs are byte-identical (tests pin this).
7. **Guard on kill:** removes the document root and leaves the page blank (console message only). Visual path passes `onKill` = post `ax-visual:error`.
8. **Visual refactor keeps `frame-runtime.test.ts`, `visual-doc.test.ts`, `VisualFrame.test.tsx`, `visual-hostile.browser.test.ts` untouched.** `FRAME_RUNTIME_SOURCE` becomes `guardSource + '\n' + visualRuntime` (same global `axVisualRuntime(win, host)` entry); the guard exposes `axFrameGuard(win,{onKill,onTick}) -> {check, slowTimer, isLocked, isKilled}` so the visual runtime keeps exactly one interval and its `ready.locked` semantics. Visual-only code stays in `frame-runtime.js`: link/submit suppression, theme, export, chart helpers, sizing.
9. **Hostile test lives in `@ax/attachments`** (`startContentOrigin` takes a `serve` stub, so no Postgres/Docker needed), uses a **UDP (dgram) canary** — the existing TCP canary cannot see STUN — plus a control server (same CSP, no guard) that must reach the canary. `playwright` added as an `@ax/attachments` devDependency at the same version as channel-web (already in the lockfile).

## Security review (security-checklist)

- Sandbox: no new reachable capability; this removes one (WebRTC egress from artifact HTML) and adds none. The guard runs inside the existing opaque-origin sandbox. Residual (stated, not claimed solved): enumeration-based; a future API creating a child context or shadow root outside the locked entry points bypasses it; `<link rel=dns-prefetch|preconnect>` and DNS lookups are not covered by CSP or this card (visuals set `x-dns-prefetch-control: off`; follow-up card). Full fix is network-level (TASK-1065).
- Injection: the artifact bytes are untrusted HTML. They flow through parse5 into a re-serialized document served as HTML; the guard source is a trusted constant (checked at load to contain no `</script` or `<!--`). Parse differential (parse5 vs Chromium) is the risk: mitigated by fixpoint, scripting-on parse, the in-page guard as a second layer, fail-closed, and a Chromium corpus test of mXSS-style vectors.
- Supply chain: one dependency, `parse5` pinned exactly to `7.3.0`, the version already in `pnpm-lock.yaml` (via jsdom), so no new transitive package; zero runtime deps, no install scripts. `playwright` devDependency in attachments uses the version channel-web already pins.

## Tasks

### T1 [tier: sensitive] Failing hostile test showing the gap
Files: create `packages/attachments/src/__tests__/artifacts-webrtc-hostile.browser.test.ts`; modify `packages/attachments/package.json` (devDep `playwright`), lockfile.
- [ ] Model on `visual-hostile.browser.test.ts` (`@vitest-environment node`, skip locally if Chromium is missing, fail in CI, `default` and `isolated` browser modes).
- [ ] Rig: dgram UDP canary (count packets) + HTTP canary; real `startContentOrigin` with a stub `serve` returning hostile HTML, `frameAncestors:[appOrigin]`, tokens via real `signViewToken`; an "app" page with the shipped `index.html` CSP shape and `<iframe sandbox="allow-scripts allow-downloads" src=…/v/token>` (mirror `ArtifactPreview`); a **control** server serving the same hostile HTML with the same CSP and no guard.
- [ ] Matrix: {framed by app, top-level} x {default, isolated}. Probes (each its own artifact so one leak can't mask another): direct RTCPeerConnection; static `<iframe srcdoc>` that constructs RTC; script-created srcdoc iframe; `setHTMLUnsafe`/`setHTML`/`parseHTMLUnsafe` with DSD+iframe; `attachShadow` closed + iframe; **parse-time closed DSD** `<template shadowrootmode=closed><iframe srcdoc>`; `document.write` of an iframe; `XSLTProcessor`. Assertion: canary UDP packets == 0 and HTTP hits == 0.
- [ ] Control assertion: direct + static-iframe + closed-DSD probes on the unguarded control server DO reach the canary (>0), so the canary is proven live.
- [ ] Run it. It must FAIL on current code (direct probe on the origin: packets > 0). Paste the failing output in the PR. Commit red, then green after T5.

### T2 [tier: integration] Scaffold `@ax/frame-guard`
Files: create `packages/frame-guard/{package.json,tsconfig.json,src/index.ts}`; modify root `tsconfig.json` refs, `eslint.config.mjs` (allow-list + message), `packages/attachments/{package.json,tsconfig.json}` (dep + ref), `packages/channel-web/package.json` (dep). Check whether `eslint-rules`/`scripts` tests pin the allow-list text (`pnpm test:eslint-rules`). Add a changeset.
- [ ] `package.json` exports `.` (types+js) and `./frame-guard.js` (the raw runtime file; `files` includes it). Deps: `parse5` `7.3.0` exact.
- [ ] `src/frame-guard.js` is plain ES2020, no imports (like `frame-runtime.js`). `src/index.ts` exports `FRAME_GUARD_SOURCE` (read with `readFileSync(new URL('../src/frame-guard.js', import.meta.url))`, which is the same file whether the module runs from `src/` or `dist/`), `CHILD_FRAME_TAGS`, `DSD_ATTRS`. **No build-step copy into `dist/`** (T3 removed it): CI runs only `tsc --build` before the tests, so a copied `dist/frame-guard.js` does not exist there. The `./frame-guard.js` export points at `src/frame-guard.js` and `files` ships it.
- [ ] Verify `pnpm --filter @ax/frame-guard build` and that `pnpm deploy` for the host image includes it via the attachments dependency.

### T3 [tier: sensitive] Extract the guard from `frame-runtime.js`; channel-web consumes it
Files: create `packages/frame-guard/src/frame-guard.js`; modify `visual/frame-runtime.js`, `visual/frame-runtime-source.ts`; add `visual/__tests__/frame-guard-drift.test.ts`; add package unit tests.
- [ ] Move lines ~61-300 of `frame-runtime.js` (lock helpers, WebRTC/shadow/parse/document locks, getter locks, captured primitives, `forbidden/purge/childCount/removeRoot/kill/check`, observer, rAF + interval) into `window.axFrameGuard = function (win, opts)`; behavior-identical. `kill()` calls `opts.onKill()`; interval calls `opts.onTick()` after `check()`.
- [ ] `frame-runtime.js` calls `axFrameGuard(win,{onKill:()=>post({type:'ax-visual:error'}),onTick:…})` first, keeps `ready.locked` = `guard.isLocked()`, uses `guard.slowTimer()` and `guard.check()`.
- [ ] `frame-runtime-source.ts`: `FRAME_RUNTIME_SOURCE = FRAME_GUARD_SOURCE + '\n' + visualRuntime` (import the guard text with `?raw` through the package's `./frame-guard.js` export; add a vite/vitest alias in `vendor-aliases.ts` style if resolution needs it).
- [ ] Gate: `pnpm --filter @ax/channel-web test` visual suites and `visual-hostile.browser.test.ts` pass with ZERO edits to those files. Drift test: visual-doc's child-frame selector and DSD attr list equal the package constants.
- [ ] Guard-source unit test: contains no `</script` / `<!--`; evaluates in jsdom and locks RTC names.

### T4 [tier: sensitive] Server transform `prepareArtifactHtml(bytes)`
Files: create `packages/frame-guard/src/prepare-html.ts`, `src/__tests__/prepare-html.test.ts`.
- [x] `prepareArtifactHtml(html: string): string | null` (null = fail closed; never throws). Algorithm per decisions 3-4. Guard script text = `FRAME_GUARD_SOURCE + '\nwindow.axFrameGuard(window,{onKill:function(){try{console.warn("blocked: this page tried to open a nested frame")}catch(e){}}});delete window.axFrameGuard;'` (the guard prints nothing on a kill by itself). Shipped details T5/T6 depend on: the page it returns is a **fixed point** (`render(parse(out)) === out`, nothing left to cut, guard first in head), so calling it on its own output returns that output; it ships only strings parse5 reproduces byte for byte, never raw input bytes. At most 4 parse passes; refuses (null) any page holding a NUL (Chromium, Firefox and WebKit skip it while `<head>` is open, parse5 ends the head there) or a carriage return spelled as a character reference (`&#13;`: browsers read it as whitespace, parse5 does not), nesting past 512 elements, `<plaintext>` (the serializer grows it every pass), and a doctype whose quirks mode can't be written back (malformed ones). The doctype is re-written with its public/system identifiers (parse5's own serializer drops them and would flip quirks mode). T5: decode the stored bytes with `new TextDecoder().decode(bytes)` (drops the leading BOM, as a browser does) and serve the result as `text/html; charset=utf-8`. Moved the three data exports to `src/guard.ts` so `prepare-html.ts` imports them without a cycle through `index.ts`. Cost is roughly 0.15 to 0.2 s per MB of HTML on the caller's thread (0.15 s for 1 MB, 0.7 s for 5 MB, 4.3 s for 25 MB, the file cap), so T5 should bound what it hands over. Known fidelity gaps: markup inside `<select>` other than option/optgroup/hr is dropped (parse5 7.3.0 and 8.1.0 drop it; Chromium 147 keeps it), and a `<script>` cut off by the end of the document gets closed and so runs (a browser skips it).
- [ ] Tests (node): fragment, full doc, doctype/quirks preserved, leading comments, `<script>` before `<head>`, malformed/missing head, `<frameset>` doc, uppercase/spacing/`/`-separated attrs on `<template shadowrootmode>`, nested templates, `<noscript>` smuggle, `<svg>/<math>` foreignObject and mutation-XSS shapes, iframe text inside `<textarea>/<xmp>/<script>/comments` left as text, `<pre>` leading-LF round trip, entities, charset/non-ASCII, 8k-deep nesting returns null not a throw, guard is first child of head in every case, idempotent on its own output.

### T5 [tier: integration] Wire into the content origin
Files: modify `packages/attachments/src/artifacts/content-origin.ts`, `packages/attachments/src/__tests__/artifacts-content-origin.test.ts`.
- [ ] In the `preview === 'html'` branch: decode UTF-8, `prepareArtifactHtml`, null -> 404 + `logFailure` (route + code only; no path/token). Headers and CSP untouched.
- [ ] Update the one assertion that must change: `expect(await r.text()).toBe(HTML)` becomes "contains the original markup, starts the head with the guard". Add tests: CSP string unchanged; SVG/PDF/download bytes identical; fail-closed returns 404 with base headers; a normal page (table + inline chart script) round-trips with its script intact.
- [ ] T1 now passes. Run `pnpm --filter @ax/attachments test` (Docker needed for the DB suites).

### T6 [tier: sensitive] Complete the hostile suite
- [ ] Add the parse-time vector corpus from T4 run in Chromium (expect `document.querySelectorAll('iframe,object,embed').length === 0`, `window.length === 0`, zero UDP, zero HTTP), plus an **ordinary-artifact** test (table, canvas drawing script, inline SVG, `<pre>`, anchor `#id` navigation still works) asserting it renders and its script ran.
- [ ] Probe the kill switch: script-created child that slips through is torn down and the page blanks.
- [ ] Mutation check: remove each guard layer (locks, observer, server DSD strip) once and confirm a probe goes red (predict which first).

### T7 [tier: mechanical] Stale text, CI comment, memory
- [ ] Edit the stale items listed above (content-origin header, ArtifactPreview header, chat-visuals design doc, ci.yml comment).
- [ ] Shard `.claude/memory/decisions/2026-11-07-TASK-1082.md` (planner rows already written).
- [ ] Run the full gate: `pnpm build`, then `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, and `pnpm lint`.

### T8 [tier: integration] Kind walk (separate `(walk)` card, not yolo-ship-able)
- [ ] Open a hostile artifact on `ax-next-dev` (always `--context kind-ax-next-dev`), UDP canary silent; control page reaches it. Record in the PR; deploy only with Vinay's go-ahead.

## Residuals to file as follow-up cards
- `<link rel=dns-prefetch|preconnect>` / DNS exfil from artifact HTML (add `X-DNS-Prefetch-Control: off` header and test).
- A closed-DSD or new-API route unknown today (enumeration-based defense); TASK-1065 is the real fix.
