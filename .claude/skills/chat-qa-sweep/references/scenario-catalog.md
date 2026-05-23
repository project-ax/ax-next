# Happy-path battery — scenario catalog

Scenarios to run against a healthy cluster. Each entry gives: prerequisites, steps (in
Playwright-MCP terms), PASS criteria, the DOM/accessibility signal that proves it, and the
failure modes to watch for. Drive sign-in and basic send-and-wait via `k8s-acceptance-loop`'s
`references/playwright-recipes.md` — those recipes are not repeated here.

## Locating elements: assert on the accessibility tree, not source names

`browser_snapshot` returns an **accessibility tree** (roles + text), not React component
names. Component names below (`NewSessionButton`, `AttachmentChip`, …) are for *orientation*
— to assert, locate by role/text/CSS class actually in the DOM (e.g. `.agent-status`,
`.msg-error`, `.msg.you`). If a locator doesn't resolve, the component may have drifted —
check `packages/channel-web/src/components` rather than assuming the snapshot is wrong.

## The wire (for network assertions)

Sending is a **two-phase** wire — assert on both legs in `browser_network_requests`:

1. `POST /api/chat/messages` → `202` with `{ conversationId, reqId }` (the turn is
   accepted; for a new chat `conversationId` is minted server-side).
2. `GET /api/chat/stream/:reqId` → `200 text/event-stream` — the SSE the assistant streams
   over (`text`/`thinking`/`tool-use`/`tool-result`/`phase`/`done` frames).

Title updates ride a separate per-user SSE: `GET /api/chat/title-events`. Transcript reads
go through `GET /api/chat/conversations/:id` — which **lags chat turn-end by ~1s** under
runner-owned sessions, so transcript assertions must **poll/wait**, never snapshot-once.
Cleanup is `DELETE /api/chat/conversations/:id` (soft-delete, idempotent → 204).

## Dependency graph (what must run before what)

Only one real coupling — don't over-serialize the rest:

```
#3 (npx, leaves a tool-call) ─┐
                              ├─► same session ──► #8 (reload it: assert tool-call + attachment, continue)
#5 (upload, leaves attachment)┘                         ▲
#6 (download) needs #5's attachment ────────────────────┘
everything else (#1 #2 #4 #7 #9 #10 #11 #12 #13 #14 #15) is order-independent.
```

So: run **#3 and #5 in the same conversation** (note its id), run #6 against #5's
attachment, and reload that conversation in #8. `#4` (use a skill) is standalone — run it
whenever, it does NOT need to share the #3/#5 session. Everything else can run in any order.

Capture `browser_snapshot` + `browser_console_messages` + `browser_network_requests` after
every scenario.

---

## 1. New chat

- **Steps:** click new-chat (`NewSessionButton`) → land on a fresh thread.
- **PASS:** empty thread (no prior messages), composer present + focusable, no console
  errors.
- **Proves it:** empty timeline + ready composer in the snapshot.
- **Watch for:** stale messages from a previous session bleeding in; composer disabled.

## 2. Always a response

The baseline contract: a user message always gets a completed assistant turn.

- **Steps:** type "hello, what can you do?" → submit → wait (bounded) for the turn to
  complete (`textGone: Generating`, or assistant text present).
- **PASS:** user message in the transcript; assistant turn appears **and completes**
  (status row returns to idle); the wire shows `POST …/messages` 202 then the SSE 200.
- **Watch for:** empty assistant bubble; status row stuck in `working` past the max wait
  (→ FAIL, hung spinner); 5xx on send.

## 3. npx command  → leaves a tool-call for #8

- **Prereq:** credentialed CLI tools enabled (npx allowlisted, PR #126).
- **Steps:** prompt `run npx --yes cowsay@latest hi`.
- **PASS:** a tool-use block renders with the command and its output/exit; the assistant
  references the result.
- **Proves it:** populated tool block (`ToolUse`) in the snapshot; `tool-use`+`tool-result`
  SSE frames.
- **Watch for:** tool block missing (model declined / tool unregistered — check host
  `tool:execute` logs); output garbled; exit code swallowed.
- **Do this in the session you will reload in #8** (note its id).

## 4. Use a skill (standalone)

- **Prereq:** the agent under test has ≥1 skill attached (confirmed in Phase 0).
- **Steps:** send a message that should invoke the attached skill.
- **PASS:** the agent demonstrably uses the skill (output reflects it, not a generic
  answer).
- **Watch for:** skill silently not discovered; generic answer as if no skill attached.

## 5. Upload attachment  → leaves an attachment for #8 (same session as #3)

- **Steps:** attach a small known file in the composer (`browser_file_upload`) → pending
  chip shows (`AttachmentComposerChip`) → submit.
- **PASS:** chip shows pre-send; after send it reconstructs as a downloadable
  `AttachmentChip` on the message; the POST carries an `attachment_ref`; the agent can
  reference the file.
- **Watch for:** chip vanishing on send; upload 4xx/5xx; `[attachment: unknown]` fallback;
  agent unaware of the file.

## 6. Download attachment (needs #5)

- **Steps:** click the `AttachmentChip` from #5.
- **PASS:** a download fires (`browser_network_requests` shows `GET /api/files?path=…`
  2xx); content matches what was uploaded.
- **Watch for:** dead chip (no handler); 404 on the blob; wrong/empty file.

## 7. Artifact creation + attach to response (standalone)

- **Prereq:** the agent can `artifact_publish`.
- **Steps:** prompt "write a short poem to a file and publish it as an artifact."
- **PASS:** an `ArtifactChip` appears on the assistant message; clicking it opens/downloads
  the artifact.
- **Watch for:** artifact created server-side but no chip (read-path gap); chip present but
  broken link.

## 8. Load old session + continue (DEEP — the read-path scenario)

The highest-value scenario: it exercises the `conversations:get` read path that has
regressed before (chip reconstruction, transcript-read race). Reload the #3/#5 session.

- **Steps:**
  1. Navigate away or reload, then open the #3/#5 session via its row (`SessionRow`) in the
     list (`SessionList`). **Poll/wait** for hydration — don't assert instantly (the ~1s
     read lag).
  2. Assert the read path reconstructs everything:
     - **(a) prior messages** — earlier user/assistant turns render in order.
     - **(b) old tool-call** — the #3 tool block displays correctly: command + output
       visible, **not** collapsed/empty/orphaned.
     - **(c) old attachment** — the #5 attachment chip renders **and is still
       downloadable**: click it → file downloads (this exercises chip reconstruction on the
       *read* path, not just the live-turn path).
  3. **Prove context continuity** — post a NEW message answerable *only* from prior-turn
     content: "what was the output of the command you ran earlier?" or "summarize the file
     I attached."
- **PASS:** (a)+(b)+(c) all reconstruct, AND the new reply demonstrably uses the old context
  (references the actual earlier tool output / attachment content).
- **FAIL:** any of (a)/(b)/(c) missing or broken, OR the agent answers as if the history were
  absent ("I don't have a record of that") — meaning the reloaded session's messages weren't
  fed into the new response's context.

## 9. Title generation (standalone)

- **Steps:** on a fresh first-turn session, watch the session's title in the list /
  `SessionHeader`. Keep the `GET /api/chat/title-events` SSE in view.
- **PASS:** the title flips from its default ("New chat"/untitled) to a content-derived one
  within a bounded window, arriving live via the SSE and/or the ~10s poll.
- **Watch for:** title stuck on default; updates only after manual reload (SSE path broken);
  wrong-session title (cross-talk).

## 10. Parallel sessions (isolation, not true concurrency)

A single Playwright driver can't truly send two messages at the same instant. Test the
isolation contract by **interleaving**: start a turn in session A, and **before it
completes** start a turn in session B.

- **Steps:** open 2 sessions — split panes if the UI offers them (check the snapshot),
  else `browser_tabs`. In A send "remember the codeword BANANA"; before A finishes, in B
  send "remember the codeword WALRUS." Let both complete. Then ask each "what was your
  codeword?"
- **PASS:** A's reply lands in A and B's in B (no bleed); each session recalls its **own**
  codeword; `browser_network_requests` shows distinct `reqId`s, no sessionId collision.
- **Watch for:** a response rendered in the wrong pane; one stream overwriting the other; a
  shared spinner; B's answer leaking A's codeword.

## 11. Cancel / stop a streaming turn (standalone)

`AgentStatus` shows a **stop** button while a turn is `working`. Cancelling mid-stream is a
classic orphaned-spinner / zombie-turn source.

- **Steps:** send a prompt that streams a while ("count slowly from 1 to 50, one per
  line"); while it's streaming, click the stop control on `.agent-status`.
- **PASS:** streaming halts promptly; the status row returns to idle (no lingering
  spinner); any partial assistant text stays rendered and coherent; composer re-enables;
  the next message works.
- **Watch for:** spinner persists after stop; partial text vanishes or duplicates; next
  turn wedged; console error from writing to a closed stream.

## 12. Rapid double-submit race (standalone)

- **Steps:** type a message and submit it twice in quick succession (double `Enter`, or
  Enter then immediate click). Also try submitting while a turn is already streaming.
- **PASS:** exactly one user message + one assistant turn per intended send; no duplicated
  user bubble; either the second submit is ignored/queued cleanly or it starts a distinct
  well-formed turn — never a half-rendered or interleaved mess.
- **Watch for:** duplicated user message; two overlapping assistant streams in one thread;
  composer locking up.

## 13. Hostile input (standalone)

Drive the input edges that break renderers and validators.

- **Steps:** submit, separately: (a) an empty / whitespace-only message; (b) a very long
  paste (~50k chars); (c) an emoji/multibyte-only message; (d) a message containing raw
  markdown/HTML (e.g. `# h1`, `<script>alert(1)</script>`, a fenced code block).
- **PASS:** (a) empty submit is refused or no-ops (no empty turn sent); (b) long input is
  accepted or rejected with a clear message (not a crash/freeze); (c) renders intact; (d)
  `MarkdownText` renders safely — markdown formats, HTML is **not** executed, no raw markup
  leaks, no XSS.
- **Watch for:** white-screen on long paste; script execution; raw `<tag>` text shown as-is
  where it should render; layout blowout.

## 14. Error-presentation sanity (deterministic, no backend) (standalone)

Confirms the three error UIs render and their actions work *before* the fault battery
relies on them — isolates presentation bugs from backend faults.

- **Steps:** send each dev trigger: `/error transient`, `/error inline`, `/error toast`,
  `/error all`. (Also `/status` and `/status Building image…` to sanity-check the status
  row's normal phase labels + 3s auto-hide.)
- **PASS:**
  - `transient` → `.agent-status` flips to error mode with a working **retry** ("Reconnecting…"
    then hides);
  - `inline` → a `.msg-error` row (`role=alert`) attaches to the last `.msg.you` with
    Retry/Dismiss that remove it; with no prior user message it falls back to a toast;
  - `toast` → an error toast appears;
  - `all` → status + inline + toast together.
  These triggers are intercepted client-side (`Composer.tsx`) and are **not** persisted to
  history.
- **Watch for:** a surface that doesn't render; an action (retry/dismiss) that doesn't clear
  it; the trigger leaking into the transcript as a real message.

## 15. Glitch sweep (a lens applied to #1–#14)

Not a separate drive — a lens applied after every scenario above. Scan for:

- **Console:** any errors/warnings in `browser_console_messages` → GLITCH (or FAIL if it
  breaks the flow).
- **White-screen / unmount:** snapshot shows an empty or broken tree.
- **Spinner hygiene:** every streaming/loading indicator clears within its bound.
- **Rendering:** chips (`AttachmentChip`/`ArtifactChip`), tool blocks, and `MarkdownText`
  render without raw markup, broken images, or empty shells.
- **Message integrity:** no duplicated, orphaned, out-of-order, or missing-author messages.
- **Layout/scroll:** transcript scrolls to the latest turn; composer stays reachable. A
  quick `browser_resize` to a narrow width (invariant #6 is the shared shadcn layout) — no
  overlap/overflow.

Record every glitch with a screenshot reference. A scenario can be functionally PASS and
still log GLITCH findings.
