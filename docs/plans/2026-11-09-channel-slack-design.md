# Slack channel (design)

**Status:** proposed 2026-11-09.
**Owner:** Vinay · **Started:** 2026-11-09 · **Code cited at:** `5474a59c9` (main)

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
   deactivated) with a verified `@<approved domain>` email. That's the same
   domain AX's Google sign-in allows. We fetch the email ourselves through
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
   admin approves with one click (phase 2).
8. **The shared app's name defaults to the AX instance's name.** We take it from
   `branding:get` and turn it into a valid handle, falling back to `ax`. The
   admin can change it when connecting the workspace and rename it later.

## 2. Who is talking, and what they can do

| Where | Agent | Who can use it | Turn runs as |
|---|---|---|---|
| 1:1 DM with the shared bot | Sender's personal agent | Only its owner | Owner, **attended** (`ctx.source: 'user'`) |
| Public channel connected to an agent | That team agent | Any full company member | **Attended** if the sender is an AX user who passes `agents:resolve` for the agent; otherwise **external** (`ctx.source: 'external'`) |
| Group DM, Slack Connect channel, guest, bot, other domain | — | No one | Ignored, or a short private refusal |

**Attended** means it works like the web chat: permission requests show up as
buttons, and only the person whose turn it is can click them.

**External** means the agent's owner isn't there. The turn runs in the owner's
`ctx` (routines do the same, `packages/routines/src/fire.ts:267`). Connector
calls that need approval wait for the owner in Today. The bot says in the thread
that it's waiting for its owner. No identity edits are allowed.

The Slack sender's name and ID go into the message *content*, for example
`[Slack · #support · Alice (U123)]: …`. That label is untrusted text the model
reads. Nothing ever treats it as permission to do something.

## 3. The shared app (phase 1)

### Connecting a workspace (Slack admin, once)

1. In AX admin settings, **Connect Slack** shows a short guide and a link to the
   Slack page where the admin creates an **app configuration token**. That page
   is the one step Slack doesn't let us automate: no OAuth flow hands out that
   token.
2. The admin pastes the token and confirms the bot's name. The name defaults to
   the branding name in handle form, otherwise `ax`.
3. AX creates the shared app with `apps.manifest.create`. The manifest sets the
   name, avatar (the branding logo, if Slack lets us set it — see §7), scopes,
   and the event and interactivity URLs.
4. The admin is sent to Slack's install screen and clicks **Allow**. AX stores
   the bot token.
5. AX stores the configuration token's refresh token and renews it with
   `tooling.tokens.rotate`.

**Renaming:** admin settings → Slack → **Bot name**. AX applies it with
`apps.manifest.update`. We need to confirm in the spike that a rename alone
doesn't force a reinstall (§7).

**The secrets:** bot token, signing secret, client secret, and the
configuration token. All live in the credentials store, readable only by
`@ax/channel-slack`. The configuration token can create apps in the workspace,
so it is admin-only to set, and nobody can ever read it back.

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
   and avatar. AX rejects a name already used by its other bots in that
   workspace.
2. The workspace's AX-side Slack admins get a DM from the shared bot:
   **"Vinay wants to add @ada (Support team agent). [Approve] [Decline]"**. The
   same request shows up in AX admin settings.
3. **Approve:** AX creates the app with the configuration token, and the admin
   clicks **Allow** on Slack's install screen. Only someone who's allowed to
   install apps can grant that, and the configuration token doesn't skip it.
4. The owner hears "@ada is live — `/invite @ada` to a channel". Until then the
   agent keeps working through the shared app, so waiting never blocks anyone.

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
   - Answer the `url_verification` challenge.
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
   - Stream into the thread with throttled `chat.update`, about once a second
     (Slack's rate limit), or Slack's streaming-message API if the spike finds
     it fits.
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
the most important change in the design. The 8 packages that test
`source === 'routine'` have been treating "not a routine" as "the owner is
here":

- `chat-orchestrator`
- `decisions` (`attendance.ts`, `pre-call.ts`, `plugin.ts`)
- `memory` (`plugin.ts`, `conversation.ts`)
- `conversations`
- `agents/identity/tools`

Each one needs an explicit answer for `'external'`, plus a test.

- **Alternate implementation:** any channel where the person present isn't the
  agent's owner, such as email-in or a public web widget.
- **Leaky field names:** none. The value says who is present, not which
  transport.
- **Subscriber risk:** a subscriber that branches on `=== 'routine'` would now
  treat external turns as attended. That is exactly what the audit is for.

**Finding a user by verified email** is a new service hook on the auth plugin
(for example `auth:find-user-by-email`). Tier-3 attended turns and personal-agent
DMs need it.

- **Alternate implementation:** an OIDC or SCIM directory.
- **Leaky field names:** none.
- **Risk:** it can be used to check whether someone has an AX account. Keep it
  internal to the host, never an IPC action, and return only the id.

**No other new hooks.** `@ax/channel-slack` uses existing hooks, like
channel-web and routines do. It registers routes and subscribes to chat events.

**Security:** the `security-checklist` walk is required. This opens a new path
for untrusted input (anyone in a channel) into an agent that has its owner's
connectors. The protections are:

- Dedicated agents only in channels.
- Turns from people without access run as external, with approvals held for the
  owner.
- No Slack Connect channels.
- The identity check reads Slack's API, never the message.
- Secrets are readable only by this plugin.

## 7. Spike first (TASK card 0)

These shape the design, and I haven't verified them against Slack's current
API:

1. Does `apps.manifest.create` check the event URL right away, before we've
   stored the signing secret it returns? If so, how do we accept that first
   challenge safely?
2. Can the avatar be set through the API, or only uploaded by hand?
3. Does renaming the bot with `apps.manifest.update` force a reinstall? Does the
   @handle change along with the display name?
4. With Slack's app-approval queue turned on, does a manifest-created app wait
   in that queue as well? If so, phase 2 should send admins to Slack's queue
   instead of building our own.
5. Does Slack reject a bot @name that's already taken in the workspace?
6. Streaming: throttled `chat.update`, or Slack's streaming-message API?
7. Local dev on kind: Socket Mode, or a tunnel?

## 8. Open questions

1. **Memory on external turns.** Should a channel agent recall what it learned
   in other conversations, and should it learn from a channel conversation at
   all? Recommendation: a channel agent's memory comes only from its own Slack
   threads, and it gets no recall from the owner's other chats.
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

- **0. Spike** on the §7 questions. Memory only, no product code.
- **1. `ctx.source: 'external'`** plus the audit of all 8 consumers (§6). Has a
  boundary review. Must merge before anything is switched on.
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
