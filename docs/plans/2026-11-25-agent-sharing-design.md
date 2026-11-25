# Who can use this agent: one sharing model instead of teams (design)

**Status:** proposed, 2026-11-25. Decided in conversation with Vinay. Review this doc before any cards are cut.

**Goal (Vinay, verbatim):** "simplify ax so there is low cognitive load on users and they can very easily understand concepts and how ax works. everything should feel intuitive and obvious and shouldn't require learning a lot of things or looking up help in documentation."

**What started it:** Vinay wanted colleagues to be able to talk to one of his personal agents. Today the only way is to set up a team, which is too heavy for that. Teams also bring their own vocabulary: team admins vs members, team memory vs personal memory, "team agent" rules in Slack.

## 1. The model: three ideas

1. **Who can use it.** Every agent has one setting:
   - **Just me** (the default; today's personal agent);
   - **Everyone at Canopy** (every AX account in the company);
   - **Groups** and/or **specific people**, with a **"Same people as…"** shortcut that copies another agent's list.
2. **Owners.** Who can change the agent: its settings, connections, Slack bot, and who can use it. The creator is the first owner and can add more, so an agent isn't stranded when someone leaves.
3. **Groups.** Saved lists of people. **Only AX admins** create groups and change their members, on one Admin page, like a company directory. Everyone else just picks groups when sharing. Groups have no owners, roles or settings of their own.

There is no "team" concept for users to learn.

## 2. Everything else follows from "who can use it"

| | Just me | Shared (Everyone, groups or people) |
|---|---|---|
| **Memory** | Private to you | Shared with everyone who can use it (today's §4c rule for team agents) |
| **Its connections** (Gmail, calendar…) | Yours | Used for anyone who can use it |
| **Slack** | You DM the shared app (TASK-1238 picks which agent answers) | Gets its own `@bot` for channels (phase 2 dedicated bots) |
| **Approvals** (held calls) | You | The person asking, if they can use it. Otherwise (someone outside AX in a Slack channel) the agent's owners. |
| **Website Allow** | Per you | For the agent (TASK-1212's team rule) |
| **Who can change settings** | You | Its owners |

**There are no switches for these.** The consequences are shown once, in plain words, when you widen who can use the agent. That decision is the whole interface.

People outside AX in a Slack channel keep today's rules: their own words are never remembered, and requests that need approval wait for an owner.

## 3. Screens

**Agent settings › "Who can use Fern?"** One row with the current choice ("Just me") and a **Change** button. The picker is a single field, like Google Docs sharing: type a name or a group, or choose "Everyone at Canopy". Below it, owners are listed with **Add owner**.

**Widening who can use it shows one confirmation.** It lists only what's true for this agent:

> **Share Fern with Everyone at Canopy?**
> They'll be able to:
> - ask Fern things that use **your Gmail** and **your Google Calendar**;
> - see what Fern remembers, including what you told it before today.
>
> [Remove connections first] [Share]

- "Remove connections first" opens the agent's connections.
- Narrowing who can use the agent (for example back to Just me) needs no confirmation.
- What was shared while the agent was shared stays in its memory. The screen says so when you narrow it: "People who used Fern may still remember what it told them."

**Admin › Groups:** a list of groups. Each group is a name and its members, with add and remove. Nothing else.

**Agent lists:** shared agents show in the lists of everyone who can use them, with a small "Shared by Vinay" line. Owners see **Settings**; everyone else just chats.

## 4. What happens to teams (migration)

- Each team becomes a **group** with the same members.
- Each team agent becomes an agent **shared with that group**. Its owners are the team's admins; if a team has none, its creator.
- The rules we built for "team agents" (§4b/§4c memory, Slack bots, outsiders, website Allow, mention names) are re-keyed from "is this a team agent?" to "is this agent shared?". The behaviour stays the same.
- Prod has no real users yet (Vinay, 2026-11-21), so this is the cheapest time to do it.

## 5. Where it lands in the code

- **One access check, as today.** `packages/agents/src/acl.ts` `checkAccess` is already the single source of truth for "can this user use this agent?". Its team case (`teams:is-member`) becomes an audience check: owner, Everyone, a group member, or a listed person.
- **`agents_v1_agents`:** `owner_type`/`visibility` give way to owners plus an audience (`just-me | everyone | list`, the list holding group ids and user ids). A small owners table and a small groups table. One store each (invariant 4).
- **Credentials** already have `user` and `agent` scopes (`packages/credentials/src/plugin.ts`), so connections attached to a shared agent need no new scope.
- **Call sites that ask "team?" or "member?"** today:
  - `teams:is-member`: about 20 calls;
  - `teams:list-for-user`: about 24;
  - `visibility === 'team'` checks, mostly in channel-web (15 files), agents (7), memory (6) and channel-slack (6).

  These move to the new check. Most are mechanical.
- **Boundary review:** a new `agents:can-use` (or a widened `agents:resolve`) needs the CLAUDE.md boundary answers. No backend vocabulary; the alternate impl is an external directory such as Google Groups.

## 6. Phases

1. **Share a personal agent with Everyone or specific people.** Add "Who can use it?", owners, the confirmation screen and the access check. Shared agents use the existing team-agent rules (memory, Slack bot, approvals) through one "is shared" predicate. This alone delivers what Vinay asked for.
2. **Groups:** the Admin page, and groups in the picker.
3. **Retire teams:** migrate teams to groups and team agents to shared agents, re-key the remaining `team` checks to the audience, and remove team UI. Then remove `@ax/teams`.
4. **Walk on kind** after phases 1 and 3, with real Slack and two people.

Each phase ships on its own and is reversible, up to the migration in phase 3.

## 7. Security

- Sharing an agent shares **its connections**. That's the one real risk, and the confirmation screen names each connection by name before sharing.
- Only owners can change who can use the agent. Only AX admins can change groups. Every write route checks this server-side and fails closed on an unknown audience (TASK-1209's lesson).
- Memory follows §4c: shared with whoever can use the agent. "Before today" memory is included only because the screen says so. There is no hidden split.
- The security checklist runs on phases 1 and 3.

## 8. Open questions

1. **Everyone:** does "Everyone at Canopy" include people added to AX later? Proposed: yes; it's a live rule, not a snapshot.
2. **Slack bot creation for a shared agent:** any owner can set up its bot (the token is theirs). Proposed: yes.
3. **"Specific people" for people outside AX:** no. Only AX accounts can be listed, and Slack outsiders keep today's channel rules.
4. **Should "Same people as…" copy the list or link to it?** Proposed: copy. Linking is what groups are for.
