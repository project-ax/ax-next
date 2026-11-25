# Slack channel (design)

**Status:** proposed 2026-11-09. Spike (TASK-1090) done 2026-11-12; §7 has the answers. Memory decided 2026-11-12 (§2a). Simpler UX around one bot per team agent proposed 2026-11-21 (§4b).
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
   *Proposed 2026-11-21 (§4b):* team agents reach channels only through
   their own bot, so for channels this "straight away" no longer holds.
8. **The shared app's name defaults to the AX instance's name.** We take it from
   `branding:get` and turn it into a valid name (§7 Q3), falling back to `ax`.
   The admin can change it when connecting the workspace and rename it later.
9. **Memory follows who sees the reply, not who is talking** (§2a). Something
   said privately is never recalled in a channel.
10. **A website Allow lasts (decided 2026-11-22, Vinay; TASK-1208).** Allow on a
    blocked website's prompt keeps the site on the agent's own allowed sites
    (`@ax/host-grants`), so the agent's later sessions can reach it, not just
    the one that asked. On a personal agent the list is that agent's owner's,
    who sees and removes it in Settings › Sites, or in the agent's settings
    › Connectors. On a team agent one Allow
    covers every member's later sessions of that agent, outsider turns and
    routine runs included; every member sees the list in the agent's settings
    under Connectors, and only its owners and team admins remove sites there
    (decided 2026-11-23, Vinay; TASK-1212). Who may answer is unchanged (§5's click gate), and
    the live session still gets TASK-1199's "now allowed" line.

## 2. Who is talking, and what they can do

| Where | Agent | Who can use it | Turn runs as |
|---|---|---|---|
| 1:1 DM with the shared bot | Sender's "Just me" personal agent: the one they chose in its Slack settings, else their oldest (a shared personal agent never answers DMs; TASK-1248) | Only its owner | Owner, **attended** (`ctx.source: 'user'`) |
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
`[Slack · DM · Alice (U123)]: <text>` (a channel turn memory won't learn from
starts with one fixed not-remembered line before it, TASK-1191): the sender's
Slack display name (else
their real name), with brackets and parentheses of every script removed so a
name can't close the label early. `<text>` is the message as its sender typed
it: Slack's `&amp;`, `&lt;` and `&gt;` escaping is undone, and each person it
mentions is named (TASK-1190, `format.ts` `inboundText`): a `<@U…>` reads as
`@[` that person's Slack name `]`, cleaned the same way. The brackets show
where someone else's name ends and the sender's words go on, since a cleaned
name holds no bracket. The bot's own user reads as `@[<its handle> (you)]`,
so an agent knows when it was the one named. Someone Slack couldn't name
reads as `@someone`, never as a raw id. Names come from admission for the
sender, and from `users.info` for anyone else: at most 5 calls a message,
kept 10 minutes. After Slack rate-limits an install's token, that install
asks nobody until Retry-After has passed (never more than a minute); other
installs keep asking (`mention-names.ts`). Slack's `|label` is never read, and a `<#C…>` or
`<url|label>` reference stays as Slack wrote it. The label and the names are
untrusted text the model reads. Nothing ever treats them as permission to do
something, and the turn note (below) says the text inside `@[…]` is that
person's own Slack name, not the sender's words.

The agent is told what the label means once per session, in its system prompt
(TASK-1131, `turn-note.ts`). The words after the label are that person's own
request, and anything they paste or quote stays data. It also says who can
approve: in a DM, the owner; in a member's thread, that member; in an
outsider's thread, nobody writing: a call the host holds waits for the owner,
so the agent says it needs its owner's OK and never sends them looking for a
card or a button, and it still checks with them before it acts. The owner's
answer never comes back to that thread, so the agent never promises the
conversation will carry on once it's approved (TASK-1148), whatever the generic
connect-a-capability texts say. In a DM or a member's thread, a skill card's
Allow connects the skill but doesn't rerun the message, so once the person has
been asked to approve one, the agent tells them to send their message again
(TASK-1195), whatever those same texts say. The note is fixed text
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

> **Superseded for team agents by §4c (2026-11-22):** a team agent's memory is shared with its team everywhere, and since TASK-1209 with anyone who talks to it. This section still describes personal agents (DMs only).

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

A **private Slack channel** is a shared turn too (others see the reply), so
recall there is shared-only. But nothing said in one is captured, whatever its
switch says (TASK-1188, §4b.3): shared memory is recalled in every channel and
in members' web chats, so a private channel's words would surface in public
ones. Capture happens in public channels only.

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
- A team agent's own bot's channels have the same switch, in the same place
  (TASK-1180). AX also keeps the agent's switch for each channel apart from
  its connections, so a Disconnect (of the channel, or of Slack in
  Admin › Slack) doesn't lose it: the agent's own bot starts there where the
  team left it, unless the channel was connected again since (then the new
  connection's switch wins). One exception, from before this was built: a
  channel switched off and disconnected before TASK-1180 deployed, with no
  conversation there while it was off, left nothing behind to read, so the
  bot starts on there. A brand-new channel still starts on.
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

**Replacing the token:** Admin › Slack → **Replace**, next to who added the configuration token (TASK-1128), once Slack is connected. The admin pastes one value, a refresh token, from someone who can manage this Slack app. AX tries it once (`tooling.tokens.rotate`) and sends the app's whole manifest with the access token that rotate minted (`apps.manifest.update`, as Rename does). Slack taking it shows that the token's owner can manage this app. Only then does AX store the minted refresh token as the token of **the person whose app it is** (the install's, whoever pastes it), in place of their old one, and record when. Since TASK-1175 that one token also serves every other Slack app that person made through AX, so a Replace fixes all of them at once. The install, its channels, the bot token and the other secrets stay as they are, and if any step before the store fails, the old token stays. AX never reads or rotates the old token here. There's nothing left to retire: Slack allows one configuration token per person per workspace (§8 Q5), so the old one was revoked before the new one could be generated. Like Rename, Replace sends this build's manifest, so it also syncs the app to it: a hand edit on api.slack.com is overwritten, and a scope a later build adds would make Slack ask for the app to be reinstalled. A replace also tries again to delete any Slack apps listed as left over. **Measured (§8 Q5): only the app creator's own token passes the check.** Another person's token is refused even when they are a collaborator on the app, so "someone who can manage this Slack app" in practice means the person who created it, with a newer token of theirs.

**The secrets:** bot token, signing secret, client secret, and the
configuration **refresh token**. All live in the credentials store, readable
only by `@ax/channel-slack`.

The refresh token is the dangerous one. It can create apps in the workspace.
Renewing it only trades it for a new one, and it **outlives `auth.revoke`**
(§7, configuration tokens), so AX can't retire it through the API. Hence:

- It's admin-only to set, and nobody can ever read it back.
- AX keeps it **once per person** (TASK-1175), under
  `slack:person:<userId>:config-refresh-token`, shared by every Slack app that
  person made through AX: each app row records whose token manages it
  (`connected_by_user_id`). Every rotate, through any of those apps, saves the
  new token back to that one place, so the others keep working.
- Admin settings shows whose token it is and when it was added through Admin ›
  Slack (an AX admin; configuration tokens belong to one person). That date
  moves only with Admin › Slack's Connect or Replace. The token AX holds
  changes with every rotate whose new token it manages to save (step 5), and
  with **Replace** (above), which never changes whose it is. A paste, or a
  Replace through a team bot, changes the same token without moving the date.
- **Disconnect Slack** deletes the apps (which kills their bot tokens) and then
  tells whoever generated the token to click **Revoke** on Slack's configuration-tokens page,
  but only when nothing else needs the token. While a team bot or a leftover
  app still names that person, AX keeps the token and the notice says not to
  revoke it (TASK-1167). AX
  can't do the Revoke itself. That Revoke also ends the refresh
  tokens rotates have minted since (**measured, TASK-1163 check 4**): the
  token AX held, rotated from the revoked one, failed at `rotate` with
  `invalid_refresh_token`. Disconnect keeps the person's token while a
  leftover app (below) still names them, and drops it once nothing does.
  Deleting the app needs the stored token, so a dead or revoked one (or
  Slack not answering) leaves the app on Slack. Disconnect still removes the
  install, but keeps the app's id and name (TASK-1132): the Slack tab names
  it in every state, linked to its own settings page, and the next Connect or Replace
  tries to delete it. Leftover apps record whose token made them (TASK-1175),
  and each is deleted with that person's token: the one in hand when it is
  theirs, else their stored one, rotated once per pass with its successor saved. Connect keeps one
  the same way when it can't take back the app it just made (step 3). The name stays
  until a Connect or Replace deletes it or the admin clicks **I deleted it** after
  deleting it by hand. Cancelling an unfinished install is the same
  Disconnect. A new token can delete an app an earlier token of the same
  person made (**measured, TASK-1163 check 1**).

### Scopes (smallest set)

Six bot scopes, each for one job. (This list was nine before TASK-1186
retired three of them, marked below.)

- `app_mentions:read`: hear an @mention in a channel.
- `chat:write`: reply in the thread. It also DMs people about a bot request
  (TASK-1170).
- `im:history`: read a DM sent to the bot.
- `reactions:write`: put a 👀 on a message while the agent works on it.
- `users:read` and `users:read.email`: the identity check (who is this, and is
  that email an AX account). They also find an AX admin, or a bot's requester,
  by email (TASK-1170). No new scope.
- `channels:read`: look up a channel's flags and list the public ones to pick
  from (TASK-1094). *Retired by §4b.1 (TASK-1186) for the shared app. Only a
  team bot's manifest keeps it, for the turn-start channel check.*
- `channels:join`: the bot joins the public channel itself at connect, so
  nobody has to invite it (TASK-1094). *Retired by §4b.1 (TASK-1186).*
- `commands`: the `/ax` slash command (TASK-1094). *Retired by §4b.1
  (TASK-1186).*
- `groups:read` (team bot only, TASK-1188): read a private channel's flags
  (archived, Slack Connect), so the bot can answer there (§4b.3). Since §4c
  (TASK-1203) a private channel is remembered like any other. The shared app
  doesn't ask for it.

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

**Retired by §4b.1 (TASK-1186): the shared app no longer connects channels.**
The picker, `/ax`, the connect routes and the shared app's channel turns are
gone, and a team agent reaches a channel only through its own bot (§4). The
text below stays as history.

Two ways in, one stored record:

- **AX side:** agent settings → **Slack** → pick a channel.
- **Slack side:** run `/ax connect <agent name>` in the channel; `/ax
  disconnect` undoes it.

Rules, the same on both sides:

- **Who may:** a team admin of the agent's team
  (`agents:can-set-shared-credential`, always asked with `isAdmin: false`).
  Workspace admins don't count. A personal agent can't be connected. A person
  who can't see the agent is told nothing about it.
- **The channel:** public only (phase 1's shared app). Private, archived and
  Slack Connect channels (including a pending one) are refused. The bot joins
  the channel itself, after those checks pass. *Since §4b (TASK-1186,
  TASK-1188):* only a team agent's own bot is in channels, and it answers in a
  private channel it was invited to (remembered like any other since §4c,
  TASK-1203). Archived and Slack Connect stay refused.
  Slack is asked again when each turn starts, and its answer is trusted for a
  minute (TASK-1184). A turn that finds its connected channel has since become
  archived or Slack Connect never runs (private, since TASK-1188: it runs;
  since TASK-1203 it is remembered too), and the channel is
  disconnected, as a team admin's Disconnect would do it. The person whose turn
  found it is told once, privately. If Slack can't answer, no turn runs either.
  A channel shared with another company seldom gets that far: Slack flags its
  events as Slack Connect, and those are dropped before any turn (§1 rule 6,
  `admission.ts screenEvent`). So it is never answered, but its connection
  mostly stays: only a turn already waiting when it was shared, or a mention
  while the share is still pending, reaches the check.
- **Shape:** one agent per channel; one agent may serve several channels. The
  binding belongs to `@ax/channel-slack`; agents get no Slack-specific fields.
- **Reconnecting** a connected channel (by another team admin) takes over as
  the run-as person and keeps the remember setting.
- **Disconnecting:** an agent that no longer exists is cleared by anyone
  admitted; a live one only by a team admin.
- **An agent with its own bot:** once that bot is live (§4), neither way in
  connects a channel to the agent through the shared app. The answer names the
  bot's @handle and says to `/invite` it (TASK-1168). A pending bot changes
  nothing, and disconnecting an old connection still works; `/ax disconnect`
  then says the bot still answers wherever it's a member, and how to `/kick` it.
- **Which install:** `/ax` acts on the install that signed the request.
- **Admin › Slack › Disconnect** removes the shared install and its channel
  connections, so channels are connected again after Slack is. It leaves team
  bots alone. A bootstrap reset (`ax admin reset-bootstrap`) wipes every agent
  and secret, so it removes every install, team bots included, and logs each
  app id with its kind (TASK-1167).

## 4. Dedicated bots (phase 2)

A team agent that wants its own `@ada`:

1. The owner clicks **Request Slack bot** in agent settings and picks the name.
   The picture is the deployment's logo, drawn by the browser of whoever creates
   the app; there's no per-bot picture yet. AX checks Slack's name rules, and **rejects a name already used
   by its other bots in that workspace**. Slack itself allows duplicates: it
   quietly gives the second bot a suffixed `name` field (`axspikea2`), and in the
   spike the duplicate fooled even the person testing it (§7 Q5).
2. **Who approves (decided 2026-11-18, Vinay): the agent's owner, or else an AX
   admin.** If the owner can install apps in the Slack workspace, they approve
   it themselves: the request goes straight to step 3 with them as the approver.
   If they can't, it goes to the AX admins as a DM from the shared bot,
   **"Vinay wants to add @ada (Support team agent). [Approve] [Decline]"**, and
   the same request shows up in AX admin settings. As built (TASK-1170),
   Approve is a link to Admin › Slack, so tokens never pass through Slack, and
   the notification names nobody. Either way, Slack's own
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
   bot's @handle as read back from `users.info`: its display name
   (`profile.display_name`, else `real_name`), and the legacy `name` field
   only when Slack shows no usable display name. The `name` field is NOT
   what people type: it drops hyphens and never follows a rename (TASK-1185,
   measured in the TASK-1174 walk: `fern-walk` gave `name` `fernwalk`, while
   people type `@fern-walk`). As built
   (TASK-1170), they hear it from the shared bot, and only when someone else
   approved. Until then the agent keeps
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

**Channels it was already in (decided 2026-11-18; retired by §4b.1, TASK-1186,
which deletes the shared connections instead).** When an agent gets its own
bot, any channel already connected to it through the shared app stays
connected, but the agent answers only its new `@ada` handle from then on.
Mentioning the shared `@ax` there no longer reaches it, although other agents
on the shared app in that channel carry on as before. So two bots can't both
answer for one agent. The owner is told which channels changed, and that
`/invite @ada` is needed in each one before `@ada` can hear anything there.

**As built (TASK-1168; retired by §4b.1, TASK-1186).** The agent's settings list each of those channels
under "These channels still need @ada: run /invite @ada in each one." A channel
leaves the list once @ada has answered there: AX hears only mentions, and the
first one binds the channel to the bot. The old shared connection stays,
unused, and Disconnect still removes it. A channel that leaves this list moves
to the bot's own list, which had its own memory switch (TASK-1180; removed by TASK-1202). AX hears
only mentions, so a channel the bot was later removed from stays on that list.

**Lifecycle (decided 2026-11-18).**
- **Deleting the agent, or its team, deletes the bot** (`apps.manifest.delete`),
  through the same path as Disconnect. An app that can't be deleted goes on the
  leftover-apps list (TASK-1132).
- **The owner can rename the bot or change its avatar later** from agent
  settings (`apps.manifest.update` + `apps.icon.set`). That's the same rename
  path the shared bot uses (TASK-1096), and the same name check from step 1
  applies. Neither needs a new approval.
- **Disconnect** deletes the app with `apps.manifest.delete`. A team admin
  does it from agent settings. An AX admin does it from Admin › Slack
  (TASK-1172).
- **Only the approver can manage the bot** (measured, §8 Q5): rename, avatar,
  re-sync and delete all use the approver's stored token (one per person, step
  3). When it dies, the fix is Replace with a new token **from the same
  approver**, which fixes every app of theirs at once
  (TASK-1128's flow, per bot). If the approver is gone, no other token can
  touch the app: the bot can only be **rebuilt**, meaning a new request,
  approved under the new approver's token, with a new app and a new handle that
  channels must `/invite` again. Rebuild first tries to delete the old app with
  the approver's stored token, which can still work after they leave AX. Only
  when Slack won't does the old app go on the leftover-apps list for someone to
  delete by hand on api.slack.com. Admin › Slack lists each bot with
  its approver, and marks an approver who has left AX, so an offboarding admin
  can see which bots need rebuilding (TASK-1172).

**More phase 2 decisions (2026-11-19, Vinay, from decomposing it into TASK-1167..1174).**
- An outsider's turn in a dedicated bot's channel runs as **the bot's
  requester**, the team admin who asked for it (2026-11-20; a team agent's owner
  is the team, not a person). If the requester is no longer an admin of that
  team, outsider turns are refused politely, members' turns still work, and the
  bot shows "needs a team admin to claim it" until a team admin of that team
  claims it (TASK-1173, see "As built (TASK-1173)" below).
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

"Just me" personal agents stay on the shared app. Fifty personal bots cluttering the
workspace would buy nothing: a "Just me" agent only talks to one person, in a DM.
A personal agent shared with other people gets its own bot, like a team agent (TASK-1248).

**As built (TASK-1167).** The first slice is the self path only. Asking an
AX admin to approve came next (TASK-1169, below). On this path the approver is
the requester.

- A team admin of the agent's team asks from agent settings. An approver whose
  configuration token we already hold pastes nothing. One whose stored token
  Slack refuses is asked again, and a first-timer pastes one once. The paste is
  never stored: it's rotated at once and only the successor is kept.
- The request waits in Slack for the approver's Allow. They can pick it back
  up (**Continue in Slack**) or **Cancel** it while it's pending. A live bot
  isn't cancelled that way, because its channels would go with it; it's
  disconnected instead (TASK-1172).
- Names are unique across the shared bot and every team bot, by a key of 21
  letters and digits (lowercased, everything else dropped), which is how far
  Slack's legacy username goes (the @handle people type is the display name
  itself, TASK-1185). `Ada Bot` and `ada-bot` are the same name to us.
- A channel binding is written on the bot's first mention there, after the
  channel check (public, live, not Slack Connect), and checked again when each
  turn starts, as on the shared app (section 3, TASK-1184). It's bound only to
  the bot's own agent.
- *(Superseded by §4c: TASK-1202 removed the switch, its kept table and its
  lock. The next three bullets are history.)*
- That binding starts with the switch the team last set for the agent in that
  channel: the shared app's binding of it while there is one (TASK-1179; retired by
  TASK-1186, which deletes those bindings), else
  the switch AX keeps for the agent and channel, which outlives a Disconnect
  (of the channel, or of Slack in Admin › Slack) and a rebuilt bot (TASK-1180).
  With neither, it starts on, like any new connection. If the switch can't be
  read, nothing is bound and nothing runs.
- The kept switch is written in the same statement as every flip, and filled
  at boot for connections made before it existed (off wins when an agent has
  two connections of one channel that disagree). The boot fill also keeps an
  off for a channel that was switched off and disconnected before the table
  existed, read from its threads that weren't remembered. With no such
  thread (switched off and disconnected before deploy, with no conversation
  in between), nothing records the off, and the bot starts on there. The boot
  fill only ever moves a kept switch toward off. A flip to on that commits
  while the boot fill runs can still be moved back to off, because the fill
  read the bindings before the flip: the bindings and the page show on, and
  the bot starts off only if every binding goes before it answers there. It
  goes only with the agent.
  We keep it when it's set rather than copying it when the bot goes live, so
  it doesn't matter what got disconnected first.
- Each of the bot's channels has its own switch in the agent's settings. Only
  a team admin of the agent's team flips it, and the capture veto enforces it,
  as on the shared app. A flip also sets the agent's shared binding of that
  channel, so the shared bot carries on with it if the bot is disconnected.
  The shared connection's switch is refused (`409 own-bot`) only once the bot
  has answered in that channel. Before that it is the bot's starting value, so
  a moved channel's row shows it. A flip and the bot's first answer in that
  channel never interleave (TASK-1182). Both take one lock on the agent and
  channel, so whichever comes second sees what the other wrote, and the bot's
  binding ends with the switch's last value. After a flip on a channel still
  waiting for the bot, the page reads the status again, so a channel the bot
  answered in meanwhile shows on the bot's list.
- Outsiders in a bot's channels run as the requester, while the requester is
  still a team admin. Otherwise they get a polite line and the bot shows
  "needs a team admin to claim it", until a team admin of the team claims it
  (TASK-1173).
- The shared bot steps aside for that agent only once its own bot is live. A
  pending bot answers nobody, so until then the shared bot still does.
- Deleting the agent deletes its bot and its app.
- Disconnecting the shared bot leaves team bots alone and keeps the approver's
  token while a bot still uses it (`tokenKept`).

**As built (TASK-1169).** A team admin who can't install Slack apps asks an AX
admin.

- The form offers two ways: make the bot myself (above), or **Ask an AX admin**.
  A request holds a bot name and its requester, nothing else: no picture is
  stored. An agent has at most one of: an open request, or a bot. It needs the
  shared bot live, as the self path does.
- Names stay unique across requests too. A request holds its name until it's
  approved or declined, and Approve re-checks the name against everything else.
- Admin › Slack lists the requests, oldest first, each with the names its
  requester sees: the agent, its team and who asked. Those are read when shown,
  never stored.
- Approve uses the admin's own stored configuration token, so most of the time
  there is nothing to paste. An admin with none stored (or whose token Slack
  refuses) pastes one, and the paste is never stored. It goes through the same
  create path as the self path: the admin is the approver (whose token made the
  app) and the requester is who outsiders run as. The admin's browser draws the
  picture, as Connect's does.
- The request is deleted only once everything else worked, so an approve that
  fails at any step leaves it open.
- An admin-approved bot goes live only while its approver is still an AX admin
  and its requester still a team admin of the agent's team. The admin needn't
  be on the team.
- After Allow, the approver lands back in Admin › Slack (`from=admin`), not on
  an agent page they may not be able to open.
- Decline, the team's own Cancel, deleting the agent and a reset each remove a
  request.
- Not built: **Continue in Slack** for an approver outside the team. After an
  abandoned Allow, the team cancels the pending bot and asks again. The
  approver is the bot's only manager (see Lifecycle).

**As built (TASK-1171).** A team admin of the agent's team can rename a live
team bot or change its picture, from the agent's settings. Two routes:
`POST /settings/slack/:agentId/bot/rename` with `{ botName }`, and
`POST /settings/slack/:agentId/bot/icon` with `{ iconPng }`. Both use the
approver's stored per-person configuration token, rotated, with its successor
saved before the old one is used, all under the one app lock. No new approval,
no reinstall.

- Rename checks the name as a request does: Slack's rules, and no clash with
  the shared bot, the other bots, the other bots' handles or an open bot
  request (TASK-1169). The bot itself is left out of that check, so keeping
  its own name is fine. AX sends the whole bot manifest with
  `apps.manifest.update`, then re-reads the bot user's display name with
  `users.info` into the handle, best-effort: if that read fails, the old handle
  stays. The display name follows a rename; the legacy `name` field does not
  (TASK-1174 walk: after `fern-walk` → `fern-two`, autocomplete offered
  `@fern-two` while `name` stayed `fernwalk`; TASK-1185).
- Change picture is drawn in the admin's browser on a white 512 px square and
  sent with `apps.icon.set` only. AX keeps no copy.
- If Slack refuses the token, or answers `no_permission` or
  `app_not_owned_by_manager_app`, the route answers 502 `slack-config-token`.
  The bot's name and handle stay as they were. The approver's stored token
  may not: a refusal at the update or picture step comes after the rotate,
  so that token has already been swapped for its successor, which is still
  the approver's working token. The settings say "This bot's Slack token
  needs replacing by <approver>." An agent with no live bot gets 409
  `not-live`, and so does one whose bot a reset removed while Slack was
  being asked, whatever Slack answered; the approver's token then goes
  unless something else of theirs still needs it.

**As built (TASK-1173).** Replace, Rebuild and Claim.
- **Replace** a live bot's token, from agent settings or Admin › Slack, is
  the shared Replace's check-then-store step: the pasted token is rotated once,
  checked against Slack with the bot's own manifest, and only then stored. Only
  the bot's approver may do it; anyone else is 403 `not-approver` inside the one
  app lock, before the vault or Slack is touched, so nobody's paste lands in the
  approver's slot. Live bots only (409 `not-live`). It stores the approver's one
  per-person token, so it fixes every app of theirs. It moves no date (a bot
  shows none) and runs no leftover-apps pass: the next Admin › Slack Connect or
  Replace does that.
- **`approverGone`.** A live bot's status says its approver is gone only when
  auth answers that they no longer exist. If auth can't answer, it says
  nothing, so an outage never tells a team to rebuild. Nothing is stored. A dead
  token, by contrast, is told at the change that finds it ("Your Slack token
  stopped working", or the approver's name for everyone else), not before.
- **Rebuild** is client-side. A team admin's dialog calls the existing bot
  Disconnect (delete the app with the approver's stored token, else the
  leftover list), re-reads the status, and opens the request form prefilled with
  the old name. No new route or storage. In Admin › Slack the row says "Needs
  rebuilding", and its Disconnect dialog says a team admin sets up the
  replacement from the agent's settings.
- **Claim.** A team admin of the agent's team claims a live bot whose requester
  is no longer a team admin (or no longer exists):
  `POST /settings/slack/:agentId/bot/claim { installId }`. Inside the one app
  lock, rights are asked again first, then live-only (409 `not-live`), the
  page's install id (409 `no-bot`), and the requester still being a team admin
  (409 `claim-not-needed`). Then ONE statement moves the row's requester and
  every binding's copy, only on an active bot. The approver, whose token made
  the app, doesn't change. A later-demoted claimer is refused per mention and
  per queued turn by the existing team-admin checks.
- **Cancel** names the pending bot by the install id its page showed, and
  answers 409 `not-pending` for any other, so a stale tab can't take back a
  newer request. It now also asks for the team admin's rights again inside the
  app lock, like Disconnect.
- Admin › Slack's Rename and Replace releases of a gone row read first
  (`onlyIfStored`), so a reset's wipe isn't answered with a stray vault delete.
- **Residual, not built.** A claim racing the bot's first mention in a
  channel (anyone's mention, a member's too; the window is about two Slack
  calls) can leave that one binding with the old requester, because the
  router copies the requester from the row it read when the event arrived.
  While that person is not a team admin, outsiders in that channel are
  refused. It is not a clean fail-closed, though: if they are made a team
  admin again, outsiders there quietly run as them, while the settings and
  the Claim dialog say the claimer. It is also a dead end while it lasts:
  `needsClaim` reads only the install row, so the settings show nothing
  wrong and Claim answers `claim-not-needed`; it clears only with Disconnect, Rebuild,
  or a later Claim (one that becomes possible once the claimer stops being a
  team admin, since `claimBot` rewrites every binding of the install). Handed to a follow-up (take the app lock around re-reading the
  bot row and writing the binding; one replica today).

**As built (TASK-1172).** Disconnect runs the same removal as deleting the
agent, under the one app lock. A team admin's Disconnect (from the agent's
settings) is re-checked inside that lock, so a rights change mid-click can't
slip through. An AX admin's (from Admin › Slack) only ever touches bots.
Both name the bot by the install id their page showed, so a page drawn
before the bot was disconnected and asked for again can't take the new one
(it gets `no-bot`). The agent's settings send that id only to the people who
manage the agent. It works with no shared install connected. The shared bot
answers again in the agent's old shared channels, because we never touched
its bindings. It only stepped aside while the agent's own bot was live.
Admin › Slack's list shows each bot's name, handle, approver (or "A former
member" when auth no longer has them), when it was added, and its status. It
has no agent or team column yet. If auth can't answer for an approver, the
whole list fails and says so, with Try again: an outage that read as names
would hide everyone who has left.

**As built (TASK-1170).** When a team admin asks an AX admin for their agent's
own bot, the shared bot DMs the admins, and the requester hears back.
- **Who gets a DM.** `auth:list-admins` lists the admins (see section 6). For
  each one except the requester, up to 20: `users.lookupByEmail` finds the
  Slack id, the same `users.info` admission check as any sender must admit
  them (full member, confirmed email), and `auth:find-user-by-email` on that
  confirmed email must answer the same AX user. That's the Decline click's own
  identity rule, so everyone who is DMed can also Decline. A deployment whose
  only admin came from the setup wizard has an unverified email until they sign
  in with Google or GitHub, so `auth:list-admins` answers no one there and
  nobody is DMed. The request still waits in Admin › Slack.
- **What the DM says.** The agent's and the bot's names and the requester's
  display name go in as plain text, and the notification names nobody. Approve
  is a link to `/?admin=slack` (channel-web opens Admin › Slack for an admin,
  with no toast). Decline is a button.
- **Bounds.** The DM records live in memory: at most 200, kept 7 days. One
  requester starts at most 3 fan-outs per 10 minutes, and a fan-out stops at
  its first temporary Slack failure. All of it runs after the app lock is
  released, never fails an answer, and logs only codes.
- **Redraws.** An approve that made the bot, and every decline, redraw each
  DM with who approved or declined it. A cancel, an agent's deletion and a
  reset don't, but a cancel does forget the request's DMs, so a fan-out still
  running sends no more. After a restart (or past the 200-record or 7-day
  bound), old DMs aren't redrawn when someone else answers. The request itself
  is on Postgres, so a Decline clicked in one still declines a request that's
  open, and the DM it was clicked in is redrawn (under the plain ask, since its
  subject is gone). On a request that's already closed, the click says "This
  request was already handled."
- **The Decline click.** It goes through the interactions route to its own
  gate: bot token, admission, `auth:find-user-by-email`, then `auth:get-user`
  must say admin. Only then does anything read the request, so a non-admin
  learns nothing about it. Then it runs the same decline Admin › Slack runs.
- **The owner's DMs.** From the shared bot, only when the approver or decliner
  isn't the requester: "is live" (with `/invite` and the agent's shared-app
  channels, which now need the bot), or "An admin declined ...".
- **Unmeasured.** `chat.postMessage` to a user id with `chat:write` only is
  from Slack's docs, not measured. If Slack refuses, nobody is DMed (logged),
  and the request still waits in Admin › Slack. The walk checks it. The DMs land
  in the person's DM with the shared bot, where their personal agent also
  answers. The bot's own messages never start a turn (`admission.ts
  screenEvent`).

## 4b. One bot per team agent: the simpler Slack (proposed 2026-11-21)

**Why.** After the phase 2 walk (TASK-1174), Vinay found the Slack bot
experience "VERY confusing": too many things to understand. To put a team agent
in a channel today, a person meets about eight ideas: the shared app vs. the
agent's own bot, personal vs. team agents, public vs. private channels, a
memory switch per channel, requester vs. approver vs. owner, what happens when
one of those people leaves (Rebuild, Claim), members vs. outsiders and whose
name an outsider's turn runs under, and the "moved channels" list.

**The fixed point (decided 2026-11-21, Vinay): every team agent in a channel
is its own bot.** People type `@juniper`, `@moss` or `@fern` directly.
*Rejected:* one shared `@canopy` bot that posts under each agent's name
(`chat:write.customize`) and asks "which agent?" when it's invited. Vinay:
"it's much easier for a user to just directly @juniper or @moss or @fern
instead of @canopy and then selecting a bot." This section simplifies around
that bot, not away from it.

**What a person needs to know.** Two sentences:

- **DM the shared bot to talk to your own agent.**
- **Invite `@fern` (or `@moss`, or `@juniper`) to a channel to bring in a team
  agent.**

Everything below exists to make those two sentences the whole story. Nothing
here loosens a security rule from §1–§4. It changes what people see and which
paths exist, not who may do what.

### 1. A team agent reaches channels only through its own bot

- **The shared app stops doing channels.** The agent settings' "Connect a
  channel" picker, the `/ax` slash command (it only ever did `connect` and
  `disconnect`), and shared-app channel turns are removed. Inviting the agent's
  own bot is the only way in. That also retires the rules that only exist
  because there were two ways in: "answers only its new @handle", the
  moved-channels list (TASK-1168), the shared connection's switch and the
  `own-bot` refusal.
- **Existing shared-app connections are deleted, not migrated** (decided
  2026-11-21, Vinay: prod has no real users yet, so §8 Q7 needs no count).
  Only the shared install's rows in `channel_slack_v1_channels` go. A bot's
  bindings live in the same table under its own install id and stay. The
  kept switches (`channel_slack_v1_memory_switches`) stay, because the bot's
  first bind reads them. (TASK-1202 later dropped them with the switch, §4c.)
- **The shared manifest drops `channels:join` and `commands`**, the two scopes
  that only served connecting channels. Whether Slack needs a new Allow to
  *drop* a scope is unmeasured. Either way, prod's shared install sheds them
  with one Disconnect + Connect after the deploy. With no real users, that
  costs nothing.
- **The shared bot keeps two jobs:** DMs with each person's personal agent,
  and the DMs about bot requests (TASK-1170).
- **The cost.** §1 decision 7 said every agent works in Slack straight away
  through the shared app. For channels that's no longer true: a team agent
  needs its own approved bot first. The admin-request DM (TASK-1170) keeps
  that to one Approve click for an AX admin, and a team admin who can install
  Slack apps approves it themselves.

**As built (TASK-1186).**

- A shared-bot mention in a channel gets one private line, `COPY.sharedBotInChannel`
  ("I don't answer in channels. To talk to your own agent, send me a direct
  message. To bring a team agent into this channel, invite its own bot with
  /invite."). Only an admitted sender sees it; a refused sender gets silence.
  No turn runs and no binding is read.
- `/ax` and its route are gone. Slack's POST to `/slack/commands/<id>` carries no
  CSRF header, so the host refuses it with 403 before any routing (not 405).
- The shared manifest has six scopes. A team bot's manifest keeps `channels:read`
  for the turn-start check (TASK-1184, which keeps `ChannelStore.remove`).
- Every boot deletes the shared install's rows in `channel_slack_v1_channels`,
  after the memory-switch backfills have run.
- A bot's first bind reads only the kept switch, then on.
- The shared connection's switch, `/remember` on it and the `409 own-bot`
  refusal are gone, along with `SlackChannel.isMember`.
- channel-web lost the channel picker, the shared "Connected channels" list and
  the moved-channels list. A member who can't manage the agent, whose bot isn't
  live, sees "<agent> isn't in Slack yet. A team admin can add it."

Retired as-built bullets: TASK-1167 "steps aside" and "the shared app's binding
of it while there is one" (TASK-1179); TASK-1180's shared flip and the
`409 own-bot`; TASK-1172's "the shared bot answers again in the agent's old
shared channels"; TASK-1170's channel list in the "is live" DM; TASK-1168's
moved-channels list; TASK-1184's shared-install branches.

**Deploy:** after the deploy, Admin › Slack → Disconnect, then Connect, so the
shared app sheds `channels:read`, `channels:join` and `commands`. Until then
`/ax` in Slack fails with a 403.

**Several bots in one channel are supported**, and the code already allows it.
The shared app's one-agent-per-channel rule comes from its single @handle (the
`channel_slack_v1_channels` key is `(install_id, channel_id)`, and every agent
on the shared app shares one install). Each bot is its own install, so `@fern`,
`@moss` and `@juniper` can all sit in `#support`, each answering only its own
mentions. Three things to know:

- **Bots never answer bots.** `screenEvent` (`admission.ts`) drops any message
  with a `bot_id`, which is what keeps two bots from looping. So "@fern, ask
  @moss" never reaches `@moss`: a person has to mention `@moss`. This is
  deliberate, and the help text says so.
- **One message that mentions two bots should get two replies** in the
  thread: Slack sends each app its own `app_mention`, and each runs its own
  turn. **Unmeasured:** the next walk checks it.
- **Slack's app limit.** Each bot is one installed app. Free Slack allows 10.
  Canopy is on a paid plan (§4), so this is a line on the request form.

### 2. Setting up a bot: one button, with the plumbing out of sight

The agent's Slack settings become one card with three states:

| State | What the card shows |
|---|---|
| Not in Slack | **Add to Slack**, with the bot's name prefilled from the agent's name. |
| Waiting | "Waiting for an admin to approve @fern." Cancel sits in the ⋯ menu. |
| Live | "@fern is in Slack. Invite it to a channel: `/invite @fern`", then the channels it has answered in. Rename, Change picture and Remove from Slack sit in the ⋯ menu. |

- **Asking an AX admin is the default.** "I can install Slack apps myself" is
  a quiet link under the button that opens the configuration-token paste.
  Until TASK-1187 the form opened with a two-way choice, "Who sets it up in Slack?".
- **These words leave the agent settings:** approver, requester, claim,
  rebuild, shared app, own bot, and configuration token (except on the
  install-it-myself path). Admin › Slack keeps them. Admins are the right
  audience for the plumbing, and the list there is unchanged.
- **Status shows only when something is wrong**, on the card, with exactly one
  action. The flows behind the actions are the ones built in TASK-1173:

  | What's wrong | What the card says | Behind it |
  |---|---|---|
  | The token stopped working, and you made the bot | "@fern lost its connection to Slack." **Reconnect** | Replace |
  | The token stopped working, and someone else made the bot | "@fern lost its connection to Slack. Ask <name> to reconnect it." | (none for this viewer) |
  | Whoever made the bot has left | "@fern needs to be set up again." **Set up again** | Rebuild |
  | The team admin people outside AX run as is no longer a team admin | "People outside AX can't use @fern right now." **Take over** | Claim |

**As built (TASK-1187).** The card is one component. Its title is the state
sentence ("@fern isn't in Slack yet", "Waiting for an admin to approve ...",
"@fern is in Slack"), and the actions live in a ⋯ menu.

- **Asking an admin is the default**, unless the person's configuration token
  is already stored. Then the button installs the bot directly. The form has
  one link-button that flips its label: "I can install Slack apps myself" and
  "Ask an admin instead". It is not a two-way choice.
- **Waiting names the bot**, not an @handle, and says what happens next: "Once
  an admin approves it, Quill Bot is ready to invite to channels."
- **`approverGone` shows alone.** No other problem row sits beside it.
- **The token rows are not on page load.** They appear only after a Rename or
  Change picture finds the token dead, and they don't survive a reload.
  TASK-1178 item 19 would persist them.
- **Two copy differences from the table, on purpose.** We say "outside the
  team", not "outside AX": the product is white-labeled, and §2's outsiders
  include AX users who have no access. We say "Changes to @fern can't reach
  Slack right now", not "lost its connection": the bot keeps answering in
  Slack, so "lost" would be wrong.
- **The memory switch is the channel row's ⋯ item** ("Don't remember this
  channel" or "Remember this channel"). Storage, route and locks are
  unchanged.
- **The help line** (who @fern asks when it needs an OK: the person who
  mentioned it, or the team admin who set it up for people outside the team)
  is on the Not in Slack and Live cards.
- **Live tells people where to type the invite**: "In any Slack channel, type
  `/invite @fern`" (with no handle: "In any Slack channel, type /invite and
  pick it."). The outsiders row says why: the team admin who set the bot up
  isn't a team admin anymore.
- **A words test** (`slack-card-words.test.ts`) fails if the plumbing words
  come back into the agent settings.

### 3. Memory: one rule, and no switch on screen

> **Superseded by §4c (2026-11-22):** private channels are remembered, and the switch is removed.

**@fern remembers what members say in public channels. It doesn't remember
private channels.** That's the whole rule a person sees. DMs with a personal
agent are unchanged (private memory, as today), and team bots have no DMs.

- **Private channels become allowed.** A bot invited to a private channel
  answers there. The turn is `shared` (others see the reply), so recall is
  shared-only, as in any channel, and capture is refused, as when the switch
  is off. Why refuse capture there: shared memory is recalled in every channel
  and in members' web chats, so a private channel's words would surface in
  public ones.
- **This hooks into TASK-1184**, which (as built) re-checks a bound channel's
  flags at turn start and refuses private, archived and Slack Connect
  channels. Its private branch changes from "refuse" to "answer, don't
  remember". Archived and Slack Connect stay refused.
- **One new scope for the bot: `groups:read`**, so `conversations.info` can
  read a private channel's flags. Adding a scope means Slack asks for Allow
  again on an installed app. No team bot is deployed to prod yet (phase 2 is
  merged, not deployed), so if this ships before phase 2 deploys, that costs
  nothing. Kind's walk bots get rebuilt.
- **The per-channel switch stays built but moves out of the way.** It's still
  on by default, stored and locked as built (TASK-1180, TASK-1182), but it
  moves into each channel's ⋯ menu as "Don't remember this channel".
  *Removed by TASK-1202 (§4c card A): the ⋯ item, its route, the kept
  switches table and the bindings' `remember` column are gone.*
- **Unchanged and not shown:** outsiders' words are never remembered, and
  facts about the speaker are never saved to shared memory (§2a).

**As built (TASK-1188).**

- `connectable()` (`channels.ts`) no longer tests `is_private`. It still needs
  Slack's `is_channel`, so a group DM, and a private group from before March
  2021 (Slack still describes those with `is_channel` false), stay refused.
- The turn-start check (`channel-check.ts`) answers `allowed` with `isPrivate`
  (only Slack's literal `false` is public: absent or unreadable is private).
  The binding stores it (`channel_slack_v1_channels.is_private`): written at
  the bind, and again by any turn whose check finds it changed, before the
  thread is recorded. **Private wins:** a binding that says private never
  takes a kept public answer (the check's `knownPrivate`, so only Slack asked
  after the binding was read can clear it, whichever replica kept the old
  answer), and a public answer a private one overtook in flight is reported
  private to its own turn, even when a refusal also landed. One order it
  can't see: a public answer landing before a private one (Slack answering
  from stale data, or the channel made public and private again while turns
  that read the binding as private were in flight; those write nothing). That
  turn writes public, and the binding stays public until a turn that read it
  public hears private, up to a minute on a replica that kept the public
  answer. The same kind of window as TASK-1184's minute, and part of the
  human follow-up below. (Writing private on every private turn, not only
  when it changed, would close most of it at one no-op write per turn.) The thread record ORs privacy into its sticky
  `not_remembered`, the same flag a switch that is off sets.
- The capture veto refuses a thread whose binding says private now, or whose
  turn ran while it was private (`channel-not-remembered`, the switch's
  refusal). So the observer and `memory_note` are both refused, whatever the
  switch says. Public → private stops capture for every thread of the channel
  at once; private → public lets new threads in (switch on), and a thread a
  private turn ran in stays out for good.
- The Allow continuation (`answers.ts` step 8) runs the same check (closing
  TASK-1184's gap): archived or Slack Connect closes the prompt, Slack not
  answering is "try again", and private marks the binding and the thread
  before the answer runs.
- `groups:read` is the bot's seventh scope. Settings show a private channel's
  row as "Private channels aren't remembered." instead of "Not remembered"
  and the row's ⋯ (TASK-1187 moved the switch into that ⋯).
- **Known gaps, accepted.** A channel made private can still be captured for
  up to a minute, while the check's kept public answer lasts (TASK-1184's
  window). What was captured while a channel was public stays in memory. A bot
  Allowed before `groups:read` still can't read a private channel: Slack says
  `missing_scope`, which stays a refusal (the channel is disconnected), so such
  a bot needs Rebuild. A private channel whose binding goes (disconnected) leaves
  threads marked not remembered, and a later boot may keep that as the
  channel's switch off (`migrations.ts`' thread backfill), so if the channel is
  public by the time the bot binds it again, it starts off: the safe side.
  Whether `conversations.info` needs exactly `groups:read` for a private
  channel is from Slack's docs; the TASK-1189 walk measures it.
  **Outsiders' turns in a private channel** run as the bot's requester, in a
  conversation the requester owns (as in any channel), so a team admin who
  isn't in the private channel can read those turns in the web app. **Not a
  settled decision:** shipped as built, and handed to the board as a
  follow-up for a human product decision (answer only members there, or hide
  those conversations).

### 4. Permission, in one sentence

The card's help line: **"If @fern needs your OK for something, it asks the
person who asked. For people outside AX, it asks the team admin who set @fern
up."** *(As built, TASK-1248: "the person who set it up", so it reads right for a shared personal agent too.)* Who a turn runs as, attended vs. external, and Today's approval cards
stay as built (§2, §4). People just don't have to learn the words.

### Order and cards

Land this **before phase 2 deploys**, so nobody in prod meets the confusing
version first. Filed 2026-11-21 as TASK-1186 (A), TASK-1187 (B), TASK-1188 (C) and TASK-1189 (D):

- **A. Channels only through a bot.** Remove the shared app's channel path
  (the settings picker, `/ax`, shared-app channel turns, the moved-channels
  list), delete the shared install's channel rows, and drop `channels:join`
  and `commands` from the shared manifest.
- **B. One Slack card per agent.** The three states, the ⋯ menu (with the
  memory switch in it), problem-only status with one action each, and a copy
  pass with the `ux-designer` agent. UI only.
- **C. Private channels: answer, don't remember.** Add `groups:read` to the bot
  manifest, and switch TASK-1184's private branch from refuse to capture-off.
  Depends on TASK-1184.
- **D. Walk (walk).** Several bots in one channel, including one message that
  mentions two of them; a private channel (answers, nothing remembered); the
  new card states. Depends on A, B and C.

## 4c. A team agent's memory is shared with its team (decided 2026-11-22)

**Supersedes** §2a's split between shared and private memory for team agents, and §4b.3's private-channel rule and remember switch. Personal agents are unchanged.

### Why

The TASK-1192 walk showed that "answer, but don't remember" can't be enforced. Memory refused a fact from a channel switched to "Don't remember", and the agent wrote it to a file in its own files anyway. Every channel then reads that file. Files are one way out. Tasks, routines, connectors (Notion, GitHub, email) and posts to other channels are more. A rule that holds only when every write path enforces it isn't a rule. So we stop promising secrecy a team agent can't keep, and say plainly what it does.

### The rules

1. **A team agent's memory is shared with anyone who talks to it, everywhere.** What it hears in a public channel, a private channel, or a web chat with a team member can be remembered and brought up anywhere the agent works, for anyone who talks to it: its team, and anyone else in a channel it's in (TASK-1209).
2. **"Just me" agents work only in DMs** (true since TASK-1186). Their memory stays private, as today. A personal agent shared with other people follows rules 1, 3, 4 and 5 (TASK-1248).
3. **Private channels are allowed and remembered.** A team bot invited to one answers and remembers, like anywhere else. People are told (below).
4. **Kept, for trust rather than privacy:** words from people outside the agent's team are never remembered (AX users not on the team included: §2's outsiders). Otherwise anyone in the workspace could feed the agent false team facts. Reading is open, since TASK-1209: an outsider's turn recalls what a member's does. Writing stays closed.
5. **Kept:** Slack Connect channels are refused. "Shared with your team" shouldn't quietly take in another company's messages. Archived channels stay refused.

### Telling people

Every place a person meets a team agent says the same thing in plain words: *"What [Fern] hears is shared with anyone who talks to [Fern], and [Fern] may bring it up elsewhere."* (TASK-1203 first shipped "everyone on [team]". TASK-1209 made that wrong, because anyone who can talk to the bot can now be told what it remembers, so the words changed with it.)

- **The first time the bot is invited to a channel:** the bot posts this once, in every channel and not only private ones. This post matters most, because it's the only one people see at the moment it applies.
- **The agent's Slack card** (TASK-1187) and its help line.
- **Web chat with a team agent:** one line under the composer, "[Fern]'s memory is shared with anyone who talks to [Fern]."
- **The bot's Slack profile description** (manifest `description`). A rename or Rebuild updates it.

*As built (TASK-1203), wording after a ux pass, reworded by TASK-1209 to say "anyone who talks to" and name no team:*

- **The channel post** goes with the bot's first turn in a channel, since a bot gets no invite event (it hears `app_mention` only), and it is posted before the bot's reply to that turn. So the message that opens the channel's first new thread, the one addressed to the bot, is remembered, and the notice lands just before the bot answers it: the moment an invite-time post would have landed, had there been an invite event (review F1, accepted; walk D checks it). It is top-level in the channel, not in the thread, and once per binding: `channel_slack_v1_channels.notice_posted_at` is claimed by one conditional `UPDATE` before the post, so two replicas can't both post, and given back if Slack refuses the post, so the next turn tries again. The release names its own claim's stamp, so a channel removed and bound again while a post was failing keeps the new binding's claim. The one refusal no retry gets past is a channel where only admins post top-level (`restricted_action` or `restricted_action_thread_only_channel`; which one Slack sends for an announcement-only channel is unmeasured, and walk D records it from `slack_notice_top_level_refused`; a read-only channel refuses thread replies too, so its `restricted_action_read_only_channel` is an ordinary refusal): the notice goes in the mention's thread instead, where the bot is about to reply, and the claim is kept once that lands (given back only if the thread post fails too). Only that thread's readers are told; later threads there aren't (accepted over retrying in front of every reply and telling nobody). A binding made before the column existed is told at its next turn; a channel removed and bound again is told again. The turn runs whatever happens to the post. The bot speaks in the first person under its own name: "Heads up: what I hear in this channel is shared with anyone who talks to me, and I may bring it up elsewhere." It is one fixed line. TASK-1203 named the agent's team (and fell back to "my team"), and TASK-1209 dropped the name along with its lookup.
- **The profile** says "What I hear is shared with anyone who talks to me, and I may bring it up elsewhere." (83 characters, under Slack's 140; it never named a team, since a team's name alone can run to 128). Every manifest send (Set up again, a rename, a token Replace) carries it.
- **The Slack card** says "What {name} hears is shared with anyone who talks to {name}, and {name} may bring it up elsewhere." on the setup form and beside the live card's help line, by the agent's name, never its @handle. It names no team, so the card's status no longer carries one. The channel list's lead is "{who} has answered in these channels.", with no private-channel note.
- **The web chat** line is "{Agent}'s memory is shared with anyone who talks to {Agent}." ("anyone who talks to" because "shared with Support" reads as "the support staff can read it", and "everyone on Support" understates it now that outsiders can too). Team agents only, and not under a read-only Slack conversation. The memory view's own note says "Memories saved with this shared agent can come up for anyone who talks to it. Team members can fix or forget them."

### What goes

- **The "Don't remember this channel" switch:** the ⋯ item, its routes, the `channel_slack_v1_memory_switches` table and `channel_slack_v1_channels.remember`, the `channel-not-remembered` capture veto, and TASK-1180's carry-over on a bot's first bind. A migration drops the table and column. *Done (TASK-1202):* channel-slack's boot migration drops both. The `channel-not-remembered` refusal stays only for a private channel, or one no longer connected to its agent, until card B; threads an old switch marked stay refused: a refusal leaves memory's cursor where it was, so un-marking one would let the next pass read what was said while the switch was off. A bot's first bind is a plain `upsert` again, with no lock. The TASK-1191 turn note stays: card B drops only its private-channel case, and outsiders' threads keep it for good (rule 4).
- **The private-channel capture refusal** (TASK-1188): `not_remembered` on threads, "Private channels aren't remembered" in settings, and the TASK-1191 turn note "This conversation isn't remembered". With the switch gone, nothing sets it any more. *(Caveat from TASK-1202: card B stops setting `not_remembered` but keeps refusing rows already marked, since un-marking would let memory read them; and the note stays for outsiders' threads, which are never remembered.)* *Done (TASK-1203):* nothing writes `not_remembered`; a thread marked before stays refused and keeps the note; the settings line, the binding's `is_private` (dropped at boot), Slack's `is_private` flag and the channel check's private-wins half are gone. Nothing reads a channel's privacy any more.
- **For team agents only:** the speaker rule (TASK-1146, `breaksSpeakerRule`), the shared-only recall filter, and the withheld `/memory` view in shared sessions. A team agent's sessions all recall everything and keep the view, outsiders' included (TASK-1209; see "As built (TASK-1204)" and "As built (TASK-1209)" under §4c). Personal agents keep both.
- **Still needed:** `ctx.audience` (personal-agent DMs), the turn-start channel check and its refusal rules (a channel made Slack Connect or archived must still be caught at turn start; its private-wins half guarded only the private refusal, and went with it in TASK-1203), and `groups:read` (to read a private channel's archived and Slack Connect flags).

### What stays hard

**Who a fact is about.** §2a's second problem (a passing speaker's "I live in Paris" pinned on whoever connected the channel) doesn't go away when speaker facts are allowed. A member's turn runs as the member (`ctx.userId` is them), so their facts go under their own key, `user:<ctx.userId>`, the same one their web chats write and read. A subject the extractor writes with a label name (`vinay | …`) goes there too. An outsider's turn runs as whoever answers for the channel, not as the person talking, so it files no person fact at all. Getting this wrong is worse than dropping the fact, so the card that removes the speaker rule had to land the attribution in the same PR.

**As built (TASK-1204).**

- **Three scopes** (`speakerScope`): `private` (the owner's own turn), `team` (a team agent's member turn, in any audience) and `withheld` (everything else: a personal agent's shared turn, and any outsider's turn). An outsider's turn is `withheld` first, whatever its audience.
- **A team agent's member turns recall everything.** Web chats and member channel turns read the team's whole memory, with no audience filter, and keep the `/memory` view. A member's channel question already shows recall to the room, and the §4c notices tell the room. That removes a privacy boundary on purpose. *(Superseded by TASK-1209: every turn on a team agent recalls everything, outsiders' included.)*
- **Members' facts are filed under them.** A member's turn files what they say about themselves under `user:<ctx.userId>`, and a subject made of their label names is filed there too. `memory_note` does the same.
- **...and stay with the team (review F2).** Those rows are stamped `private`, even when said in a channel: §4c shares the memory with the team, not with people outside AX. Every member's turn reads them (a member's reads have no audience filter), and no outsider's turn does (its reads are shared-only). It's done at the write, in `recordFacts`, because §6.1 forbids filtering a read's answer. Everything else a member's channel turn stores (the work, a third party by name) stays `shared`, as before. Twin reads still find these rows, and slot chains ignore audience, so a channel `lives_in` still closes the web-chat one. Two visible effects: the owner's memory view shows no "Shared" badge on them, and a subject the names rule can't recognize (a thread with no names, a nickname, or a member's self-fact written under an agent word such as `agent` when their display name is "Agent") is filed as written and stays `shared`, like any third party's fact, so an outsider can recall it. A member's own question in a channel can still surface a teammate's fact to the room (the trade above). *(Superseded by TASK-1209: the stamp is the turn's own audience again, with no exception, so the memory view's "Shared" badge is back on a member's self-facts.)*
- **Outsiders keep the rule.** An outsider's turn on a team agent keeps shared-only recall (with the stamp backstop that throws if a non-shared row comes back) and gets no `/memory` mount. It stores no person fact (`user`, `user:<id>`, or a speaker's name). The shared team memory is the team's, not the public's, so the planner's "every session" was narrowed to members after the security review. Lifting it is the outsider step in `recallAudienceScope` and the outsider condition on the mount. Both hold on any agent whatever the turn's audience stamp (review F3): someone without access reads an outsider's reply, so a private stamp, or none, fails closed. channel-slack stamps an outsider's turn shared; the one live path to an unstamped outsider turn is a stored session source this build doesn't know, which `ipc-core` reads as external with no audience, and that now fails closed. *(Superseded by TASK-1209: the shared-only recall and the withheld `/memory` view are lifted for team agents. Personal agents keep them. A source outside the type on a team agent still gets both (it fails closed). Since TASK-1213 that includes a stored session source this build doesn't recognize, which reads as `unrecognized`. An outsider's turn still stores no person fact.)*
- **Outsiders are never "you".** Recall in an outsider's turn never shows the requester's own memory as the person talking.
- **Personal agents are unchanged.** A shared turn there still recalls only shared statements and stores no speaker facts.
- **Accepted residuals.** Nicknames, initials, titles and role words the label doesn't show can still slip past the names rule (see `namesASpeaker`). A member's display name is untrusted. On a team agent the most a hostile one can do is file the speaker's own words under the speaker (a namesake "Alex" said by "Alex Kim", or a display name made of work words like "Standup Team", lands under that member's key); it can never file anything under another person's key. On a personal agent it can only make memory drop facts in that conversation. Rows saved under a member's name before this shipped (`vinay | …`) stay as written.
- **Follow-ups.** Render a member's display name for `user:<id>` subjects in a team agent's turns. Walk D checks a member's own recall and that nothing is filed under the requester. *(Superseded by TASK-1209: names are done. The export's headings and finding a teammate's facts by name in a query remain.)*

**As built (TASK-1209).** Outsiders are treated like members when they read, and not at all when they write. Vinay's call: "treat outsiders the same as insiders", kept simple on purpose.

- **Recall order** (`recallAudienceScope`). A personal agent is as before: an outsider's turn, and any shared stamp, reads shared rows only. On a team agent the visibility check comes first, and only a source this build knows reads unscoped: a member's turn (the web chat, an owner route), a member's own routine, and an outsider's turn. A source it doesn't know (a webhook or an embed added to `AgentContextSource` later) reads shared rows only on a team agent too, whatever its stamp, and the stamp backstop still throws if a private row comes back. The `switch` has a `never` default, so a new source won't compile until someone decides who may read it. That is compile-time exhaustiveness, plus a context a host plugin builds by hand. Since TASK-1213 it is a guard on stored sessions too: session-postgres (`normalizeSource`) and ipc-core (`sessionSource`) read a stored source they can't place as `unrecognized`, and this step places it with the unknowns. An outsider's turn on a team agent also does its twin and retraction reads unscoped. Those only ever skip a write, so the worst case is fewer writes.
- **The `/memory` view** follows the same rule: `sandbox:memory-mounts` withholds it exactly where recall is shared-only (a personal agent's shared or outsider session, or a context with a source this build doesn't recognize, or one outside the type, on a team agent). Every other session on a team agent keeps it. The read-only `/files` home for outsiders (TASK-1122) is a write boundary, not recall, and stays.
- **The stamp means "where it was learned."** `recordFacts` stamps every statement with the turn's own audience, with no exception for what a member says about themself. It filters a read only on a personal agent, where "learned in a shared place" and "readable by the room" are the same thing. On a team agent it only drives the badge.
- **Capture is unchanged.** An outsider's words are never remembered, an outsider's turn files no person fact, and Slack Connect channels are still refused. channel-slack's veto stands. Anyone can read. Only members teach it.
- **Never "you" is kept.** `aboutText` reads `you` only for the caller's own key. An outsider's turn never shows the requester's memory as the person talking.
- **Teammates read by name.** On a team agent, a `user:<id>` subject reads as that person's display name in the memory view, the `memory_recall` tool, recall receipts, and the injected block's Recent and Digest. Names are looked up through `auth:get-user` (display name only, never an email or an admin flag), and only for an id that `teams:is-member` first confirms is a current member of the agent's team. Anyone else (an account outside the team, someone who has left) reads "a teammate", with no lookup. So do a missing name, a failed lookup and a team agent's turn from a source this build doesn't know. A name is cleaned like any other account-holder text, and one that reads as the speaker or the agent (`you`, `user`, `I`, `agent`, as whole words) is refused so it can't pass for them. Since TASK-1213 that also covers the agent's own display name (compared as written and as shown, cut to 80 characters) and the fallback text "a teammate". Name lookups for one answer share a 2 s deadline. If it passes, the answer names nobody, because a partial set of names can't be checked for collisions. Personal agents make no lookup and are unchanged.
- **Two members with the same name.** Within one answer, two keys whose names read the same (compared word by word: case, spacing, punctuation, accents and fullwidth forms folded) both read "a teammate", so a member who renames themself to a teammate's name can't pass for them beside the teammate's rows. That is per answer only. A member renamed to a teammate's name still reads as that name wherever the real teammate's rows aren't in the same answer, display names being self-chosen account text as anywhere names show; lookalike and invisible variants pass the comparison too; and, since TASK-1213, the caller's own name counts as a holder, but only when another member key is on the page (the caller's name is never shown, only compared). A team-wide check needs a member list, which `teams:list-members` gives only admins.
- **Not done (follow-ups):** a `query` can't find a teammate's facts by name, and the duplicate-name check is per answer, not team-wide. A team-wide check needs a team roster memory doesn't have; that is a human call (TASK-1213 decisions). Residuals: a member's name is visible to an outsider's turn, and a name is frozen in a receipt once it's written. The export's names are frozen until its next pass, and a pass from a turn whose recall is scoped names nobody.
- **The privacy sentence.** This removes one more boundary on purpose. An outsider can now be told what members said in a private web chat, anywhere the agent answers them. The notices under "Telling people" are what replace the boundary, so they say "anyone who talks to [Fern]", and this deploys with them, never before.

**As built (TASK-1213).** Follow-ups to TASK-1209, closed except where noted above.

- **An unrecognized stored source fails closed.** `AgentContextSource` gains `'unrecognized'`. session-postgres and ipc-core read a stored source they can't place as `unrecognized`, not `external`. On a team agent that means recall reads shared rows only and names nobody. The `/memory` view is decided when the session opens, by the build that opened it (`sandbox:open-session` refuses `unrecognized`), so this build changes recall, not the view. Nothing creates one today.
- **The agent's own name and "a teammate" are refused as member names.** The agent's name comes from the `agents:resolve` answer memory already gets, on team agents only. We compare it as written and as shown, and we only compare it. It is never rendered.
- **The caller's own name counts as a holder.** In the caller's turn, a teammate who takes the caller's display name reads "a teammate". This only runs when another member key is on the page.
- **Name lookups give up after 2 seconds.** It is all-or-nothing: on a timeout the answer names nobody.
- **The `/memory` export names teammates.** Headings and Recent lines use the same member names as recall (current members only; there is no `self` label). Anyone else reads "a teammate".

### Cards

- **A. Drop the remember switch** and its tables, routes, veto and copy, plus the TASK-1191 note. *(As built, TASK-1202: the note stays, since private channels and outsiders' threads still aren't remembered. Card B drops its private case; the outsider case stays.)*
- **B. Private channels remembered, and the notices:** remove the private capture refusal; add the first-invite post, the card line, the web-chat line and the profile description. *(Done, TASK-1203: private channels are remembered from their next thread; see "As built (TASK-1203)" under Telling people.)*
- **C. Team memory is team-shared:** remove the speaker rule, the shared-only recall split and the `/memory` withholding for team agents; attribute speaker facts to the speaker. Security note: one privacy boundary is removed on purpose, and the notices replace it.
- **D. Walk (walk):** private channel remembered and recalled in a public one; the first-invite notice; a person fact recalled with the right name; an outsider's fact not kept; Slack Connect refused; an announcement-only channel where members can reply in threads, recording which `restricted_action…` code Slack returns and that the notice lands in the thread (TASK-1203).

Superseded cards: TASK-1193, TASK-1194 and TASK-1197 close; TASK-1198 (memory keeping the right facts) stays, and runs against the new rules.

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
     host and one per skill. Skills past the 3 get one line after the
     prompts, counting them and linking Today, where they wait (TASK-1155).
     They are not the held-call prompt: held calls are resolved by
     `decisions:approve` and `decisions:dismiss`, never by these.
     - **A host the sandbox was refused** ("Wants to connect to <host>"). The
       host is whatever the sandbox tried to reach, so it is shown only once it
       passes the egress proxy's own host pattern (a plain lowercase DNS name),
       and checked again before it acts. **Allow** calls `proxy:add-host` with
       exactly the prompt's session and host, as the asker; the proxy lets
       only the session's owner do it. The subject ends "Once allowed, it
       stays allowed." Allow is, in order, `proxy:add-host` (the live session;
       only its owner; the "now allowed" line at the next turn) and then
       `host-grants:grant` with the prompt's user, agent and host (the web
       app's "Always for this agent"). The host is kept even when the session
       has already ended, so the line reads "Allowed from now on". If it
       can't be kept (no `host-grants:grant`, an answer that can't be read, a
       refusal: `invalid-host`, `missing-field`, or `invalid-return`, where it
       may in fact have been kept but we can't confirm it), the line
       says "Allowed for now" while the session lives, or "I'd already
       finished working on that" once it has ended.
       A full list (256 distinct sites per agent) says so instead of "Allowed
       from now on".
       **Deny** calls nothing; the host stays refused and
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
- Memory stamps each statement with the audience it was captured in, with no
  exceptions. On a team agent the stamp only drives the "Shared" badge (§4c,
  TASK-1209).
- On a personal agent, a `shared` turn recalls only `shared` statements and
  captures no facts about the speaker, and an outsider's turn keeps that filter
  whatever its stamp. A team agent's turns all recall everything, outsiders'
  included (§4c, TASK-1209); a member's turn files the speaker's facts under
  them, and an outsider's files none.
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
  ID is just another name to memory. Since TASK-1204, in a team agent's member
  turn the names are filed under the runner (`user:<ctx.userId>`), so there a
  subscriber names ONLY the person the turn runs as. An extra name is the
  dangerous direction there: a co-speaker, or anyone else named, would get
  their words or facts about them filed under the runner. Everywhere else an
  extra name only makes memory drop more. channel-slack complies: a thread's
  names are per conversation, and a conversation holds one member's turns.
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

**Admins to tell about a bot request** are a third service hook on the auth
plugin, `auth:list-admins`: `{} → { admins: [{ userId, email }] }` (TASK-1170).

- **Rules:** every account that is an admin now and whose email a provider
  verified, oldest first (then by id). Nothing else: no name, no role, no domain
  verdict. A fault throws; it never answers "nobody". It logs nothing.
- **Caller allowlist:** the same repo scan, `channel-slack-boundaries.test.js`.
- **Alternate implementation:** an OIDC or SCIM directory group of admins.
- **Leaky field names:** none.
- **Caller risk:** using `email` as a Slack identity on its own. channel-slack
  re-proves every DM target through `users.info` and maps the confirmed email
  back through `auth:find-user-by-email`.

**No other new hooks** (apart from `auth:is-approved-email` and
`auth:list-admins` above, and TASK-1095 adds none). TASK-1170 adds no routes
either: the interactions route gains a Decline action id. TASK-1095 adds one more public route,
`POST /slack/interactions/<installId>`, signed like the events
(the signature, the install and the admission check run before the body
is read; the `/ax` route is removed, TASK-1186), and decisions' attendance now covers origin `'slack'`.
TASK-1167 adds four more routes and no hooks: `POST /settings/slack/:agentId/bot`
(ask for the agent's own bot), `…/bot/install-url` (pick a pending one back up
in Slack), `…/bot/cancel` (take a pending one back), all from agent settings
and CSRF-checked, and `GET /slack/bots/oauth/callback`, where Slack sends the
approver after Allow. It lands on `/?slack-bot=connected`, `cancelled` or
`failed`, plus `agentId` when it knows one (an AX admin's approved bot lands on
`/?slack-bot=<outcome>&from=admin` instead, with no agent id).
TASK-1169 adds five more routes and no hooks, all CSRF-checked: `POST
/settings/slack/:agentId/bot-request` and `…/bot-request/cancel` from agent
settings, and for AX admins `GET /admin/slack/bot-requests` and `POST
/admin/slack/bot-requests/:requestId/approve` and `…/decline`. Slack's deliveries to a bot reach
the same three signed routes, by the bot's own install id.
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

- **A website Allow on a team agent covers the whole team** (TASK-1208,
  TASK-1212). Allowed sites belong to the agent: every member's later
  sessions, outsider turns and routine runs of that agent reach them. This
  widens a capability on purpose. Owners and team admins see and remove sites
  in the agent's settings > Connectors. A late Allow (a day-old prompt, or a
  web "Always" after the session ended) is kept, and its "now allowed" line
  arrives at the agent's next fresh session (an outsider's turn reaches the
  site but isn't told, per TASK-1091). A teammate's session that is
  already running learns of a new site only at its next fresh spawn. A web
  "Always" clicked mid-turn and then idle-reaped before the next message gets
  no line.
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

- *(Gone with the switch, TASK-1202.)* **The switch is read when a turn starts.** A thread stays out of memory
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

**Known gaps, accepted (TASK-1184).** Where a gap below talks about the shared
app's connected channels, TASK-1186 retired that path (§4b.1); a team bot's
bindings are the only ones left.


- **The one-minute window.** Only an allowed answer is kept, for a minute. A
  turn that starts inside that minute still runs, and a turn already running
  finishes. A refusal or a failure is never kept, and an allowed answer that a
  refusal overtook is dropped, so nothing stays open past the minute.
- **Continuations aren't checked again, for up to a day.** *Closed by
  TASK-1188: the Allow's gate now runs the same check (§4b.3 as built).* After an Allow,
  the continuation streams into the thread of the turn that asked. The
  Allow's own gate (`answers.ts`) only checks that the channel is still
  connected to the agent, and a prompt can be answered for 24 hours
  (`PROMPT_TTL_MS`; a restart ends it sooner). So a channel made private
  after its prompt was posted still gets the reply, unless a turn there has
  disconnected it first. It's worse for a channel shared with another
  company: it mostly stays connected (below), and the click path has no
  Slack Connect screen, so an Allow within those 24 hours can stream a reply
  in front of the other company. This was already so before TASK-1184; a
  follow-up card owns it.
- **Memory may learn from window turns.** Turns that ran inside the minute can
  feed memory until the binding goes. After that, the veto refuses the
  channel's threads.
- **A spurious `channel_not_found` disconnects.** If Slack wrongly says a public
  channel is gone, we disconnect it.
- **What Slack names in a `missing_scope` is unmeasured.** A token that can't
  read public channels at all (its app reinstalled without `channels:read`)
  gets `missing_scope` for every channel, just like a channel made private.
  We tell them apart by Slack's `provided`, the scopes the token holds: if it
  lacks `channels:read`, the answer is about the token, not the channel, so
  no turn runs, the connection stays, and the sender hears that a team admin
  must look. Without `provided`, only a `needed` of exactly `channels:read`
  reads that way. Nobody has recorded what Slack sends in either case; the
  next Slack walk does (the TASK-1184 plan's walk note).
- **Connected again on the shared app, a channel starts with memory on.** That
  is the cost of every disconnect this check makes, not only a spurious one:
  once the channel is public again, a team admin must connect it again, and
  that new connection starts with memory on, like any Disconnect plus Connect,
  whatever the team had set. A bot binds it again at its next mention, with the
  team's switch.
- **A bot's removal leaves the agent's shared binding.** The shared bot steps
  aside before its own check, so settings may list the channel as waiting for an
  `/invite`.
- **The stored channel name isn't refreshed** from the new answer.
- **Cold turns each ask.** Two turns in one channel with nothing kept each ask
  Slack.
- **A channel shared with another company mostly stays connected.** Its events
  are dropped before any turn (§1 rule 6), so it is never answered, but only a
  turn already waiting when it was shared, or a mention while the share is
  pending, reaches the check that disconnects it. Settings go on listing it.
- **Slack's conversion, archive and share events aren't subscribed.** We learn
  at the next turn, not when it happens.

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
| — | Configuration tokens | Access tokens expire after 12 hours (we hit `token_expired`). `tooling.tokens.rotate` returns a new pair. **The old refresh token keeps working for a while, then Slack refuses it** (`invalid_refresh_token`), so AX stores the new one on every rotate (TASK-1129). How long "a while" is isn't pinned down. The TASK-1097 walk saw it work four times over 18 s, then found it dead about 6 minutes after the first rotate on one install and within 3 hours on the other. The 6 minutes has a confound: the admin also saved an Interactivity change on api.slack.com in that gap, which may be what retired it. The walk report names no confound for the 3 hours. The spike reused the old one before Slack refused it, and read that as "keeps working". Earlier access tokens kept working in the spike, which also checked within minutes. `auth.revoke` kills an access token, but **its refresh token still mints new ones afterwards**. Only Revoke on Slack's configuration-tokens page ends it (§3). That Revoke also ends the refresh tokens rotates have minted since (measured, TASK-1163 check 4: the token AX held failed at `rotate` with `invalid_refresh_token`). | Tested (spike; corrected by the TASK-1097 and TASK-1163 walks) |
| — | Plan limits | Free Slack: at most 10 custom or third-party apps (§4). | Docs |

## 8. Open questions

1. ~~**Memory on external turns.**~~ **Decided 2026-11-12 (Vinay):** decide by
   who sees the reply. See §2a.
2. ~~**Choosing a personal agent.**~~ **Decided 2026-11-24 (Vinay; TASK-1238):** a button in a personal agent's Slack settings ("Use Juniper instead"), not a slash command. One choice per person, kept by channel-slack and checked on every DM: a chosen agent that is gone, or is no longer the person's own personal agent, falls back to the oldest. It applies to the messages after it; a turn already running or waiting finishes on its agent, and a reply in an older thread starts a new conversation with the chosen agent.
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
   decomposing phase 2. **Stored once per person** (decided 2026-11-20, Vinay;
   TASK-1175): one rotating token per approver, used for every Slack app they
   made through AX.
7. ~~**How many prod channels are connected to team agents through the shared
   app?**~~ **Moot 2026-11-21 (Vinay):** prod has no real users yet, so §4b
   deletes the shared app's channel connections outright, with no count and no
   migration. The same answer retires the phase 2 deploy prerequisite (a prod
   query for channels switched off and then disconnected): there's no real
   setting to keep.

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
decided 2026-11-19: the approver's own token. Also a prerequisite: TASK-1175,
one configuration token per person, shared by every app they made (so
approving a second app never breaks the first).

- **8.** Request a bot (name and avatar), approval by the owner or an AX admin,
  creating and installing the app, its own events URL and signing secret,
  moving already-connected channels to the new handle, rename and avatar change,
  and deleting the bot when its agent or team is deleted or it's disconnected.
  Too big for one PR: decompose with `auto-ship --design`.
  *Progress:* TASK-1167 built the self path: a team admin requests the bot
  and approves it with their own token, the shared bot steps aside once it's
  live, and deleting the agent deletes it. TASK-1169 built asking an AX admin
  to approve (see "As built (TASK-1169)" in section 4). TASK-1173 built Replace of a live
  bot, Rebuild, and Claim (see "As built (TASK-1173)" in section 4).
  TASK-1171 built rename and picture change (see "As built (TASK-1171)" in
  section 4).
  TASK-1168 lists the already-connected channels that still need the new
  handle, and refuses connecting the agent through the shared app once its bot
  is live. TASK-1172 did Disconnect and the Admin › Slack list. TASK-1180 gave
  each bot channel its memory switch, and keeps the agent's switch for a
  channel after a Disconnect. TASK-1170 DMs the admins about a request and
  tells the owner how it went.
- **9. Walk (walk).** Done 2026-11-21 (TASK-1174, passed).

**Phase 2b: one bot per team agent, simpler (§4b)**

- TASK-1186–1189, cards A–D in §4b ("Order and cards"). Land them before phase 2 deploys.
