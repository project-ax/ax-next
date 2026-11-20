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
   domains come from AX's sign-in settings: the *Allowed email domains* lists
   of the Google and GitHub sign-in providers. An email on any non-blank list
   counts; a blank list adds nothing; with no list at all, any domain counts,
   as at sign-in. It isn't exactly sign-in's rule (since TASK-1116 each
   provider enforces only its own list), and differs both ways: a disabled
   provider's list still counts, and a blank list never opens the others. We
   fetch the email ourselves through
   `users.info`. Anything in the message text is ignored for identity.
3. **A company email doesn't get you someone else's agent.** Being an employee
   is about the same bar as signing up for AX (§1.2 has the differences). AX still runs `agents:resolve` so one
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
owner. An external turn can change nothing the agent later reads as its own:
no identity edits, skill authoring, connector requests, routine or task
changes, published artifacts or charts, or catalog requests, and the agent's
files are read-only in it (TASK-1122). The tools it can't use are hidden from
it. The write-path audit is in
`docs/plans/2026-11-17-task-1122-outsider-persist-audit-plan.md`.

The Slack sender's name and ID go into the message *content*, for example
`[Slack · #support · Alice (U123)]: …`. In a 1:1 DM (TASK-1093) it reads
`[Slack · DM · Alice (U123)]: <text>`: the sender's Slack display name (else
their real name), with brackets and parentheses removed so a name can't close
the label early. `<text>` is the message as its sender typed it: Slack's
`&amp;`, `&lt;` and `&gt;` escaping is undone, and nothing else (a `<@U…>` or
`<url|label>` reference stays as Slack wrote it). That label is untrusted text
the model reads. Nothing ever treats it as permission to do something.

The agent is told what the label means once per session, in its system prompt
(TASK-1131, `turn-note.ts`). The words after the label are that person's own
request, and anything they paste or quote stays data. It also says who can
approve: in a DM, the owner; in a member's thread, that member; in an
outsider's thread, nobody writing: a call the host holds waits for the owner,
so the agent says it needs its owner's OK and never sends them looking for a
card or a button, and it still checks with them before it acts. The note is fixed text
chosen by the turn's mode. Nothing from the message, the name or the channel
goes into it.

**Mention-only.** In a channel the bot answers a message that mentions it, and
nothing else: a follow-up in the same thread needs a new mention. A bare
`@bot` with no other text runs no turn. A reply can't broadcast: `@channel`,
`@here` or `@everyone` in the agent's text gets a zero-width space after the
`@`, whatever comes before it (so an address on such a domain,
`me@channel.com`, gets an invisible one too: a letter before the `@` can
vanish at a message edge or in a decoder, so it exempts nothing), and so
does the `&` of an HTML character reference that could decode into a
mention's characters (`&#64;channel`, `&commat;here`, `&lt;!everyone&gt;`,
`<&excl;channel>`: any numeric one, and the only HTML names that decode to
`<`, `@`, `!` or `#`: `&lt;`, `&nvlt;`, `&commat;`, `&excl;`, `&num;`, plus
`&lt` without its `;`) and a `<` before an `&`. Every other `&` is left
alone: code (`let r = &s;`), prose entities (`&rarr;`, `&copy;`) and a
link's query string (`&page=2`) can't decode into a mention, and a mark
would break them. Both are held back across
chunk and edit boundaries, and each stream append is judged on its own, so a
split can't sneak one through. A user-group handle such as `@engineering` is
left alone, and may notify that whole group (§6, known gaps).

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
| **Capture** | As today, stamped `private` | Stamped `shared`; in a Slack channel, only what members say (below) |
| **Facts about the speaker** | As today | **Not captured.** Only facts about the work: projects, decisions, processes, who owns what. |

Knowledge flows one way: shared → private, never back. What the agent learned
in #support can be recalled anywhere. What someone said privately is never
recalled in a channel.

- The owner's memory view labels shared statements so they can be deleted. It
  says "Shared" for now. Naming the channel ("learned in #support") is not done
  by TASK-1094: memory never sees a channel name, and showing one needs memory
  to expose where a statement came from. A later card.
- A shared session gets no `/memory` file view. The export holds every fact the
  agent has, so it would walk around the recall filter.
- The speaker rule is a filter, not a prompt change. In a shared turn, a
  statement is dropped when its subject is `user`, starts with `user:`, or is
  made of the speakers' label names (TASK-1146). The observer, `memory_note`
  and the write door ask one function (`breaksSpeakerRule`, TASK-1136), and a
  refused note tells the agent to save a work fact with the work as `about`.
  The TASK-1134 walk is why the rule exists: the extractor read the sender
  label and filed `vinay | stated_standup_time | Team standup moved to 10:15
  on Tuesdays` as a shared row.
- How memory learns the names: channel-slack records each member's label name
  and Slack ID on the thread's row before their turn runs, and hands them over
  with its `memory:pre-capture` answer. Outsiders' threads record none, since
  memory never learns from them.
- What counts as a name: a subject whose words are all words of those names
  (`vinay`, `vinay_pulim`, `uhte83xe1`). So `vinays_team`, `team_standup` and
  `team_standup | owner | vinay` are kept: the rule reads the subject, never
  the value. The extractor's own word for the speaker is set aside beside a
  name, so `user_vinay` and `user_vinaypulim` drop too. A subject over 1024
  code units is dropped unread, since the engines refuse one that long anyway
  and reading it costs host time its writer picks.
- Known gaps, accepted:
  - Someone named only in what's said ("Ada is out next week") is still
    stored. Telling a person from a thing would need the pinned extraction
    prompt.
  - Names the label doesn't show are missed: nicknames and initials (`vp`,
    `vinay_p`), titles (`mr_pulim`), role words other than `user`
    (`speaker_vinay`, `member_vinay`), the speaker word run into a name
    (`uservinay`), transliterations, digits added to a name
    (`vinay2`). The run-together rule works inside one name only, so
    `pulimvinay` (the other order) is missed, and so is `vinaypulim` when the
    label gives "Vinay" and "Pulim" as separate entries.
  - A work subject made of a display name's words ("Standup Team") drops
    `team_standup`. We'd rather lose one fact than pin someone's words on a
    person.
  - A thread row keeps only the 16 most recently seen names. Sixteen newer
    names (eight other members, or one member renaming fifteen times) push out
    an earlier speaker's, and a pass that still covers that speaker's turns
    then keeps facts under their name. A default pass covers four turns, so
    this is normally out of reach.
  - Thread rows keep members' label names until the agent is deleted. We don't
    clear them when a channel is disconnected or a conversation is deleted.
    They're display names and Slack IDs, read only by the veto, and the row
    already outlives the conversation.
  - The rule stops new rows, not old ones. A shared row saved under a member's
    name before this shipped stays until someone deletes it: the TASK-1134
    walk's `vinay | stated_standup_time` on kind, and whatever prod's channels
    stored since Slack shipped there (rev86). A cleanup is a follow-up:
    count the shared rows whose `about` matches the names now on their
    conversation's thread row, then retract them through the forget path.
  - Closing a slot is tenant-wide, so a private statement can close a shared
    one. A Fix on a shared memory saves as private.
- **What outsiders say is never remembered.** An external turn's conversation
  (the connector's, key suffix `:external`) is refused by channel-slack's
  capture veto whatever the switch says, and so is the agent's own
  `memory_note` in it. The switch decides only for attended turns: what
  people who can use the agent say. Why: integrity, not privacy. A team
  agent recalls shared memory in every turn, members' private web chats
  included, with full attended authority, so an outsider's words captured
  as a shared statement would come back later as a fact in the most trusted
  context: a lasting prompt-injection path from the least-trusted speaker.
  Privacy is the audience rule's job, and it holds either way. Reversible:
  it is one rule in channel-slack's `capture-veto.ts` (TASK-1094 PR B review
  F1, a product call flagged for Vinay).
- Each connected channel has a "Let the agent remember this channel" switch,
  on by default, for what members say. It works through `memory:pre-capture`,
  so it also stops `memory_note`. It is read in the same statement that
  records the thread, and once a thread has had a turn while the switch was
  off, that thread stays unremembered: turning the switch back on doesn't
  capture it, and disconnecting Slack keeps that. The switch stops learning,
  not recall: the agent still recalls memory it learned elsewhere.
- **Instructions and files aren't covered by this.** A channel agent's
  instructions and files are readable in every turn. The connect screen says
  plainly that they're visible to anyone in the channel.
  An outsider's turn can read them but not change them: its session mounts
  the agent's files read-only (TASK-1122).

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
3. AX first deletes any app an earlier Disconnect or Connect couldn't
   (below), with the access token just pasted. Then it creates the shared app
   with `apps.manifest.create`, tries the pasted refresh token once (step 5),
   and uploads the bot's picture with `apps.icon.set`: the admin's browser
   draws the branding logo (with no logo and no product name, the AX mark)
   centred on a white 512 px square, and Connect sends that PNG (TASK-1133).
   Under a custom name with no logo the bot keeps Slack's default picture. If
   the refresh-token try fails in any way, AX deletes the new app again (or,
   when Slack won't let it, lists it as left over), so an install never
   starts with a token Slack won't take (TASK-1159). When Slack refused the
   refresh token itself, the admin is asked for a new pair; any other failure
   says to try again. The manifest sets the name, scopes, and the event and
   interactivity URLs. Slack sends no challenge and needs no manual Verify
   click (§7 Q1).
4. The admin is sent to Slack's install screen and clicks **Allow**. AX stores
   the bot token. This click is the only one a person must make, and only
   someone with install rights can make it.
5. AX keeps a **refresh token** and gets a fresh access token from it with
   `tooling.tokens.rotate` whenever it needs one. The first rotate is at
   Connect (step 3), so for any install connected since TASK-1159 the one AX
   keeps is never the one pasted. Each rotate
   also hands back a new refresh token, and Slack retires the old one within
   minutes to hours (§7, configuration tokens), so AX stores the new one
   before it uses the access token (TASK-1129). Access tokens are never stored
   past their 12 hours.

**Renaming:** Admin › Slack → **Rename** (TASK-1096), once Slack is connected.
AX checks the name (§7 Q3) and applies it with `apps.manifest.update`, using an
access token minted from the stored refresh token. Slack replaces the whole
manifest on update, so AX sends all of it as this build makes it, with only the
name changed. There's no reinstall, and the bot token keeps working (§7 Q3). People
see, and @mention, the bot by its new name: on the TASK-1097 walk,
`@ax` became `@ax-walk`. If the stored
token can't be used (Slack refuses it, or its owner can't manage the app), the tab says so and the fix is **Replace** (below), which keeps every channel connected. If the Slack app was deleted on Slack's side, the fix is Disconnect, then Connect again.

**Replacing the token:** Admin › Slack → **Replace**, next to who added the configuration token (TASK-1128), once Slack is connected. The admin pastes one value, a refresh token, from someone who can manage this Slack app. AX tries it once (`tooling.tokens.rotate`) and sends the app's whole manifest with the access token that rotate minted (`apps.manifest.update`, as Rename does). Slack taking it shows that the token's owner can manage this app. Only then does AX store the minted refresh token in place of the old one and record who added it and when. The install, its channels, the bot token and the other secrets stay as they are, and if any step before the store fails, the old token stays. AX never reads or rotates the old token here, so it keeps working on Slack until whoever generated it revokes it, and the tab says so. Like Rename, Replace sends this build's manifest, so it also syncs the app to it: a hand edit on api.slack.com is overwritten, and a scope a later build adds would make Slack ask for the app to be reinstalled. A replace also tries again to delete any Slack apps listed as left over. **Measured (§8 Q5): only the app creator's own token passes the check.** Another person's token is refused even when they are a collaborator on the app, so "someone who can manage this Slack app" in practice means the person who created it, with a newer token of theirs.

**The secrets:** bot token, signing secret, client secret, and the
configuration **refresh token**. All live in the credentials store, readable
only by `@ax/channel-slack`.

The refresh token is the dangerous one. It can create apps in the workspace.
Renewing it only trades it for a new one, and it **outlives `auth.revoke`**
(§7, configuration tokens), so AX can't retire it through the API. Hence:

- It's admin-only to set, and nobody can ever read it back.
- Admin settings shows who added the token and when (an AX admin; configuration tokens
  belong to one person). The token AX holds changes with every rotate whose new token it manages to save (step 5), and with **Replace** (above), which also changes who added it and when.
- **Disconnect Slack** deletes the apps (which kills their bot tokens) and then
  tells whoever generated the token to click **Revoke** on Slack's configuration-tokens page. AX
  can't do that last step itself. Whether that Revoke also ends the refresh
  tokens rotates have minted since (the one AX holds, from Connect or the latest Replace on) is
  unmeasured: the TASK-1134 walk revoked right after a reconnect, before any
  rename, so the token it revoked was most likely the pasted one.
  Deleting the app needs the stored token, so a dead or revoked one (or
  Slack not answering) leaves the app on Slack. Disconnect still removes the
  install, but keeps the app's id and name (TASK-1132): the Slack tab names
  it in every state, linked to its own settings page, and the next Connect or Replace
  tries to delete it with a fresh access token (the one pasted at Connect, or the one Replace's rotate minted). Connect keeps one
  the same way when it can't take back the app it just made (step 3). The name stays
  until a Connect or Replace deletes it or the admin clicks **I deleted it** after
  deleting it by hand. Cancelling an unfinished install is the same
  Disconnect. Whether a new token can delete an app an earlier token of the
  same person made is unmeasured.

### Scopes (smallest set)

Nine bot scopes, each for one job:

- `app_mentions:read`: hear an @mention in a channel.
- `chat:write`: reply in the thread.
- `im:history`: read a DM sent to the bot.
- `reactions:write`: put a 👀 on a message while the agent works on it.
- `users:read` and `users:read.email`: the identity check (who is this, and is
  that email an AX account).
- `channels:read`: look up a channel's flags and list the public ones to pick
  from (TASK-1094).
- `channels:join`: the bot joins the public channel itself at connect, so
  nobody has to invite it (TASK-1094).
- `commands`: the `/ax` slash command (TASK-1094).

Events stay `app_mention` and `message.im`; the App Home messages tab is on
(without it nobody can DM the app). Interactivity is on (TASK-1095): the
manifest carries one more URL, `<origin>/slack/interactions/<installId>`, where
Slack sends a click on an Allow or Deny button. It needs no new scope. An
install made before TASK-1095 has no such URL, so it reconnects to get one
(Disconnect, then Connect); until then its prompts still carry the Today link
(a host prompt has none: see §5.6). Saving the bot's
name (TASK-1096) also sends the whole current manifest, so it should bring that
URL to an older install without a reconnect. That isn't measured yet; the
TASK-1097 walk checks it.

Two scopes are deliberately **not** requested. `channels:history`: a channel
is mention-only, so a follow-up in a thread needs an @mention again and the
bot never reads anything it wasn't addressed in. `chat:write.customize`: a
streamed reply can't carry a custom name or avatar; phase-2 bots carry their
own. Reading files waits until we support them.

TASK-1093 (DMs) shipped the first six scopes and no slash commands. TASK-1094
adds the last three. An existing install has none of them, so it reconnects:
Disconnect, then Connect, in Admin › Slack.

### Connecting a channel to a team agent

Two ways in, one stored record:

- **AX side:** agent settings → **Slack** → pick a channel.
- **Slack side:** run `/ax connect <agent name>` in the channel; `/ax
  disconnect` undoes it.

Rules, the same on both sides:

- **Who may:** a team admin of the agent's team
  (`agents:can-set-shared-credential`, always asked with `isAdmin: false`).
  Workspace admins don't count. A personal agent can't be connected. A person
  who can't see the agent is told nothing about it.
- **The channel:** public only. Private, archived and Slack Connect channels
  (including a pending one) are refused. The bot joins the channel itself, after
  those checks pass.
- **Shape:** one agent per channel; one agent may serve several channels. The
  binding belongs to `@ax/channel-slack`; agents get no Slack-specific fields.
- **Reconnecting** a connected channel (by another team admin) takes over as
  the run-as person and keeps the remember setting.
- **Disconnecting:** an agent that no longer exists is cleared by anyone
  admitted; a live one only by a team admin.
- **Which install:** `/ax` acts on the install that signed the request.
- **Admin › Slack › Disconnect** (and a reset) removes every channel
  connection with the install, so channels are connected again after Slack is.

## 4. Dedicated bots (phase 2)

A team agent that wants its own `@ada`:

1. The owner clicks **Request Slack bot** in agent settings and picks the name
   and avatar. AX checks Slack's name rules, and **rejects a name already used
   by its other bots in that workspace**. Slack itself allows duplicates: it
   quietly gives the second bot a suffixed `name` field (`axspikea2`), and in the
   spike the duplicate fooled even the person testing it (§7 Q5).
2. **Who approves (decided 2026-11-18, Vinay): the agent's owner, or else an AX
   admin.** If the owner can install apps in the Slack workspace, they approve
   it themselves: the request goes straight to step 3 with them as the approver.
   If they can't, it goes to the AX admins as a DM from the shared bot,
   **"Vinay wants to add @ada (Support team agent). [Approve] [Decline]"**, and
   the same request shows up in AX admin settings. Either way, Slack's own
   install screen still decides in the end: only someone allowed to install
   apps there can click Allow.
3. **Approve** asks the approver for **their own** configuration refresh
   token (decided 2026-11-19, Vinay: §8 Q6), tries it once as Connect does
   (TASK-1159), creates the app with it (`apps.manifest.create` +
   `apps.icon.set`) and opens Slack's install screen straight away. The
   approver's **Allow** there is the approval: one click, on Slack's own
   screen. There's no second AX-side approve step, and the configuration token
   doesn't skip it. Each bot records its approver as its manager. **AX keeps
   one rotating configuration token per person** (decided 2026-11-20, Vinay;
   TASK-1175), not one per bot: Slack allows one configuration token per person
   per workspace, and revoking it also kills AX's rotated copy, so per-bot
   tokens would make a second approval break the first. An approver whose
   stored token is live pastes nothing: approving uses it.
4. The owner hears "@ada is live — `/invite @ada` to a channel", along with the
   bot's real `name` field as read back from `users.info`. Until then the agent keeps
   working through the shared app, so waiting never blocks anyone.

Everything except Allow is automatic. In the spike, Slack sent no challenge and
needed no Verify click (§7 Q1).

**Plan limit:** free Slack allows at most 10 custom or third-party apps, and
each dedicated bot is one of them. The request form shows how many are in use.
Canopy's workspace is on a paid plan (confirmed 2026-11-18), so this is a line
on the form, not a design constraint.

For a dedicated bot, being invited to a channel *is* the binding: the install
tells us which agent it is.

**Events URL (decided 2026-11-18).** Each dedicated bot is its own install, with
its own events URL, `POST /slack/events/<installId>` (§5), and its own signing
secret. The id in the URL picks which signing secret to check, and nothing else:
an unknown id gets the same answer as a bad signature. After the signature
passes, the body's `api_app_id` must match the app stored for that install, or
the request is dropped. The id stays an opaque one we choose, not Slack's app id
or name, so the route still never handles a Slack id before the signature check.

**Channels it was already in (decided 2026-11-18).** When an agent gets its own
bot, any channel already connected to it through the shared app stays
connected, but the agent answers only its new `@ada` handle from then on.
Mentioning the shared `@ax` there no longer reaches it, although other agents
on the shared app in that channel carry on as before. So two bots can't both
answer for one agent. The owner is told which channels changed, and that
`/invite @ada` is needed in each one before `@ada` can hear anything there.

**Lifecycle (decided 2026-11-18).**
- **Deleting the agent, or its team, deletes the bot** (`apps.manifest.delete`),
  through the same path as Disconnect. An app that can't be deleted goes on the
  leftover-apps list (TASK-1132).
- **The owner can rename the bot or change its avatar later** from agent
  settings (`apps.manifest.update` + `apps.icon.set`). That's the same rename
  path the shared bot uses (TASK-1096), and the same name check from step 1
  applies. Neither needs a new approval.
- **Disconnect** deletes the app with `apps.manifest.delete`.
- **Only the approver can manage the bot** (measured, §8 Q5): rename, avatar,
  re-sync and delete all use the approver's stored token (one per person, step
  3). When it dies, the fix is Replace with a new token **from the same
  approver**, which fixes every app of theirs at once
  (TASK-1128's flow, per bot). If the approver is gone, no other token can
  touch the app: the bot can only be **rebuilt**, meaning a new request,
  approved under the new approver's token, with a new app and a new handle that
  channels must `/invite` again. The old app goes on the leftover-apps list for
  someone to delete by hand on api.slack.com. Admin settings shows each bot's
  approver, so an offboarding admin can see which bots need rebuilding.

**More phase 2 decisions (2026-11-19, Vinay, from decomposing it into TASK-1167..1174).**
- An outsider's turn in a dedicated bot's channel runs as **the bot's
  requester**, the team admin who asked for it (2026-11-20; a team agent's owner
  is the team, not a person). If the requester is no longer an admin of that
  team, outsider turns are refused politely, members' turns still work, and the
  bot shows "needs a team admin to claim it" until one does.
- **Dedicated bots are channels only:** no DM scopes, and the Messages tab is
  off. DMs would be unwatched, would leak into team memory, and would have no
  one suitable to approve held actions. Adding DM scopes later would make Slack
  ask for every bot to be approved again, so this is a deliberate choice, not a
  deferral.
- **Self-approve is the owner's pick:** "I can install apps in Slack" (they
  paste their own configuration token) or "Ask an AX admin". No Slack API we
  hold can tell who may install apps, so Slack's Allow screen still decides.
- **Disconnecting or resetting the shared bot leaves dedicated bots alone.**
- **Only a bot's approver can replace its token** (§8 Q5). AX admins don't see
  Replace on someone else's bot.
- **Deleting an agent deletes its bot** (`agents:deleted`). AX has no team
  delete yet. One that deletes the team's agents first gets this for free.

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
   `slack:<installId>:<channel>:<thread_ts>`. One Slack thread has
   one conversation per AX identity: an attended sender gets their own, and
   external turns share one owned by the person who connected the channel (key
   suffix `:external`). Why: conversations have a single owner, an outsider's
   text never enters a member's attended transcript, and `(source, audience)`
   stays constant per conversation. Each owner can read theirs in the web app.
4. **Invoke.** `agent:invoke` with the context from step 2.
5. **Reply.** Subscribe to `chat:stream-chunk`, `chat:turn-end` and
   `chat:turn-error` filtered by `reqId`, the way channel-web does (the cite is
   `channel-web/src/server/sse.ts:590-619`). There is no `chat:phase`. It also
   hears `chat:permission-request` (TASK-1095), narrowed the way channel-web
   narrows it: a **host** card (an egress-wall refusal) belongs to the turn
   whose `reqId` it names; a **skill** card (`request_capability`) carries no
   `reqId` and belongs to every turn open in the firing context's conversation.
   Any other kind is dropped. Then:
   - Stream into the thread with `chat.startStream` / `appendStream` /
     `stopStream`. They work in channel threads (pass `recipient_user_id` and
     `recipient_team_id`) and need only `chat:write`. A stream lasts at most
     10 minutes and holds at most 12,000 characters, so a long reply closes
     the stream and starts a new one in the same thread (Slack's own advice).
     If a stream call fails, the rest of the reply is posted with
     `chat.postMessage`.
   - Send the reply as Markdown (`markdown_text` chunks); Slack renders it. No
     mrkdwn conversion.
   - Collapse tool calls into one status line, matching the web's #1156 (one
     `task_update` card that changes in place). Its title is the latest thing
     the turn reported: a step summary, or a call's activity phrase ("Working"
     without one). The Claude Agent SDK's `ToolSearch` (it loads a deferred
     tool's schema) is plumbing, not a step: as in the web's step panel
     (#1140), neither that call nor its step summary touches the line
     (TASK-1130).
   - While the agent works, the owner's message wears 👀 (`reactions.add`, from
     the turn's start), taken off once the reply first shows: its stream has
     started (text, its status card, or the failure line) or its first post
     landed, and again at the turn's end in case nothing could be shown. The
     reactions run on their own queue, add then remove, which the reply never
     waits on; taking it off is one try. An add that timed out may still have
     landed, so it is taken off too. If Slack refuses the 👀 (an install from
     before `reactions:write`, say), the reply opens with the `Working` card
     instead, unless its text is already showing.
     Chosen on the kind walk (2026-11-13) over a `Working` card up front (it
     stays on every reply, and Slack can't remove a task card from a stream) and
     Slack's "is thinking…" line (`assistant.threads.setStatus`, which does work
     in plain DMs).
   - Known gap: running DM turns aren't awaited at shutdown, and Slack never
     removes a reaction by itself, so a deploy or crash mid-turn leaves that
     message's 👀 on for good.
   - Artifacts and charts become a link to the agent's page in the web app (no
     per-artifact or per-conversation page exists yet). A member's turn only:
     an outsider's turn can't publish (TASK-1122).
   - A DM turn (TASK-1093) ends at the first of: `chat:turn-end` for its
     conversation (matched the way channel-web matches it, except that a
     turn-end naming no turn ends only a turn that has begun: TASK-1095),
     `chat:turn-error`, a `terminated` invoke outcome, 60 seconds after a
     complete invoke outcome (or after the turn's last chunk, when one came
     later) with no turn-end, or a 15-minute hard cap. At the cap the turn
     itself is also stopped (`agent:interrupt`, best-effort), not only its
     reply. Up to 3 turns per conversation run or wait in order; a fourth
     message gets a "still working" reply.
6. **Approvals.** What a person sees when a call needs an OK (TASK-1095, PR A):
   - **A held call in a DM or an attended channel turn.** After the reply, the
     bot posts a prompt in the thread: the decision's own summary, **Allow** and
     **Deny** buttons, and a Today link. The summary is the only text that comes
     from outside AX's own wording, so it is cleaned and drawn as plain text.
   - **Only the asker may answer**, and every click is proved again before any
     action: the prompt is still open and was posted for this install and
     channel, and the click is on the prompt's own message (once its message
     is known); the signed click's Slack user is the person who asked; Slack
     still admits them (`users.info`); their verified email maps to the
     prompt's AX user; that user still reaches the agent; and, for a channel,
     the channel is still connected to that agent. In a channel the agent
     access must be full (`yes`); a DM also accepts a team agent the person
     can only chat with (`not-team`). Nothing is taken from the message text
     or a button label. Anyone else gets one private line ("Only the person
     who asked can answer this"). One answer per prompt: a second click while
     one is being handled is silent.
   - **Allow** calls `decisions:approve` as that user, once (no "always allow",
     no Undo). The prompt then reads what really happened (done, will be picked
     up, parked for the next ask, expired, changed, did not run). When the agent
     is woken by the approval (a warm session, after the 10-second undo window),
     the bot follows that continuation into the thread. The follower starts the
     moment `decisions:approve` returns, not after the prompt is redrawn, so
     the first words aren't missed. The Allow also binds the continuation's
     request to the conversation, as the web app's approve does (TASK-1150),
     so the host sees it running: a skill Allow during it marks the session
     instead of ending it, the idle reaper holds off, and the 15-minute cap's
     stop reaches it. If the agent never carries on in the
     thread (its session ended inside the undo window, the wake-up was
     refused, or it woke and said nothing), nothing is posted there: the
     prompt's "I'll pick it up in a moment." is redrawn with what the decision
     says by then (`decisions:get`, read the way Today's receipt reads it:
     done, waiting for the next ask, failed, and so on). **Deny** calls
     `decisions:dismiss`.
   - **An answer that takes over 30 seconds** (a slow hook) tells the asker it
     is still working and keeps the prompt taken until it lands; it is not
     retried by a second click. Other slow steps release with "try again".
   - **External turns:** no buttons, an unchanged note ("waiting for my owner"),
     and the call waits in the connector's Today.
   - **Not offered buttons:** a call identical to one already waiting reuses
     that decision, so its reply links Today instead; a bot with no prompt
     room left, or a restart (prompts live in memory), does the same.
   - **Attendance.** Decisions treats a Slack conversation (origin `'slack'`) as
     attended, like a web chat, unless it is an outsider's turn, which is
     checked first and stays unattended. Attended means an approval on a warm
     session is handed to the agent, which re-issues the call itself, instead
     of the host replaying it. A connector call approved after the session
     ended parks until the agent's next identical call (the same as in a web
     chat; the prompt says "Ask me again and I'll do it").
   - **Whose yes is spent.** A standing approval is spent only by the turn of
     the person who gave it, and never by an outsider's turn (an outsider's turn
     takes only an unattended yes). Before, any turn on the agent making the
     identical call could cash it. This is a behaviour change for web chats
     with a team agent too: a team-mate making the same call no longer spends
     someone else's approval and is asked for their own. Each person's
     approval has its own slot, so team-mates' approvals of the same call
     don't block each other.
   - **Permission cards** (TASK-1095, PR B) are two more prompts, asked after
     the reply in a DM or an attended turn and never in an outsider's turn,
     through the same click gate as a held call. At most 3 per reply, one per
     host and one per skill. They are not the held-call prompt: held calls are
     resolved by `decisions:approve` and `decisions:dismiss`, never by these.
     - **A host the sandbox was refused** ("Wants to connect to <host>"). The
       host is whatever the sandbox tried to reach, so it is shown only once it
       passes the egress proxy's own host pattern (a plain lowercase DNS name),
       and checked again before it acts. **Allow** calls `proxy:add-host` with
       exactly the prompt's session and host, as the asker; the proxy lets
       only the session's owner do it. It widens that one session's live
       allowlist and is never saved (`host-grants:grant`, "always for this
       agent", stays a web-app choice): the web app's "Just this once", so
       it reads "Allowed for now", never "for this chat" (the session ends
       when it idles, or when a skill's Allow retires it, while the chat goes
       on). A session that has ended reads "I'd already finished working on
       that". **Deny** calls nothing; the host stays refused and
       the agent asks again if it needs it. A host prompt has no Today link:
       the web app keeps host cards out of Today on purpose.
     - **A catalog skill the agent asked to use.** The card comes in the turn
       itself: tool-policy holds `request_capability` only when nobody is
       there to answer its card (TASK-1135), so an attended turn runs the call
       and its card is the one question. A card that follows a reply still
       posts its prompt. Its subject names the skill's id (so two skills with
       the same, or no, description are told apart), the hosts it will reach
       (plus one sentence when it downloads extra software), then its
       description (text its author wrote): all cleaned and drawn as plain
       text, and the prompt links Today, where the card waits too. **Allow**
       does what the web app's `/api/chat/permission-decision` does
       (`routes-chat.ts:885`), as the asker: `conversations:get` first (the
       conversation is theirs and its frozen agent is the prompt's), then
       `agent:apply-capability-grant` with the prompt's own conversation,
       user, agent and skill. It attaches the skill for that person and
       retires the conversation's warm session: at once when it's idle, or
       when a reply is still running there, once the next message arrives
       (TASK-1127). Nothing reruns the message: the reply asks them to send
       it again. **Deny** calls nothing.
       A skill that needs a key (Slack never collects one), or a bus without
       either hook, gets its subject and a link to the web app, with nothing
       to click.
     - Both show the bot's own copy for every outcome; neither calls anything
       from the message, the card's other fields or a button label.

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
What an external turn can write outside memory is audited separately, in
`docs/plans/2026-11-17-task-1122-outsider-persist-audit-plan.md`: TASK-1091
looked only at code that branches on `source`, and five write paths never did.

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

**`memory:pre-capture` can name the speakers** (TASK-1146). The answer gains
an optional `speakerNames` list, so memory can tell a person's name from a
work subject.

- A subscriber that lets memory learn from a conversation, and labels who
  wrote each message, adds names to the answer. It appends and never removes.
  Memory reads the fire's final payload. At most 32 names, each 1 to 256 code
  units; an answer that doesn't parse throws, and memory learns nothing from
  it, in a private turn too.
- channel-slack appends its own names after any an earlier subscriber added,
  each once. It refuses instead of dropping a name: `speaker-names-over-cap`
  when the list would pass 32, and `capture-payload-unreadable` when it has
  names to add and can't read what it was handed. Memory treats every refusal
  alike and logs the reason, never a name.
- **Alternate implementation:** any channel that labels who wrote each message,
  such as Teams or Discord (display names), or email-in (the From name).
  `@ax/routines` answers the same hook and adds no names.
- **Leaky field names:** none. The names are whatever the channel shows, and
  memory only compares words with them.
- **Subscriber risk:** a subscriber that drops or rewrites names an earlier one
  added would let facts under them through, hence append-only. A Slack member
  ID is just another name to memory.
- **Wire surface:** none. A host-only fire, never an IPC action.

**Finding a user by verified email** is a new service hook on the auth plugin,
`auth:find-user-by-email`: `{ email } → { userId } | null` (TASK-1092).
Attended channel turns (§2) and personal-agent DMs need it.

- **Rules:** the match is ASCII case-insensitive and otherwise exact, and an
  address with any non-ASCII character matches nobody (no Unicode lookalikes).
  Only verified accounts count, and only on an approved domain (§1.2: on any
  non-blank Google or GitHub list; no list at all means any domain).
  A disabled provider's list still counts both ways: it keeps other domains
  out and keeps its own approved. Deleting the provider removes its list from
  this lookup, so an admin who deletes the only restricted provider widens who
  Slack can map. Accounts that differ only in case match nobody.
  `null` never says why.
- **Alternate implementation:** an OIDC or SCIM directory.
- **Leaky field names:** none.
- **Risk:** it can be used to check whether someone has an AX account. Keep it
  internal to the host, never an IPC action, and return only the id. An
  ipc-core test pins that no ipc-core handler calls an `auth:` hook directly.
  That isn't everything a runner can reach: `tool:execute:` dispatches into
  host tool plugins, which can call any hook. So TASK-1093 adds a caller
  allowlist, the repo-scan test `scripts/__tests__/channel-slack-boundaries.test.js`:
  only auth-better and channel-slack may name this hook (plus three listed
  preset tests), and only channel-slack may build a `slack:` vault ref. It's a
  scan, not a runtime check: a name built at runtime gets past it. Callers
  pass only an email they fetched from the identity provider themselves.
**Approved email domains** are a second service hook on the auth plugin,
`auth:is-approved-email`: `{ email } → { approved }`. Admitting a company member
who has no AX account as external (§2) needs this answer, and channel-slack
can't read the domains itself (don't copy the list into it).

- **Rules:** same domain rule as `auth:find-user-by-email` (§1.2). Only plain
  ASCII addresses can pass. It reads no user rows and logs nothing.
- **Caller allowlist:** the same repo scan, `channel-slack-boundaries.test.js`.
- **Alternate implementation:** an OIDC or SCIM directory.
- **Leaky field names:** none.
- **Caller risk:** reading `approved` as "has an account". It says nothing of
  the sort.

**No other new hooks** (apart from `auth:is-approved-email` above, and
TASK-1095 adds none). TASK-1095 adds one more public route,
`POST /slack/interactions/<installId>`, signed like the events and `/ax`
routes (the signature, the install and the admission check run before the body
is read), and decisions' attendance now covers origin `'slack'`.
`@ax/channel-slack` uses existing hooks, like channel-web and routines do. It
registers routes, subscribes to chat events, and adds one block to the system
prompt through the existing `system-prompt:augment:optional:*` family (`…:slack`,
TASK-1131): a provider of an existing hook, not a new one. Two existing
surfaces widen:
conversations' `origin` gains `'slack'` (a Slack thread is read-only in the web
app), and `credentials:get` gains an optional `scope: 'global'` that reads only
the workspace-wide row, so a user-scoped row can't shadow an install's signing
secret.

**Security:** the `security-checklist` walk is required. This opens a new path
for untrusted input (anyone in a channel) into an agent that has its owner's
connectors. The protections are:

- Dedicated agents only in channels.
- Turns from people without access run as external, with approvals held for the
  owner.
- No Slack Connect channels.
- The identity check reads Slack's API, never the message.
- Secrets are readable only by this plugin.

**Known gaps, accepted (TASK-1095, PR A):**

- **Prompts live in memory.** A restart, or the 24-hour limit, turns a click
  into "this isn't waiting here anymore, answer it in Today". The decision
  itself is safe in Today.
- **An identical call already waiting** reuses its row, so the reply links
  Today instead of showing buttons.
- **A hold approved in the web Today** wakes the agent, but its continuation
  isn't posted to Slack (only Slack clicks are followed).
- **A late connector approval** (after the warm session ended) parks until the
  agent's next identical call, as in web chats.
- **The agent's reaction to a Deny** runs without a stream (`decisions:dismiss`
  takes no continuation id), and its turn-end names no turn. That end no
  longer ends a Slack reply whose own turn hasn't begun, and the invoke it
  answers early (chat-orchestrator resolves a session's oldest waiting invoke
  on such an end) keeps its reply open while its own turn streams. What's
  left: a message the runner folds INTO that dark reaction is answered there,
  out of Slack's sight, and its reply says it had nothing to add; and a reply
  whose invoke was answered early still ends if its own turn goes quiet for
  60 seconds. That covers a long tool call and also the wait for the turn's
  first block (the claude-sdk runner sends whole blocks only), so a first
  block slower than 60 seconds brings back "I didn't have anything to add"
  with the real answer going nowhere. And if that turn then crashes, no
  turn-error fires (its waiter is already gone), so the partial reply is
  finished as if complete. The root cause is chat-orchestrator's oldest-waiter
  fallback (`resolveWaiterFor`), filed as TASK-1126. A woken continuation has no lane slot either,
  so a message sent meanwhile may fold into it.
- **A missed continuation's redraw** needs `decisions:get`. Without it, or
  when the read fails or takes over 5 seconds, the prompt keeps "I'll pick it
  up in a moment."; it also keeps it while a host replay of the call is still
  running when the thread stops waiting.
- **A prompt answered in Today first** shows Today's answer, whichever button
  was clicked: decisions absorbs the second answer and hands back the stored
  row, so an Allow clicked after a Deny in Today reads "Denied. I won't do
  it." under the click, and a Deny after an approval reads "Allowed…".
- **A click on a prompt that isn't open any more** (answered, expired, or
  forgotten by a restart) gets its clicker a private "this isn't waiting here
  anymore" every time, from anyone, with no bound: each is a Slack call. (A
  refused clicker on an open prompt is told once per prompt.)
- **Refused clickers cost** one vault read each and, once per prompt, one
  private line.
- **A parked yes never expires.** An approval that waits for the agent's
  next identical call (`approved-pending-agent`) stands until its owner
  makes that call; it only blocks the same person's second yes for it.
- **Whether Slack auto-links** a URL in a plain-text section is unmeasured
  (unfurls are off); checked in the TASK-1097 walk. A host prompt's
  domain-shaped text is the same question.

**Known gaps, accepted (TASK-1095, PR B: permission cards):**

- **A host prompt shows the host to everyone in a connected channel.** The web
  app shows it to the person alone. The host passes the proxy's pattern, so it
  is plain text, but it is visible. A host prompt also has no Today link, so an
  install from before TASK-1095 (no interactivity URL until it reconnects) can't
  answer a host prompt anywhere; its buttons do nothing until then.
- **A click on a forgotten prompt says "it's in Today"** whatever the kind
  (a restart or the 24-hour limit leaves no kind to tailor by). For a host
  that points at nothing: the agent just asks again.
- **A skill prompt names its hosts, not its packages.** It lists the hosts the
  skill reaches before the description, plus one sentence when it downloads
  extra software (never which, like the web grant row). Allow is offered only
  when every host passes the egress proxy's `HOST_RE` and the subject names
  them whole; otherwise the subject leaves the reach out (a host is never
  shown cut) and the person gets the web link. Anything needing a key goes to
  the web app.
- **An outsider's skill request asks the owner twice in Today.** The held call
  comes first, then the card after the replay.
- **After a Slack Allow (or Deny) the skill card stays in Today.** The web
  app's buffer clears a card only on its own route, and no hook reaches it.
  Answering it there attaches again (a no-op).
- **Duplicate prompts.** A skill card goes to every turn open in its
  conversation, so a continuation's follower and the person's next turn can each
  post a prompt for the same skill; both are answerable and the second attaches
  nothing new. Two people's attended turns never share a conversation
  (conversations are keyed by user, agent and thread), so this can't ask the
  wrong person.
- **The authored-skill grant is never called.** If an agent has an authored
  draft with the catalog skill's id, the web route would activate the draft
  where Slack attaches the catalog skill the prompt described.
- **A skill Allow retires the conversation's warm session**, as the web
  app's Connect does. Since TASK-1127 it ends the session at once only when
  it's idle. While a turn is running there (a reply, one still starting up
  its sandbox, or a woken continuation), it marks the session instead, as
  `skills:proposed` does: the running reply finishes, and the next message
  restarts the session with the skill.
- **A woken continuation is bound to its conversation** (TASK-1150). The
  Allow binds its request at approve time, as channel-web's
  `bindContinuationTurn` does, and @ax/conversations clears it when the
  continuation's turn ends. That binding is how the host sees it running: a
  skill Allow marks the session instead of ending it, the idle reaper holds
  off, and the cap's stop reaches it. A wake-up that never runs (refused,
  say) leaves its request bound until the next message or the session's
  end, so the reaper holds that idle session until the runner's own
  15-minute idle floor ends it, and for 15 minutes at most: the host can't
  tell that binding from a running continuation, so past that it reaps the
  session anyway.
- **A message routed into a marked session that's still busy restarts it
  under the running turn.** Slack's lanes make that rare: it takes a reply
  that the cap or the grace period already ended while the agent kept
  going, or a message sent while a woken continuation runs.
- **One tenant can push another's prompts out.** PROMPT_MAX (1,000 open
  prompts) is shared by every install on the host, and PR B raises the
  prompts one reply can post to 4 (a held call plus up to
  PERMISSION_PROMPTS_PER_TURN_MAX permission prompts). Past the cap the
  oldest prompt nobody is answering is forgotten, so one busy workspace
  makes everyone else's open prompts expire sooner than 24 hours. A
  forgotten held-call or skill prompt still waits in Today; a forgotten
  host prompt has no fallback (the agent just asks again when it needs the
  host).

**Known gaps, accepted (TASK-1094):**

- **The switch is read when a turn starts.** A thread stays out of memory
  only once a turn STARTS while the switch is off. Turned off during a turn
  and back on before that turn's memory pass, that turn can be captured.
  Left off, every pass is refused while it stays off.
- **No allowed-domains list means a wide circle.** With no non-blank allowed
  domains on any sign-in provider, any domain counts (§1.2), so every full
  member of the Slack workspace who has no AX account is approved: each one
  gets external turns in every connected channel (tier C), as the person who
  connected it, with that person's access and turn budget. An admin who
  wants a tighter circle sets an allowed-domains list.
- **Broadcasts we can't measure without real Slack** (checks for the TASK-1097
  walk): whether Slack reads a stream's appends as one text (each is treated
  as its own edge, and a broadcast word is marked whatever comes before its
  `@`, so a letter, a flush, then `@channel` is caught); whether
  `markdown_text` decodes HTML character references before it looks for
  mentions, and which ones (`&#64;channel`, `&commat;here`,
  `&lt;!everyone&gt;`, `<&excl;channel>` are marked anyway: defense in
  depth); whether a bare `@channel` broadcasts at all.
- **User-group handles aren't neutralized.** A reply that names `@engineering`
  may notify that whole group: a bare `@name` is not "one person at most" when
  the name is a group's. Only the three broadcast words are marked. The
  TASK-1097 walk checks whether Slack's Markdown turns a typed handle into a
  mention.

## 7. Spike results (TASK-1090, 2026-11-12)

Run against the real Canopy workspace by Vinay, a workspace admin, using two
throwaway apps (`ax-spike-a`, `ax-spike-b`) behind a temporary tunnel. Both apps
were deleted afterwards, the bot tokens confirmed dead (`account_inactive`),
and the configuration token revoked. "Tested" means we watched it happen;
"docs" means only Slack's documentation says so.

| # | Question | Answer | Source |
|---|---|---|---|
| 1 | Does the event URL need verifying? | **No.** Neither `apps.manifest.create` nor `apps.manifest.update` sent a `url_verification` challenge. A DM to the installed bot arrived as a signed `event_callback` (`message`, `channel_type: im`) with no Verify click. The manifest docs say the URL must be "manually verified"; in practice it wasn't needed. | Tested |
| 2 | Avatar by API? | **Yes.** `apps.icon.set` with the configuration token and a PNG returned `ok`. Slack documents either `file` (an upload) or `url`; the spike didn't record which it used. Until TASK-1133 Connect passed a `url` to the branding logo; since then it uploads a PNG as `file` (Slack accepting it is unmeasured until the next real-Slack walk). On every kind walk (no logo, so the URL 404'd) Slack answered `error_bad_format`, and prod's logo, a 517×123 SVG wordmark, is outside the documented 512–2000 px. | Tested |
| 3 | Rename | `apps.manifest.update` changing only the name: `permissions_updated: false`, no reinstall, and the bot token kept working. `real_name` changed and the `name` field stayed as it was at install, but **the @handle people see and type follows the new name**: on the TASK-1097 walk, `@ax` became `@ax-walk`. | Tested (spike; handle corrected by the TASK-1097 walk) |
| 3 | Name rules | Accepted: ASCII letters, digits, spaces, `-`, `_`, `.`, and long names. Rejected by `apps.manifest.validate`: reserved words (`slackbot`, `here`, `channel`, `everyone` → `invalid_reserved_word`), non-ASCII (`Café` → `bad_username`), and other symbols (`!!` → `invalid_name_specials`). The `name` field drops hyphens: `ax-spike-a` became `axspikea`. Docs: at most 21 characters for the `name` field, 35 for the app name, 80 for the bot's display name. | Tested + docs |
| 4 | App approval | An admin installing a manifest-created app saw only Slack's normal Allow screen: no request, no wait. Slack's approval API (`admin.apps.approve`) is Enterprise-only. **Not seen:** what a regular member gets; the docs say members can't install restricted apps. The design needs no member installs. | Tested (admin only) + docs |
| 5 | Duplicate names | **Allowed.** A second app with the same bot name installed fine and quietly got `axspikea2` as its `name` field. In the test, the person DMing picked the wrong one. So AX enforces unique names itself. | Tested |
| 6 | Streaming | `chat.startStream` / `appendStream` / `stopStream`: `chat:write`, Tier 2. Works in channel threads with `recipient_user_id` + `recipient_team_id`. A stream lasts at most 10 minutes. `chat.update` is Tier 3. Decision: streaming API; past 10 minutes or 12,000 characters, a new stream in the same thread (§5). | Docs |
| 7 | Socket Mode / kind | The create response holds `client_id`, `client_secret`, `signing_secret` and `verification_token`, but **no app-level token**; that's generated only in Slack's UI. Since Q1 says HTTP events need no manual step, we don't use Socket Mode. On kind: a `cloudflared` quick tunnel works, but its URL changes on every restart, so the walk updates the app's URLs with `apps.manifest.update` (no challenge, no reinstall). | Tested + docs |
| — | Configuration tokens | Access tokens expire after 12 hours (we hit `token_expired`). `tooling.tokens.rotate` returns a new pair. **The old refresh token keeps working for a while, then Slack refuses it** (`invalid_refresh_token`), so AX stores the new one on every rotate (TASK-1129). How long "a while" is isn't pinned down. The TASK-1097 walk saw it work four times over 18 s, then found it dead about 6 minutes after the first rotate on one install and within 3 hours on the other. The 6 minutes has a confound: the admin also saved an Interactivity change on api.slack.com in that gap, which may be what retired it. The walk report names no confound for the 3 hours. The spike reused the old one before Slack refused it, and read that as "keeps working". Earlier access tokens kept working in the spike, which also checked within minutes. `auth.revoke` kills an access token, but **its refresh token still mints new ones afterwards**. Only Revoke on Slack's configuration-tokens page ends it (§3). Whether that Revoke also ends the refresh tokens rotates have minted since (the one AX holds from Connect on) is unmeasured: the TASK-1134 walk revoked right after a reconnect, before any rename. | Tested (spike; corrected by the TASK-1097 walk) |
| — | Plan limits | Free Slack: at most 10 custom or third-party apps (§4). | Docs |

## 8. Open questions

1. ~~**Memory on external turns.**~~ **Decided 2026-11-12 (Vinay):** decide by
   who sees the reply. See §2a.
2. **Choosing a personal agent.** Recommendation: the default is the owner's
   personal agent, and a slash command can switch to another. Until then
   (TASK-1093), a DM goes to the owner's OLDEST personal agent, so creating a
   new one doesn't silently move their Slack thread.
3. ~~**Who counts as a Slack admin for phase 2 approvals?**~~ **Decided
   2026-11-18 (Vinay):** the agent's owner, or else an AX admin. See §4.
4. **Telling the owner what goes to Slack.** Slack keeps a copy of everything
   the agent says, including in DMs, under its retention and export rules. And
   whoever controls a Slack session controls that person's personal agent.
   Recommendation: say this once when the owner first connects. Also confirm
   the workspace enforces Google SSO, since without it the bar is a Slack
   password.
5. ~~**Whose configuration token can manage the shared app?**~~ **Measured
   2026-11-19 (TASK-1163 walk, real Slack):** only the token of the person who
   created the app. A second person's token was refused with `no_permission` on
   `apps.manifest.update`, before AND after they were added as a collaborator on
   api.slack.com, and also with a token generated after the add. A newer token
   from the creator works: Replace took it, and Disconnect, plus Connect's
   leftover cleanup, deleted apps an older token of theirs had made. Slack also
   allows only one configuration token per person per workspace, so "a newer
   token" always means revoke, then generate.
6. ~~**Whose token creates a phase 2 bot?**~~ **Decided 2026-11-19 (Vinay): the
   approver's own token** (the agent's owner, or else an AX admin; §4 step 3).
   Chosen over one shared admin token, which would let a single departure strand
   every bot. The trade-off: approvers paste a token when approving, and a bot
   whose approver leaves must be rebuilt (§4 Lifecycle). Q5 made this a real choice. Only the
   creator's token can ever rename, re-sync or delete a bot. If every bot is
   created with the token of the admin who connected the shared bot, that one
   person is the only one who can ever manage any of them, and when they leave,
   no other token can delete those apps. If each bot is created with its
   approver's token, management follows whoever approved it. Handing a bot to
   someone else is never a token swap: it means making a new app. Decide before
   decomposing phase 2.

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
  - presets and the canary acceptance test. No Helm secrets: they live in the
    credentials store. Host egress on 443 is already open.

  Depends on 1 and 2.
- **4. Channels:** connecting a channel to a team agent (AX side and slash
  command), attended or external turns, and the "waiting for my owner" note.
  Depends on 3.
- **5. Approval buttons** for attended turns. Depends on 3.
- **6. Bot rename** in admin settings. Depends on 3.
- **7. Walk (walk):** phase 1 end to end on kind. Depends on 3–6.

**Phase 2: dedicated bots**

Before starting: TASK-1133 (the avatar upload works), TASK-1159 (Connect tries
the pasted token), TASK-1128 (an admin can replace a dead configuration token)
and TASK-1139 (Disconnect logs whether the app was deleted). Also one
measurement on a real workspace: can a newer configuration token delete an app
an older one made? **All done 2026-11-19** (deployed rev 90; walk TASK-1163:
yes for the creator's own newer token, no for anyone else's, §8 Q5). §8 Q6
decided 2026-11-19: the approver's own token.

- **8.** Request a bot (name and avatar), approval by the owner or an AX admin,
  creating and installing the app, its own events URL and signing secret,
  moving already-connected channels to the new handle, rename and avatar change,
  and deleting the bot when its agent or team is deleted or it's disconnected.
  Too big for one PR: decompose with `auto-ship --design`.
- **9. Walk (walk).**
