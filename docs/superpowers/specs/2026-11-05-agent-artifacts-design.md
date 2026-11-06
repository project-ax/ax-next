# Agent artifacts — design

**Date:** 2026-11-05 · **Status:** approved 2026-11-05 · **Owner:** Vinay

## 1. Intent

We want the agent to hand people finished things, not just chat text: a web page,
a PDF report, a markdown doc, a spreadsheet, a chart image, a script. Claude.ai
does this with Artifacts. We want the same feel, built for a team: the thing
**persists**, you can **open it in a viewer** right next to the chat, and you can
**share it with a teammate** by sending a link.

Today the agent can write files into `/files` and they show up in chat as
download chips. That's all. Nothing previews a page, PDF or image. Nothing lists
"the things the agent made for me". The one publish path (`artifact_publish`) is
scoped to a single conversation and a single user, so nobody else can open it.

### Why the shape below

- **Artifacts are a thin layer on top of files** (Vinay). The agent keeps working in
  `/files`; an artifact is a file the agent *deliberately hands over*, plus a name,
  version history and a share link.
- **Live sharing** (Vinay). A teammate who has the link sees the newest version
  without being re-sent anything.
- **Team-internal** (Vinay). The audience is teammates with AX accounts. No public
  web.

## 2. Goals

1. The agent can publish a file from `/files` as an artifact, with a human name.
2. Re-publishing the same artifact adds a new version; the link always shows the latest.
3. A new **Artifacts** icon in the chat header opens a side-panel list of every
   artifact this agent has made (across all its chats).
4. Clicking an artifact (in the list or its card in chat) opens a **wide viewer
   beside the chat**, so you can keep asking for changes and watch them land.
5. Every artifact has a **share link** containing a long random code. Opening it
   requires logging in to AX. Anyone logged in who holds the link can view and
   download it.
6. The agent can produce PDF, Word and Excel files out of the box.

## 3. Non-goals (for this cut)

- Public / anonymous links, search-engine indexing, "publish to the web".
- Per-person or per-team share lists, roles (viewer/commenter/editor).
- Comments, co-editing by teammates, remix/fork.
- Artifacts that call the model or connectors at view time (Claude's "AI-powered
  artifacts").
- HTML → PDF via a headless browser in the runner.
- Thumbnails (the list leaves room for them; see §6.1).
- Inline PDF preview (D11).
- Publishing from scratch space (C2).

## 4. Anti-goals — things that would make this a failure even if it works

- **A shared page that can act as the viewer.** Rendered agent HTML must never run
  with access to the AX origin, the viewer's session cookie, or the AX API. This is
  the exact class of bug that let shared previews take over ChatGPT accounts in Oct
  2026. Treat every artifact as untrusted content written by an attacker.
- **A teammate seeing a half-written file**, or a link that breaks because the
  agent renamed or deleted its working copy.
- **A second source of truth.** One table owns artifact metadata; the blob store
  owns bytes. No parallel "artifacts" state in another plugin.
- **Scratch clutter.** Helper files the agent writes for itself must never show up
  in the list.

## 5. Decisions made with Vinay

| # | Decision |
|---|----------|
| D1 | Only files the agent **deliberately** publishes become artifacts — not every file it writes. |
| D2 | **No new mount.** Working copies stay in `/files`. Publishing is a tool call, not a folder. |
| D3 | Published bytes are **copied into the existing blob store** at each publish. `/files` holds the editable working copy; the blob store holds frozen published versions. The artifact remembers its source path so "update the deal tracker" edits that file and re-publishes to the same artifact. |
| D4 | **Live link**: share link always serves the artifact's current version. Updates reach teammates when the agent re-publishes (not on every intermediate save). |
| D5 | **Versions**: each publish is a new version. Keep the **latest 20** per artifact; older ones pruned automatically. Versions count toward the agent's storage quota. Restore = move the "current" pointer back, no byte copy. |
| D6 | **Sharing = capability link + login.** URL holds a long unguessable random code; viewer must be logged in to AX. Any logged-in user with the link may view and download, and may pass the link on. No ACL list. |
| D7 | **List scope = per agent**, across all its chats. On a **team agent, every member sees every artifact**, including ones made in another member's chat. |
| D8 | **Viewer = option A**: the side panel widens into a viewer beside the chat (Claude.ai-style). Header: back to list, name + type, Download, Copy link, Close. |
| D9 | **List = compact rows** (icon square · name · "Type · EXT"), "Download all" at top. Icon square is the future thumbnail slot. |
| D10 | **Open-sign-up installs:** accept that "logged in + link" is as wide as sign-up is. On canopyworks.ai (sign-up restricted to canopyworks.com) that's team-only. Say so plainly in the admin/deploy docs; no extra domain check. |
| D11 | **PDFs are download-only** in this cut — no inline preview (Chrome's viewer won't load in a sandboxed iframe, and we don't want pdf.js or an unsandboxed frame yet). |
| D12 | **Artifacts outlive the chat that made them.** Purging a conversation does not delete its artifacts or versions; `conversation_id` on a version is a nullable historical note. Deleting the **agent** deletes its artifacts. Removing a member from a team agent changes nothing about the artifacts. |

### Builder-check calls (made by Claude, flagged for review)

| # | Call |
|---|------|
| C1 | **Share link starts off.** It is minted the first time someone clicks *Copy link*. The tool returns the internal `ax://artifact/<id>` URL, never the share code, so the secret never enters model context or the transcript (a prompt-injected agent can't leak it). |
| C2 | **Publish only from `/files`.** Scratch `artifacts/` publishing is dropped: scratch is wiped per session, so it can't be updated later. `source_path` is relative to the `/files` root. |
| C3 | **Migration is one-to-one.** Each existing `attachments_v1_artifacts` row becomes its own single-version artifact with its id preserved and `source_path = NULL` (excluded from the `(agent_id, source_path)` unique key), so old links resolve and nothing collides. A new publish of the same path starts a fresh artifact. |
| C4 | **Quota follows agent ownership**, same as `/files`: the user for a personal agent, `team:<id>` for a team agent. `blob:collect-refs` answers with that owner; pruning releases it. |
| C5 | **User renames stick.** `title` is required when an artifact is created and ignored on re-publish if a user has renamed it (`title_set_by_user` flag). The agent may still pass a new title on re-publish when the user hasn't renamed. |

## 6. How it works

### 6.1 What the user sees

**Chat header** gains a fourth icon toggle, *Artifacts*, alongside Memory, Files,
Activity (`packages/channel-web/src/components/workspace/AgentRail.tsx`,
`RAIL_PANELS`). It opens the standard 320px side panel:

```
Artifacts                          ⤓ Download all
┌──────────────────────────────────────────────┐
│ [📄]  Q3 pipeline report                     │
│       Document · PDF                         │
├──────────────────────────────────────────────┤
│ [🌐]  Deal tracker                           │
│       Web page · HTML                        │
└──────────────────────────────────────────────┘
```

Newest first (by latest version). Type labels: Document (md, pdf, docx, txt),
Web page (html), Spreadsheet (xlsx, csv), Image (png, jpg, svg, gif, webp),
Code (everything else textual). Empty state says, in our voice, what an artifact is
and how to get one ("Ask your agent to make you a report, page or spreadsheet —
it'll show up here.").

**In chat**, when the agent publishes, the turn shows an artifact card (name,
type, Open, Copy link). This replaces today's `ax://artifact/` download chip for
published files; `agent_file` chips for un-published files stay as they are.

**The viewer** (wide panel, D8): clicking a row or card widens the side panel to
roughly half the chat width and shows the current version. Header: ‹ back to list,
name, type, version picker ("v3 · 2h ago ▾" with *Restore this version*),
Download, Copy link, ✕. Body by type:

| Type | Preview |
|------|---------|
| HTML | Sandboxed iframe on the content origin (§6.5) |
| Markdown | Rendered with the existing `Markdown` component (no raw HTML) |
| PDF | "Download to open" (D11) |
| Images | `<img>` from the content origin (SVG served as an image, never inline document) |
| Code / text / CSV / JSON | Read-only, monospaced, syntax-highlighted if cheap |
| docx / xlsx / other binary | "We can't preview this one yet" + Download |

**The share page** (`/a/<code>`): requires login (redirect through sign-in and
back). Shows the artifact alone, full-page: name, "Made by <agent> · updated
<time>", the same preview, Download. A small "Made with AI by a teammate" line so
nobody mistakes a shared page for an AX system page. No chat, no list, no
version picker for non-owners (they see current only).

**Owner controls** (in the viewer's ⋯ menu): *Rename*, *Turn off link* /
*Get a new link* (old code stops working immediately), *Delete artifact*.
"Owner" = anyone who passes the agent ACL (`agents:resolve` / `checkAccess`): the
user for a personal agent, any member for a team agent.

### 6.2 What the agent sees

Evolve the existing `artifact_publish` tool
(`packages/tool-artifact-publish/src/descriptor.ts`) rather than adding a second
one. New input shape:

```
artifact_publish {
  path: string            // absolute path inside /files (C2)
  title: string           // human name shown in the list, e.g. "Q3 pipeline report" (C5)
  artifactId?: string     // re-publish to this artifact (new version)
}
→ { artifactId, version, url }   // url = ax://artifact/<id>, never the share code (C1)
```

Re-publish resolution: if `artifactId` is given, it must belong to this agent. If
omitted, a publish of the same source path by the same agent becomes a new version
of the existing artifact (so the agent doesn't have to remember ids). The tool
description must tell the agent: publish only things meant for the user; publish
again after changing it; don't publish helper/scratch files.

The agent also needs to *find* its artifacts across chats ("update the deal
tracker" in a new chat). Add the agent's artifact list (id, title, source path,
type, updated) to the per-session operating notes, capped (e.g. 50 most recent),
or as a tiny read-only `artifact_list` tool — **builder's call**; prefer the notes
if the list fits comfortably.

### 6.3 Storage

Bytes: existing content-addressed blob store (`blob:put`, `blob-store-fs` /
`blob-store-s3`). Identical bytes dedupe for free.

Metadata: replace the single-version `attachments_v1_artifacts` table with two
tables owned by **one** plugin (see §7 for which):

```
artifacts
  artifact_id        text pk
  agent_id           text not null          -- scope (D7)
  title              text not null
  source_path        text null              -- relative to /files root; re-publish key; NULL for migrated rows (C3)
  current_version    int  not null
  share_code         text unique null       -- null = link off (default, C1)
  title_set_by_user  bool not null default false   -- C5
  created_by_user_id text not null
  created_at, updated_at
  unique (agent_id, source_path) where source_path is not null

artifact_versions
  artifact_id        text fk
  version            int
  sha256             text not null
  media_type         text not null
  size_bytes         bigint not null
  conversation_id    text null              -- which chat produced it; history only, survives chat purge (D12)
  published_by_user  text not null
  created_at
  primary key (artifact_id, version)
```

- **Pruning (D5):** on publish, delete versions beyond the newest 20 (never the
  current one, even after a restore points backwards).
- **GC:** answer `blob:collect-refs` with every sha256 still in `artifact_versions`
  (the existing artifacts table already does this — keep the contract). Deleting an
  artifact deletes its rows; GC frees the bytes.
- **Quota (C4):** published version bytes count against the agent's owner
  (`@ax/disk-quota`), same as `/files`. Publishing over quota fails with a clear tool error.
- **Lifecycle (D12):** the existing `conversations:purged` subscriber stops deleting
  artifacts (it may null out `conversation_id`). An agent-deleted event deletes the
  agent's artifacts; GC frees bytes.
- **Share code:** ≥128 bits from a CSPRNG, URL-safe base64. Compare by indexed
  lookup only (never log it in full).
- **Migration of existing rows (C3):** each existing `attachments_v1_artifacts` row
  becomes its own one-version artifact under the conversation's agent, id preserved,
  `source_path` NULL, no share code. Old `ax://artifact/<id>` links keep resolving.

### 6.4 Formats the agent can make

Add pinned pure-Python wheels to the runner image's pre-seeded venv
(`container/agent/Dockerfile`, around the existing uv/venv step): **reportlab**
(PDF), **python-docx**, **openpyxl**, **matplotlib**. Pin versions with hashes
(supply-chain: run the `security-checklist` new-dependency walk). No network
needed at run time. Add a short operating-notes line telling the agent these are
available and which to use for what.

### 6.5 Rendering safely (the part that must not be wrong)

- **Separate content origin.** All artifact bytes that render (HTML, images)
  are served from a dedicated hostname on a **different registrable domain** from
  the app (e.g. app on `canopyworks.ai`, content on `<something>-usercontent.<tld>`).
  Never a subdomain of the app's site. Local/kind gets an equivalent second host.
- **Iframe:** `sandbox="allow-scripts allow-downloads"` (and `allow-popups` only if
  needed) — **never** `allow-same-origin`, never `allow-top-navigation`.
- **Response headers on the content origin:** strict CSP —
  `default-src 'none'; script-src 'unsafe-inline' <self-hosted pinned libs>;
  style-src 'unsafe-inline' <self>; img-src data: blob: <self>; font-src <self>;
  connect-src 'none'; form-action 'none'; frame-ancestors <app origin>`.
  No third-party CDN allowlist (allowlisted domains that echo content are the
  standard exfiltration path). `X-Content-Type-Options: nosniff`. `Cache-Control:
  private, no-store`. Media type comes from our stored row, never sniffed.
- **How the content origin authenticates without the app cookie:** the app (where
  the user is logged in) checks access, then mints a **short-lived, single-artifact,
  single-version signed token** and sets the iframe `src` to
  `https://<content-origin>/v/<token>`. The content origin verifies the token and
  serves bytes; it has no session, no cookies, no API. A leaked token expires in
  minutes and opens one version of one artifact.
- **No parent↔iframe messaging** in this cut. If any is added later: a
  schema-validated channel, `event.source` checked against the one iframe, and
  never write payload data into the DOM as HTML.
- **Downloads** are served from the content origin with `Content-Disposition:
  attachment` and the sanitized filename (reuse `content-disposition.ts`).
- **Markdown** keeps the existing renderer rules: no raw HTML, external images not
  loaded (markdown-image exfiltration), `javascript:`/`data:` links blanked.

### 6.6 Access rules (one function, tested)

| Who | Can |
|-----|-----|
| Passes agent ACL for the artifact's agent | list, view, all versions, download, copy link, restore, rename, link off / new link, delete |
| Logged in + holds current share code | view current version, download |
| Not logged in | redirected to sign-in, then back |
| Holds an old/turned-off code | a plain "This link doesn't work anymore — ask whoever sent it for a fresh one." |

Checked on **every** request (list, view, token mint, download), so turning a link
off or deleting takes effect immediately. Wrong codes and missing artifacts look
identical (404) so codes can't be probed. Rate-limit `/a/*` lookups per user.

## 7. Constraints (from CLAUDE.md invariants)

- **Plugin home:** one plugin owns artifact metadata (invariant 4). Builder's call
  between growing `@ax/attachments` (already owns the artifacts table and
  `artifacts:publish-blob`) or extracting an `@ax/artifacts` plugin that takes the
  table over. Whichever: no other plugin stores artifact state; channel-web talks to
  it only through hooks (invariant 2).
- **Hook payloads stay storage-agnostic** (invariant 1): `artifactId`, `version`,
  `contentDigest`/`sha256` (already in the contract), `title`, `mediaType`. No
  bucket/path-on-disk/NFS vocabulary. `source_path` is relative to the agent's files
  root and never leaves the plugin except back to the agent.
- **Boundary review** in the PR for every new/changed hook (publish, list, get,
  resolve-share-code, set-link, restore, delete, mint-view-token).
- **IPC:** the `artifact.publish` action's new fields go in `@ax/ipc-protocol`.
- **No half-wired pieces** (invariant 3): the content origin, viewer, list and share
  page ship together and are reachable from the canary acceptance test.
- **UI** composes channel-web shadcn primitives + semantic tokens (invariant 6);
  invoke the `shadcn` skill.
- **Security:** invoke `security-checklist` — this touches untrusted-content
  rendering, a new serving origin, a new IPC field, and new dependencies.
- **Deploy:** the content origin needs a hostname, TLS cert and ingress on GKE
  (`deploy/`, Helm chart) and kind. Document it in the GKE runbook.

## 8. Left to the builder

- Exact PR breakdown and ordering.
- `@ax/attachments` vs new `@ax/artifacts` (§7).
- Operating notes vs `artifact_list` tool for cross-chat lookup (§6.2).
- Token format/TTL for the content origin (short: minutes), as long as it's
  signed, single-artifact, single-version.
- Viewer widths, animation, version-picker presentation.
- Exact content-origin hostname (needs DNS — check with Vinay before deploying).
- Admin-doc wording for D10.
- Whether "Download all" zips current versions server-side or client-side.

## 9. Acceptance (what "done" looks like)

A walk on kind:

1. Ask the agent for a one-page PDF report → it appears in Artifacts and as a card
   in chat; the viewer shows "Download to open" and the download is a valid PDF.
2. Ask for an HTML dashboard → renders in the viewer; a page that tries
   `fetch()`, reading `document.cookie`, `top.location = …`, and posting a form all
   fail.
3. Copy link (mints the link; the agent's chat text never contained it) → a second account opens it after sign-in; sees it, downloads it.
4. In a new chat: "update the dashboard" → same artifact, v2; the second account's
   open link shows v2 on reload.
5. Restore v1 → link shows v1. Turn link off → second account gets the
   "doesn't work anymore" page.
6. Team agent: member B sees artifacts member A made in A's chat.
7. Publish 21 versions → only 20 remain; GC later frees the dropped blob.
8. Agent writes a helper script and never publishes it → not in the list.
9. Permanently delete the chat that made an artifact → the artifact and its link
   still work.
