# Chat visuals: agent-authored HTML rendered inline in chat

Date: 2026-11-05
Status: approved 2026-11-05; plan: docs/plans/2026-11-05-chat-visuals-plan.md

## Intent

Some answers read better as a picture than as markdown. Two examples from Vinay:

- "Show issues per cycle over the past 20 cycles": a bar chart with hover tooltips, built from
  live connector data (Linear).
- "What's the weather forecast for Brooklyn?" as a good-looking weather card.

The agent should be able to write a self-contained piece of HTML and have it show up **inline in
the chat**, inside a sandboxed frame. It should look like part of AX, not like an embedded widget.

**What success looks like:** you ask either of those questions and get back a visual that looks
native to the app, in light and dark mode, with hover working, plus a short text summary. You can
download it as PNG or HTML.

**The failure Vinay named:** a visual that looks jarring or out of place. A visual that works
technically but clashes with the app counts as a failure.

## Goals

1. The agent can produce an inline visual in any chat reply.
2. **Interactive:** scripts run inside the frame, so hover tooltips, toggles and small
   animations work.
3. **Matches the app's style:** same fonts (Inter, the app's mono stack), the app's semantic color
   tokens, and light/dark mode that follows the app, including a switch while the visual is already
   on screen.
4. **The agent decides when:** it reaches for a visual when the answer is a trend, a comparison, or
   naturally card-shaped. If the user asks for one ("show that as a chart"), it always makes one.
   A one-line answer stays one line.
5. **Durable:** the visual is saved with the conversation and still renders after a reload or when
   the conversation is reopened. It's a snapshot; it never updates itself.
6. **Downloadable** as PNG and HTML from the rendered visual. (PDF was considered and dropped
   by Vinay.)
7. **Always paired with text:** the agent includes a short plain-text summary, so the answer
   works for screen readers and anywhere the frame can't render.

## Non-goals

- Live or self-refreshing visuals (a forecast that updates itself).
- Visuals that fetch data. The agent gathers the data first (connectors, web) and bakes it into
  the HTML.
- Visuals that talk back to the agent or the app (buttons that send messages, forms that submit).
- Rendering in surfaces other than the chat thread (workspace file previews stay inert).
- A gallery or library of past visuals.

## Anti-goals

- **Visually jarring output.** Each visual must look like a native AX surface: no off-palette
  colors, no foreign fonts, no wrong-theme flash, no inner scrollbars, no layout jump when it
  finishes loading.
- **A security hole.** The frame must not reach the app's origin, cookies, session, DOM or
  network. Model output is untrusted (invariant #5).

## Security envelope (decided)

Vinay chose "scripts allowed, in a box." The box:

- **Isolated origin.** `sandbox="allow-scripts"` and nothing else. In particular, no
  `allow-same-origin`, no `allow-top-navigation*`, no `allow-popups`, no `allow-forms`, no
  `allow-modals`. Content gets an opaque origin, so it can't read app cookies, storage or the parent
  DOM.
- **No network.** The frame's CSP denies all fetch, connect, image, font, frame and media loads
  from anywhere off-document (`default-src 'none'`, with only inline script/style and `data:`/`blob:`
  where needed for rendering and export). No CDNs, no tracking pixels, no beacons.
- **WebRTC is outside CSP.** No CSP directive covers `RTCPeerConnection`, and no engine honors
  `webrtc 'block'`. The frame runtime therefore locks `RTCPeerConnection` and its relatives before
  any agent markup runs. A visual that could open a child browsing context could get a fresh,
  unlocked realm (srcdoc children inherit sandbox and CSP, but not our runtime), so we stop those
  too, in layers:
  - The parent runs agent HTML through a `DOMParser` sanitizer that strips `iframe`, `frame`,
    `frameset`, `object`, `embed`, `portal`, `fencedframe` and `noscript`, plus `shadowrootmode`
    attributes (template content included).
  - The runtime runs a `MutationObserver` that purges the same elements (including inside open
    shadow hosts) and locks `attachShadow`, `setHTML`, `setHTMLUnsafe`, `parseHTML`,
    `parseHTMLUnsafe`, `document.write`, `document.open` and `XSLTProcessor`.
  - A `window.length` kill switch removes the document and reports an error if a child frame
    still appears. The parent unmounts the frame on any `ax-visual:error`.
  - `ready.locked` is advisory only; the parent does not rely on it.
- **Parent `frame-src 'none'`.** The chat page's CSP sets `frame-src 'none'`, which blocks the
  frame's own navigation and any remote frame. We verified in Chromium, Firefox and WebKit that it
  does not block `srcdoc` frames, so the visual itself still renders.
- **Residual risk.** This defense is enumeration-based. A future browser API that creates a
  shadow root or child browsing context without going through the locked entry points would bypass
  it. No engine honors CSP `webrtc 'block'`. The airtight alternative is rendering visuals from a
  separate origin.
- **The parent trusts nothing from the frame.** The only channel is `postMessage`. The parent
  checks that `event.source` is that exact frame's `contentWindow`, accepts only a small fixed set
  of message types (size report, export result), validates and clamps every field (height capped,
  export payload size capped, MIME type checked), and never evaluates or renders the frame's
  strings as markup.
- **Size cap** on the HTML: 100 KB, built as 102,400 bytes. The model writes the HTML itself, so
  it stays in the model's history and gets re-sent on every later turn in both runners. 100 KB is
  about 25k tokens, which is a tolerable worst case. Typical charts and cards are far smaller,
  because the chart library and theme are injected and don't count toward the cap. Over the cap, the tool
  call fails with a clear error, so the agent can simplify and retry. v1 does not strip old
  visuals from history.
- **The frame's own CSP meta tag** must be first in the srcdoc `<head>`, ahead of anything
  model-authored. The parent page's CSP (`frame-src 'none'`, above) is a second layer, and the srcdoc
  inherits it, so both policies apply.
- Invoke the `security-checklist` skill: this is untrusted content crossing into the UI.

## How it fits (my calls; the builder may revise with reason)

### Emission: a dedicated tool whose HTML travels the file-publishing path (decided)

The agent produces a visual by calling a tool, roughly `show_visual({ title, summary, html })`.

**Route (Vinay chose this, option A).** Model-written tool *input* never reaches the browser.
That rule is deliberate (invariant #5, `channel-web/src/lib/workspace-steps.ts`) and **stays
untouched**. As built, the input is never rendered or forwarded past the stream reader;
`stepDetail` keeps one fenced line (the title) and nothing more.
Instead, the visual follows the same route `artifact_publish` chips use today:

1. The sandbox-side executor validates the input (required fields, the size cap), then streams the
   HTML bytes to the host blob store (`blob.put`) and records the metadata row
   (`artifact.publish`). It reuses `artifact-publish-executor.ts`'s plumbing with
   `mediaType: text/html` and a marker that this artifact is a *visual* (title + summary carried in
   the metadata).
2. The tool *result* carries the artifact id, title and summary.
3. The server's `buildThread` (`server/routes-workspace.ts`) already parses `artifact_publish`
   results into attachment blocks via `attachmentBlockFromArtifact`. Extend it, and the live path
   (`workspace-api.ts`), to produce a **visual** block for a visual result. The block carries the
   id, title and summary, but no HTML.
4. The browser fetches the HTML through the existing authenticated, per-conversation download
   route, as text, and assembles the frame's `srcdoc` from it. The bytes are never navigated to
   or rendered as a document on the app's origin, and the download route keeps
   `content-disposition: attachment` and `nosniff`.

Why a tool and not a ```` ```html ```` fence in the reply text:
- It keeps the HTML out of the reply text. Memory and facts extraction, title generation and
  compaction read that text and should see the summary, not markup.
- It gives one place for the size cap and for policy (`tool-policy` gates it like
  `artifact_publish`).
- It gets durable storage and per-conversation access checks from existing code (invariant #4:
  the blob store and artifact row are the source of truth for the bytes; the transcript holds the
  reference).
- It works the same way in both runners.

Note: the HTML is still part of the tool call's *input*, so it stays in the model's history (see
the size cap). If the artifact metadata row or the visual block needs a new field, or a hook or
IPC payload changes shape, the PR needs a boundary review (the CLAUDE.md checklist). Keep the
field names backend-neutral: `visual`, `title`, `summary`, not storage terms.

### Rendering

- A new channel-web component (`VisualFrame` or similar) renders on the assistant message. It
  shows the title, the frame, and a download menu built from shadcn primitives (`DropdownMenu`,
  `Button`).
- `srcdoc` is assembled by the parent: CSP meta tag, then theme bootstrap (CSS variables and
  fonts), then the vendored chart library, then a tiny frame runtime (size reporter, export
  handler, theme listener), then the agent's HTML.
- **Auto-height:** the frame runtime reports its content height through `ResizeObserver` and
  `postMessage`. The parent clamps the height to a sane maximum. No inner scrollbars below that
  maximum, and space is reserved while loading so the thread doesn't jump.
- **While it's being written:** the live stream has no partial tool input (the `tool-use` chunk
  arrives complete). v1 adds no new streaming event. The tool descriptor's `activityPhrase`
  ("Making a visual") covers the wait; there is no `activity-phrase-map.ts` entry. When the call
  lands, reserve the card's space and fade the frame in.
- **Failure:** if the HTML throws or renders nothing, the summary text still stands. Show a quiet
  "This visual couldn't be displayed" state instead of a broken box.
  As built: "renders nothing" means the frame's `<body>` holds no element that draws and no
  non-blank text once it loads (`<script>`, `<style>`, `<template>`, `<noscript>`, `<link>` and
  `<meta>` don't count), or its height is under 8 px. A visual that hasn't said `ready` within
  **8 s of being watchable** fails too. The 8 s budget only runs while the tab is visible and the
  card intersects the viewport, and it pauses and resumes rather than restarting, because
  browsers don't run animation frames for a frame they aren't painting: a visual above the
  scroll position on reload, or one that arrives in a background tab, must not fail for being
  off screen. The frame runtime itself doesn't depend on painting either: it says `ready` from
  `load` on the next animation frame or a 100 ms timer, whichever comes first. The HTML fetch
  has its own 15 s timeout, so a hung request fails and leaves the cache instead of sticking
  until a reload.

### Matching the app's look

- The parent passes the app's current semantic tokens (`--background`, `--foreground`, `--card`,
  `--muted-foreground`, `--border`, `--primary`, `--accent`, radius). Note that these are bare HSL
  triplets (`226.67 15.25% 11.57%`), so the base stylesheet and the agent's instructions must use
  `hsl(var(--x))`. **Add a `--chart-1…--chart-5` palette to `index.css` in both themes** (none
  exists today), validated for contrast with the existing `theme-contrast.test.ts` approach. The
  tokens go and the
  light/dark mode into the frame at creation. It posts again whenever the theme changes, and the
  frame swaps variables without reloading.
- Fonts: only Inter is inlined into the srcdoc, as a Latin subset in a base64 `@font-face`,
  because the frame can't fetch it. Mono is the system stack, not inlined.
- A small base stylesheet in the frame (body margin, typography, card surface) means a bare
  `<div>` already looks like AX.
- **One pinned chart library**, vendored into channel-web's build (not loaded from a CDN) and
  pre-themed to the AX palette, so the default chart output is on-brand. As built: chart.js
  4.5.1 (MIT) for the chart library and html-to-image 1.11.13 for PNG export, both pinned,
  raw-imported (`?raw`) and used only inside the frame, never in the app bundle. New dependencies,
  so supply-chain checklist.
  The frame exposes a small `ax` helper: `ax.color(name, alpha?)` returns the token as an
  `hsl(...)` string, `ax.chartColor(name, alpha?)` returns a Chart.js scriptable color, and
  `ax.resolve(css)` resolves `var(--x)`. As built after the kind walk: a per-point color array
  holding `ax.chartColor(...)` or `var()` entries is resolved per point (Chart.js itself only calls
  a function that is the whole option), and on a theme change any `ax.color` string the agent
  wrote into chart options or datasets is swapped for the new theme's value before re-render.
- **The agent's instructions** live in the `show_visual` tool description (not in
  `communicationNote()`), so both runners get them and they appear only where the tool does. They say three things. Style
  only with the provided CSS variables, never raw colors or other fonts. Use the provided chart
  library. Always write a plain-text summary alongside the visual. They also state the
  "when to reach for a visual" rule from Goal 4.

### Downloads (PNG, HTML)

All generated client-side; no server-side renderer.

- **HTML:** a script-free wrapper page. Its CSP equals the frame CSP (srcdoc frames inherit the
  parent CSP, so the wrapper must not be looser), and it embeds the assembled visual (theme frozen at
  the current mode, fonts and chart library inlined) in a `sandbox="allow-scripts"` srcdoc iframe.
  Agent script therefore never runs top-level when the file is opened from disk, and it stays
  offline. Separately, `/api/files` serves `html`, `xhtml`, `svg` and `xml` as
  `application/octet-stream`, so a stored visual can't be navigated to as a document.
- **PNG:** the parent asks the frame to snapshot itself (the opaque origin means the parent can't
  read its pixels). The frame runtime rasterizes its own DOM using a small vendored
  DOM-to-image helper, at 2x, and posts back a PNG blob. Canvas-based charts are drawn directly.
  The parent validates the payload (type and size) and triggers the download.
- File names come from the visual's title (sanitized), falling back to `visual`.

## Constraints

- Invariant #6: the chrome around the frame (title, download menu, placeholder, error state) uses
  shadcn primitives and semantic tokens. The frame content uses the same tokens via CSS variables.
- Invariant #5: everything in the security envelope above, plus a security note in the PR.
- Invariant #3: the tool is registered in both presets, reachable from the canary acceptance test,
  and covered by tests (rendering, theme switch, postMessage validation, export, size cap).
- Both runners support the tool.
- Accessibility: the frame has a `title` attribute, and the summary text is the accessible answer.

## Verification

- Unit tests: tool input validation and size cap; srcdoc assembly (CSP present, sandbox
  attribute exact); parent message filter (wrong source, unknown type, oversized payload are all
  ignored).
- A browser walk on kind (`k8s-acceptance-loop`): ask both example prompts, check that the chart
  has working hover and the card renders, toggle light and dark, reload the conversation, and
  download both formats. A visual check against the "jarring" anti-goal, in both themes.
- A hostile-content test: a visual that tries `fetch`, `top.location`, `document.cookie`,
  `parent.document` and a remote `<img>`. All of them must fail, with no network request
  leaving the frame.

## Left to the builder

- The tool's exact name and schema, the size cap and the max height. Built as `show_visual`,
  102,400 bytes, and a max frame height of 1200 px.
- The choice of chart and DOM-to-image libraries (pinned, vendored, justified).
- Font subsetting strategy.
- Exact token list passed to the frame, and the chart palette values.
- Placement and styling details of the download menu.
