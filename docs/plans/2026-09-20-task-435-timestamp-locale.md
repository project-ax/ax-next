# TASK-435 — one clock, the reader's

The same event reads four hours apart depending on the tab. Chat bubbles carry a
display string the **server** formatted in the **server's** timezone; the `did`
(Activity) feed carries an instant and formats it in the **reader's**. A host in
UTC and a reader in EDT therefore disagree by the offset, and nothing on screen
says which of the two you are looking at.

## What the audit found (verified, not assumed)

Every workspace surface that turns an instant into something a reader reads, and
which side did the turning **before** this card. Note the claim: it is about
where the *formatting* happens, not about a list of fields — the `startedAt` row
below is here precisely because an earlier draft of this table said "every
timestamp" and then omitted it.

| Site | Where | Before |
|---|---|---|
| Chat bubble clock | `routes-workspace.ts` `shortTime()` → `ThreadMessage.time` → `AgentConversation` | **SERVER**, server's zone (`Date#getHours`) |
| "Previous conversations" row | `routes-workspace.ts` `relativeDay()` → `PastConversation.meta` → `AgentView` | **SERVER**, server's zone (`getFullYear/getMonth/getDate`) |
| `did` feed day buckets + clock | `ActivityFeed.tsx` `localDayKey` / `dayLabel` / `localTime` off `ActivityEvent.at` | client, reader's zone |
| Rail "started 4 min ago" | `RailActivity.startedAt` → `bits.tsx` `Elapsed` | client — and elapsed time has no zone to get wrong |
| Grant "14 Aug" | `bits.tsx` `grantedDay` | client, reader's zone |
| Today header + "done today" count | `WorkspaceShell.tsx` `today()` / `isLocalToday` | client, reader's zone |
| Decision `preview.meta` | `workspace-types.ts` | not a timestamp — the quoted artifact's header line |
| Files / memory rows | `WorkspaceFileSummary`, `UserFileEntry`, memory doc | carry no timestamp at all |

So exactly **two** server-formatted sites, both in `routes-workspace.ts`, and both
feeding the chat tab. Everything else was already right — and the two kinds of
"already right" are worth separating, because only one of them is a decision
anybody made. `ActivityFeed`, `grantedDay` and the Today header format on the
client *deliberately*. `Elapsed` is correct *by construction*: "4 minutes ago" is
a difference between two instants, and a difference has no timezone to be wrong
about. It could be computed on either side and read the same. It is listed so the
audit is exhaustive, not because it was ever at risk.

## The product question is already settled in the code

`ActivityEvent`'s own doc comment (`lib/workspace-types.ts`) settles which side is
right, in the codebase's own words:

> There is deliberately no `day` and no `time`. The prototype carried both as
> SERVER-COMPUTED display strings … which are only right for a reader sitting in
> the server's timezone. … A display string is a rendering decision, and
> rendering decisions do not belong on the wire.

The `did` feed is the side that already obeys this. The chat tab is the side that
does not. Nothing to escalate: we finish the migration that `ActivityEvent`
started, which is also exactly what the card's Scope asks for.

## Tasks

1. **`lib/workspace-time.ts` — one formatter module.** `localTime`,
   `localDayKey`, `localDayLabel`, `relativeDay`. `ActivityFeed`'s private copies
   move here; `relativeDay` moves off the server verbatim. Invariant 4: the two
   surfaces the card says disagree now share one function, so they cannot drift
   back apart.
2. **Wire.** `ThreadMessage` `agent`/`steps`: `time: string` → `at: string`, an
   ISO instant (`''` = the live frame, which has no committed instant yet).
   `PastConversation`: `meta: string` → `lastActivityAt: string`. Delete
   `shortTime` and `relativeDay` from `routes-workspace.ts`.
3. **Render.** `AgentConversation` formats `m.at` through `localTime` and draws
   no clock row at all when there is no instant. `AgentView` formats
   `past.lastActivityAt` through `relativeDay`; its live pending frame carries
   `at: ''`. `ActivityFeed` imports the shared module.
4. **Tests.** A cross-layer parity test (below), a negative-space wire test, unit
   tests for `workspace-time`, and the mechanical fixture updates.

## The test that reddens

`__tests__/workspace-timestamp-parity.test.tsx`, modelled on
`workspace-steps-seam.test.tsx`: one fixture, two surfaces, one assertion they
agree.

The trap this deliberately avoids: a test run wholly in one timezone passes
against the **unfixed** code too, because `shortTime` would be formatting in the
same zone the renderer reads. So the test **moves** `process.env.TZ` — measured on
Node 24: `process.env.TZ` takes effect immediately, on already-constructed `Date`
objects included.

- Build the wire under `TZ=UTC` (the host's zone) via the real `agentDetail`
  handler over a stubbed `conversations:get`.
- Flip to `TZ=America/New_York` (the reader's zone) and render **both** the chat
  bubble (`AgentConversation`) and the `did` row (`ActivityFeed`) off that one
  instant.
- Assert the two clock strings are equal **and** equal the reader-local
  `8:56 PM`, and that the `did` row files it under **Yesterday** while the
  bubble agrees.

Against the unfixed code the bubble says `12:56 AM` and the feed says `8:56 PM` —
the card's exact numbers. Plus `expect('time' in msg).toBe(false)`, because a
round-trip assertion cannot detect a field that is still there.

## Boundary review

No hook signature changes — `conversations:get` / `conversations:list` are read
exactly as before. This is a BFF response shape (`GET /api/workspace/agents/:id`),
internal to `channel-web`, consumed only by its own SPA which ships in the same
bundle. No new capability, no untrusted-content path, no new dependency.
