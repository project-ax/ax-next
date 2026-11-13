# Slack channel (design)

**Status:** proposed 2026-11-09. Spike (TASK-1090) done 2026-11-12; §7 has the answers. Memory decided 2026-11-12 (§2a).
**Owner:** Vinay · **Started:** 2026-11-09 · **Code cited at:** `5474a59c9` (main)
**Cards:** TASK-1090–1099 (§9).

People talk to AX agents in Slack. Everyone can DM their own personal agent. A
team agent can join a public channel, and anyone at the company can talk to it
there. Nobody needs Slack admin rights to put their agent in Slack. And nobody
in Slack needs an AX account to talk to a channel agent.

The short version of the security model: **a Slack account proves you work at
Canopy. It doesn't give you anyone else's access.** An agent in a channel acts
with its owner's access, so the people talking to it never get more reach than
the owner chose to put there.

---

## 1. Decisions so far

1. **The bot is the agent.** Slack users talk to an agent the way they'd talk to
   a coworker. They don't have to exist in AX.
2. **A company email gets you in.** A Slack user may talk to an agent only if
   they are a full member of the workspace (not a guest, not a bot, not
   deactivated) with a verified email on an approved domain. The approved
   domains are the ones AX's Google sign-in allows: the Google provider's
   *Allowed email domains* list. When that list is blank, sign-in accepts any
   domain, and so does this check. We fetch the email ourselves through
   `users.info`. Anything in the message text is ignored for identity.
3. **A company email doesn't get you someone else's agent.** Being an employee
   is the same bar as signing up for AX. AX still runs `agents:resolve` so one
   employee can't use another's agent, and Slack must not become a way around
   that.
4. **Personal agents answer only their owner, only in a 1:1 DM.** We route by
   the sender's verified email to their AX user and then to their personal
   agent. Group DMs count as channels. An @mention in a channel never reaches a
   personal agent.
5. **Channel agents are dedicated team agents.** Someone's personal agent never
   gets switched on in a channel.
6. **No channels shared with other companies.** The bot doesn't answer in a
   channel where `is_ext_shared` is true (Slack Connect), because the reply
   would land in front of another company.
7. **Owners never need Slack install rights.** A Slack admin connects the
   workspace once. After that, every agent works in Slack through the shared
   app straight away. A dedicated bot with its own @name is an extra that an
   admin approves with one click on Slack's own install screen (phase 2).
8. **The shared app's name defaults to the AX instance's name.** We take it from
   `branding:get` and turn it into a valid name (§7 Q3), falling back to `ax`.
   The admin can change it when connecting the workspace and rename it later.
9. **Memory follows who sees the reply, not who is talking** (§2a). Something
   said privately is never recalled in a channel.

## 2. Who is talking, and what they can do

| Where | Agent | Who can use it | Turn runs as |
|---|---|---|---|
| 1:1 DM with the shared bot | Sender's personal agent | Only its owner | Owner, **attended** (`ctx.source: 'user'`) |
| Public channel connected to an agent | That team agent | Any full company member | **Attended** if the sender is an AX user who passes `agents:resolve` for the agent; otherwise **external** (`ctx.source: 'external'`) |
| Group DM, Slack Connect channel, guest, bot, other domain | — | No one | Ignored, or a short private refusal |

**Attended** means it works like the web chat: permission requests show up as
buttons, and only the person whose turn it is can click them.

**External** means nobody with access to the agent is there. The turn runs as
a real person who answers for it, the way a routine runs as its owner
(`packages/routines/src/fire.ts:267`): for a channel agent, that's **the person
who connected the channel**. A team has no user id, and memory refuses made-up
owners (`packages/memory/src/owner.ts`). Connector calls that need approval wait
for that person in Today. The bot says in the thread that it's waiting for its
owner. No identity edits, skill authoring or connector requests are allowed,
and both proposal tools are hidden from external turns.

The Slack sender's name and ID go into the message *content*, for example
`[Slack · #support · Alice (U123)]: …`. That label is untrusted text the model
reads. Nothing ever treats it as permission to do something.

## 2a. Memory: decided by who sees the reply

Two problems with today's memory once an agent sits in a channel:

1. **Private facts could leak.** A team agent's memory is shared across the
   team (`packages/memory/src/access.ts`). Something a member told it in a
   private web chat could be recalled in a public channel, in front of
   everyone, even when the asker is a trusted teammate.
2. **Statements get pinned on the wrong person.** The extractor records whoever
   is talking as `user:<ctx.userId>` (`packages/memory/src/subject.ts`). In an
   external turn `ctx.userId` is the person who connected the channel, so a
   passing Slack user's "I live in Paris" would be stored as a fact about them,
   permanently.

The privacy risk comes from **who sees the answer**, not who asks. So each turn
carries a second, separate field, **`ctx.audience: 'private' | 'shared'`**.
channel-slack sets `shared` for channels and group DMs, and `private` for 1:1
DMs. Everything else (the web app, routines) is `private`, as today.
`ctx.source` still decides approvals; `ctx.audience` decides memory.

| | Private turn (DM, web) | Shared turn (channel) |
|---|---|---|
| **Recall** | Everything, as today | Only statements learned in `shared` turns, plus the agent's instructions and files |
| **Capture** | As today, stamped `private` | Stamped `shared` |
| **Facts about the speaker** | As today | **Not captured.** Only facts about the work: projects, decisions, processes, who owns what. |

Knowledge flows one way: shared → private, never back. What the agent learned
in #support can be recalled anywhere. What someone said privately is never
recalled in a channel.

- The owner's memory view labels shared statements so they can be deleted. It
  says "Shared" for now. Naming the channel ("learned in #support") waits for
  TASK-1094, since memory never sees a channel name.
- A shared session gets no `/memory` file view. The export holds every fact the
  agent has, so it would walk around the recall filter.
- The speaker rule is a filter, not a prompt change. In a shared turn, any
  statement whose subject is `user` or starts with `user:` is dropped.
- Known gaps, accepted: the extractor may name the speaker from the sender
  label; closing a slot is tenant-wide, so a private statement can close a
  shared one; a Fix on a shared memory saves as private.
- Each connected channel has a "Let the agent remember this channel" switch,
  on by default.
- **Instructions and files aren't covered by this.** A channel agent's
  instructions and files are readable in every turn. The connect screen says
  plainly that they're visible to anyone in the channel.

**Rejected:**
- *No memory in channels at all:* the safest, but the bot forgets every thread,
  which loses most of a team bot's value. It stays the fallback if the stamping
  turns out costly.
- *Full memory everywhere:* leaks as in problem 1.
- *Decide by who's asking* (full recall if the asker has AX access): the same
  leak, because a teammate asking in #general still shows the answer to all of
  #general.

## 3. The shared app (phase 1)

### Connecting a workspace (Slack admin, once)

1. In AX admin settings, **Connect Slack** shows a short guide and a link to
   https://api.slack.com/apps → "Your App Configuration Tokens" → **Generate
   Token**. That page is the one step Slack doesn't let us automate: no OAuth
   flow hands out that token. The admin pastes **both** values: the access token
   (`xoxe.xoxp-…`, valid for 12 hours) and the refresh token (`xoxe-…`).
2. The admin confirms the bot's name. The name defaults to the branding name,
   checked against Slack's name rules (§7 Q3), otherwise `ax`.
3. AX creates the shared app with `apps.manifest.create`, then sets the avatar
   (the branding logo) with `apps.icon.set`. The manifest sets the name, scopes,
   and the event and interactivity URLs. Slack sends no challenge and needs no
   manual Verify click (§7 Q1).
4. The admin is sent to Slack's install screen and clicks **Allow**. AX stores
   the bot token. This click is the only one a person must make, and only
   someone with install rights can make it.
5. AX keeps the **refresh token** and gets a fresh access token from it with
   `tooling.tokens.rotate` whenever it needs one. Access tokens are never stored
   past their 12 hours.

**Renaming:** admin settings → Slack → **Bot name**. AX applies it with
`apps.manifest.update`. There's no reinstall, and the bot token keeps working
(§7 Q3). The name people see changes; the @handle underneath stays as it was at
install. Slack shows mentions by current name, so people don't notice.

**The secrets:** bot token, signing secret, client secret, and the
configuration **refresh token**. All live in the credentials store, readable
only by `@ax/channel-slack`.

The refresh token is the dangerous one. It can create apps in the workspace,
and it **outlives both renewal and `auth.revoke`** (§7, configuration tokens),
so AX can't retire it through the API. Hence:

- It's admin-only to set, and nobody can ever read it back.
- Admin settings shows whose token it is, since configuration tokens belong to
  one person, and lets another admin replace it.
- **Disconnect Slack** deletes the apps (which kills their bot tokens) and then
  tells the admin to click **Revoke** on Slack's configuration-tokens page. AX
  can't do that last step itself.

### Scopes (smallest set)

`app_mentions:read`, `chat:write`, `chat:write.customize` (replies show the
agent's own name and avatar), `im:history` and `im:write` (DMs), `channels:history`
(threads the bot is in), `users:read` and `users:read.email` (the identity check),
and `commands` (connecting a channel). Reading files waits until we support
them.

### Connecting a channel to a team agent

Two ways in, one stored record:

- **AX side:** agent settings → **Slack** → pick a channel.
- **Slack side:** run `/ax connect <agent>` in the channel.

Either way, the person must pass `agents:resolve` for the agent with *manage*
rights, meaning its owner or a team admin. One agent per channel. The binding
belongs to `@ax/channel-slack`. Agents get no Slack-specific fields.

## 4. Dedicated bots (phase 2)

A team agent that wants its own `@ada`:

1. The owner clicks **Request Slack bot** in agent settings and picks the name
   and avatar. AX checks Slack's name rules, and **rejects a name already used
   by its other bots in that workspace**. Slack itself allows duplicates: it
   quietly gives the second bot a suffixed handle (`axspikea2`), and in the
   spike the duplicate fooled even the person testing it (§7 Q5).
2. The workspace's AX-side Slack admins get a DM from the shared bot:
   **"Vinay wants to add @ada (Support team agent). [Approve] [Decline]"**. The
   same request shows up in AX admin settings.
3. **Approve** creates the app (`apps.manifest.create` + `apps.icon.set`) and
   opens Slack's install screen straight away. The admin's **Allow** there is
   the approval: one click, on Slack's own screen. There's no second AX-side
   approve step. Only someone who's allowed to install apps can click Allow, and
   the configuration token doesn't skip it.
4. The owner hears "@ada is live — `/invite @ada` to a channel", along with the
   bot's real handle as read back from `users.info`. Until then the agent keeps
   working through the shared app, so waiting never blocks anyone.

Everything except Allow is automatic. In the spike, Slack sent no challenge and
needed no Verify click (§7 Q1).

**Plan limit:** free Slack allows at most 10 custom or third-party apps, and
each dedicated bot is one of them. The request form shows how many are in use,
and phase 2 is really for paid workspaces.

For a dedicated bot, being invited to a channel *is* the binding: the app's id
tells us which agent it is. Disconnecting deletes the app with
`apps.manifest.delete`.

Personal agents stay on the shared app. Fifty personal bots cluttering the
workspace would buy nothing: a personal agent only talks to one person, in a DM.

## 5. How a turn runs

1. **Incoming events.** Each request arrives at `POST /slack/events/<installId>`.
   `installId` is an opaque id we choose; the route never sees the Slack team or
   app id. Then:
   - Check the v0 signature over the raw body (`req.body: Buffer`), and reject
     requests older than 5 minutes.
   - Answer the `url_verification` challenge, if one ever comes: the spike saw
     none (§7 Q1).
   - Reply 200 within 3 seconds and run the turn afterwards.
   - Ignore retries we've already seen (`event_id`).
   - Ignore our own bot's messages.

   The signature check follows the pattern in `routines/src/webhook-signature.ts`,
   copied rather than imported (no cross-plugin imports).
2. **Admit.** Run the checks in §1.2 and §1.6, and choose the agent and the
   attended or external mode from §2.
3. **Conversation.** `conversations:find-or-create` with the key
   `slack:<installId>:<channel>:<thread_ts>`. One Slack thread is one
   conversation, owned by the agent's owner, and the owner can read it in the
   web app.
4. **Invoke.** `agent:invoke` with the context from step 2.
5. **Reply.** Subscribe to `chat:stream-chunk`, `chat:phase`, `chat:turn-end`,
   `chat:turn-error` and `chat:permission-request` filtered by `reqId`, the way
   channel-web does (`channel-web/src/server/plugin.ts:807-857`). Then:
   - Stream into the thread with `chat.startStream` / `appendStream` /
     `stopStream`. They work in channel threads (pass `recipient_user_id` and
     `recipient_team_id`) and need only `chat:write`. A stream lasts at most
     10 minutes, the same as our default chat timeout, so a turn still running
     at 10 minutes falls back to throttled `chat.update` (Tier 3, about
     50 a minute).
   - Convert Markdown to mrkdwn and split long replies.
   - Collapse tool calls into one status line, matching the web's #1156.
   - Artifacts and charts become a link to the web app.
6. **Approvals.**
   - **Attended:** Block Kit buttons. The interactivity route checks the clicker
     is the turn's person, then calls `agent:apply-capability-grant`, the same
     hook `/api/chat/permission-decision` uses (`routes-chat.ts:825`).
   - **External:** a "waiting for my owner" note, and the call waits in Today.

## 6. Hooks, and the boundary review

**`ctx.source` gains `'external'`** (`packages/core/src/context.ts:226`). This is
the most important change in the design. Code that tests
`source === 'routine'` has been treating "not a routine" as "the owner is
here". The real surface is wider than a list of packages:

- the session, IPC and sandbox chain, whose enums rejected `'external'` and
  whose schemas would have dropped `audience`
- the orchestrator (attended turns, slice 6 connector skips, warm-session reuse)
- the identity tools and `skill.propose`
- decisions' attendance, and memory's conversation attribution
- the routines gates, which already refuse non-routine turns

decisions and conversations only mention `source` in comments (decisions has
used conversation origin since 2026-08-21). The full audit table lives in
`docs/plans/2026-11-12-task-1091-ctx-external-audience-plan.md`. Each consumer
needs an explicit answer for `'external'`, plus a test.

- **Alternate implementation:** any channel where the person present isn't the
  agent's owner, such as email-in or a public web widget.
- **Leaky field names:** none. The value says who is present, not which
  transport.
- **Subscriber risk:** a subscriber that branches on `=== 'routine'` would now
  treat external turns as attended. That is exactly what the audit is for.

**`ctx.audience: 'private' | 'shared'`** is a new context field (§2a). It's
separate from `source` on purpose: `source` says who is present and decides
approvals; `audience` says who sees the reply and decides memory.

- It's absent everywhere it isn't set, and absent means `private`, as today.
- Memory stamps each statement with the audience it was captured in.
- A `shared` turn recalls only `shared` statements and captures no facts about
  the speaker.
- Memory reads go through one wrapper that adds the filter last. It throws if a
  shared read returns a row not stamped shared, so an engine that ignores the
  filter fails loudly.
- Audience must be constant per conversation, because extraction batches turns
  under the latest turn's context. TASK-1094 keys conversations so.
- **Alternate implementation:** any channel with more than one reader, such as a
  mailing list or a shared web room.
- **Leaky field names:** none. It describes the readers, not the transport.
- **Subscriber risk:** a reader that ignores the field gets today's behavior,
  which leaks in exactly the case this field exists for. So memory's recall
  **must** branch on it, and a test pins that.

**Finding a user by verified email** is a new service hook on the auth plugin,
`auth:find-user-by-email`: `{ email } → { userId } | null` (TASK-1092).
Attended channel turns (§2) and personal-agent DMs need it.

- **Rules:** the match is ASCII case-insensitive and otherwise exact, and an
  address with any non-ASCII character matches nobody (no Unicode lookalikes).
  Only verified accounts count, and only on an approved domain (a blank list
  means any domain). Accounts that differ only in case match nobody. `null`
  never says why.
- **Alternate implementation:** an OIDC or SCIM directory.
- **Leaky field names:** none.
- **Risk:** it can be used to check whether someone has an AX account. Keep it
  internal to the host, never an IPC action, and return only the id. An
  ipc-core test pins that no runner action reaches an `auth:` hook. Callers
  pass only an email they fetched from the identity provider themselves.
- **Open for TASK-1094:** it says nothing about company members who have no AX
  account, and channel-slack can't read the approved domains. Admitting them as
  external (§2) needs that answer from auth. Add it with that card. Don't copy
  the domain list into channel-slack.

**No other new hooks** (apart from the open question above).
`@ax/channel-slack` uses existing hooks, like channel-web and routines do. It
registers routes and subscribes to chat events.

**Security:** the `security-checklist` walk is required. This opens a new path
for untrusted input (anyone in a channel) into an agent that has its owner's
connectors. The protections are:

- Dedicated agents only in channels.
- Turns from people without access run as external, with approvals held for the
  owner.
- No Slack Connect channels.
- The identity check reads Slack's API, never the message.
- Secrets are readable only by this plugin.

## 7. Spike results (TASK-1090, 2026-11-12)

Run against the real Canopy workspace by Vinay, a workspace admin, using two
throwaway apps (`ax-spike-a`, `ax-spike-b`) behind a temporary tunnel. Both apps
were deleted afterwards, the bot tokens confirmed dead (`account_inactive`),
and the configuration token revoked. "Tested" means we watched it happen;
"docs" means only Slack's documentation says so.

| # | Question | Answer | Source |
|---|---|---|---|
| 1 | Does the event URL need verifying? | **No.** Neither `apps.manifest.create` nor `apps.manifest.update` sent a `url_verification` challenge. A DM to the installed bot arrived as a signed `event_callback` (`message`, `channel_type: im`) with no Verify click. The manifest docs say the URL must be "manually verified"; in practice it wasn't needed. | Tested |
| 2 | Avatar by API? | **Yes.** `apps.icon.set` with the configuration token and a PNG returned `ok`. | Tested |
| 3 | Rename | `apps.manifest.update` changing only the name: `permissions_updated: false`, no reinstall, and the bot token kept working. `real_name` changed; the @handle (`name`) **stayed as it was at install**. | Tested |
| 3 | Name rules | Accepted: ASCII letters, digits, spaces, `-`, `_`, `.`, and long names. Rejected by `apps.manifest.validate`: reserved words (`slackbot`, `here`, `channel`, `everyone` → `invalid_reserved_word`), non-ASCII (`Café` → `bad_username`), and other symbols (`!!` → `invalid_name_specials`). The handle drops hyphens: `ax-spike-a` became `axspikea`. Docs: at most 21 characters for the handle, 35 for the app name, 80 for the bot's display name. | Tested + docs |
| 4 | App approval | An admin installing a manifest-created app saw only Slack's normal Allow screen: no request, no wait. Slack's approval API (`admin.apps.approve`) is Enterprise-only. **Not seen:** what a regular member gets; the docs say members can't install restricted apps. The design needs no member installs. | Tested (admin only) + docs |
| 5 | Duplicate names | **Allowed.** A second app with the same bot name installed fine and quietly got handle `axspikea2`. In the test, the person DMing picked the wrong one. So AX enforces unique names itself. | Tested |
| 6 | Streaming | `chat.startStream` / `appendStream` / `stopStream`: `chat:write`, Tier 2. Works in channel threads with `recipient_user_id` + `recipient_team_id`. A stream lasts at most 10 minutes. `chat.update` is Tier 3. Decision: streaming API, falling back to `chat.update` after 10 minutes (§5). | Docs |
| 7 | Socket Mode / kind | The create response holds `client_id`, `client_secret`, `signing_secret` and `verification_token`, but **no app-level token**; that's generated only in Slack's UI. Since Q1 says HTTP events need no manual step, we don't use Socket Mode. On kind: a `cloudflared` quick tunnel works, but its URL changes on every restart, so the walk updates the app's URLs with `apps.manifest.update` (no challenge, no reinstall). | Tested + docs |
| — | Configuration tokens | Access tokens expire after 12 hours (we hit `token_expired`). `tooling.tokens.rotate` returns a new pair, and **the old refresh token and earlier access tokens keep working**. `auth.revoke` kills an access token, but **its refresh token still mints new ones afterwards**. Only Revoke on Slack's configuration-tokens page ends it (§3). | Tested |
| — | Plan limits | Free Slack: at most 10 custom or third-party apps (§4). | Docs |

## 8. Open questions

1. ~~**Memory on external turns.**~~ **Decided 2026-11-12 (Vinay):** decide by
   who sees the reply. See §2a.
2. **Choosing a personal agent.** Recommendation: the default is the owner's
   personal agent, and a slash command can switch to another.
3. **Who counts as a Slack admin for phase 2 approvals?** Recommendation: the
   person who connected the workspace, plus admins added in AX settings,
   following Slack's `is_admin` if it turns out to be reliable.
4. **Telling the owner what goes to Slack.** Slack keeps a copy of everything
   the agent says, including in DMs, under its retention and export rules. And
   whoever controls a Slack session controls that person's personal agent.
   Recommendation: say this once when the owner first connects. Also confirm
   the workspace enforces Google SSO, since without it the bar is a Slack
   password.

## 9. Delivery

**Phase 1: shared app**

- **0. Spike** on the §7 questions (TASK-1090). **Done 2026-11-12.**
- **1. `ctx.source: 'external'` + `ctx.audience`** (TASK-1091): the audit of every
  `source` consumer, plus memory's audience stamping, recall filter and
  speaker rule (§2a, §6). Has a boundary review. Merges as one stack
  with TASK-1094, the first card that produces `'external'` and `'shared'`.
  Must land before anything is switched on.
- **2. Find a user by verified email** (auth service hook). Has a boundary
  review.
- **3. `@ax/channel-slack`: connect a workspace and DM a personal agent.** Covers:
  - admin Connect Slack, using the branding name as the default bot name
  - the events route and identity checks
  - personal-agent DMs with streamed replies
  - presets, canary acceptance test, and Helm secrets

  Depends on 1 and 2.
- **4. Channels:** connecting a channel to a team agent (AX side and slash
  command), attended or external turns, and the "waiting for my owner" note.
  Depends on 3.
- **5. Approval buttons** for attended turns. Depends on 3.
- **6. Bot rename** in admin settings. Depends on 3.
- **7. Walk (walk):** phase 1 end to end on kind. Depends on 3–6.

**Phase 2: dedicated bots**

- **8.** Request a bot, the admin approval DM and its AX twin, creating and
  installing the app, routing by app id, and delete on disconnect.
- **9. Walk (walk).**
