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
- **Adding an owner lets them change everything the agent does with your connections, including its routines.** Co-owners are fully trusted in phase 1. They can change tools, Instructions, model, skill credential bindings and connectors. The creator's routines and connections act with the creator's identity. So card B's Add-owner confirmation must say this plainly.
- Only owners can change who can use the agent. Only AX admins can change groups. Every write route checks this server-side and fails closed on an unknown audience (TASK-1209's lesson).
- Memory follows §4c: shared with whoever can use the agent. "Before today" memory is included only because the screen says so. There is no hidden split.
- The security checklist runs on phases 1 and 3.

## 8. Open questions

1. **Everyone:** does "Everyone at Canopy" include people added to AX later? Proposed: yes; it's a live rule, not a snapshot.
2. **Slack bot creation for a shared agent:** any owner can set up its bot (the token is theirs). Proposed: yes.
3. **"Specific people" for people outside AX:** no. Only AX accounts can be listed, and Slack outsiders keep today's channel rules.
4. **Should "Same people as…" copy the list or link to it?** Proposed: copy. Linking is what groups are for.

## 9. Found while building phase 1A (TASK-1246)

- Eight write paths took "resolved + personal" as "owner". Phase 1A guards them.
- The creator stays an owner in phase 1.
- Co-owners change settings. Delete, routines and webhooks stay the creator's.
- Memory refuses non-creators until card C. Card B's shared-agent lists should follow card C. (Card C, TASK-1248: done. A shared agent's memory is shared with everyone who can use it.)
- Sharing also exposes files, artifacts (rename, delete, public link), the routine list, Instructions, and the agent's self-identity updates. Card B's confirmation copy should name them, or card C should restrict them. (Card C: left as is. They follow the team rule; card B's confirmation names them. See §10.)
- The sharing settings view carries only id and display name, no email. An unknown person is refused with a generic `unknown-person` that doesn't name the id. So the route can't be used as an account or email lookup. A people-search route for card B's picker is card B's to design.
- The agent's own `update_identity` (author `agent`) and `complete-bootstrap` stay open to anyone who can use the agent. Someone an agent is shared with can steer its identity via chat. Card C should decide. (Card C: decided. Identity is owners-only, even through chat. See §10.)
- Anyone an agent is shared with sees which account its connections are signed in as (the connectors tab shows it, as it does for team agents). On an `everyone` agent that is the owner's Gmail address, company-wide. Card B's confirmation should name it.
- The webhook receiver read now asks the same creator-only rule as the token write (`agents:can-manage-webhook-token`), so a co-owner isn't told "yes" and then refused.
- A chat "Always for this agent" from someone the agent is shared with stays session-only in phase 1A (`kept: false`). Card C applies the shared-agent website rule on purpose. (Card C: done. A sharee's "Always for this agent" is kept on a shared agent.)

## 10. Found while building phase 1C (TASK-1248)

**The rule.** A shared personal agent (`shared: true`) follows the team-agent rules. That covers memory, its Slack bot, outsiders' turns and approvals, and website Allow.

- **Memory names.** `agents:resolve` must admit the id, and the id must also take part. It is an owner, it is on a `list` audience, or it owns a row in this agent's memory (it spoke to it). Someone admitted only through `everyone` who never spoke reads "a teammate", with no name lookup. `everyone` admits every AX account, so without this a crafted `user:<id>` subject could fetch any account's display name. It is the same hole TASK-1209 closed for teams.
- **Just me is unchanged.** Co-owners of a Just-me agent still can't chat with it, because of the per-agent `/memory` export. Open question: should a Just-me agent with co-owners share its memory among them?
- **Narrowing.** Going back to Just me hides what others taught the agent from the creator. The rows are kept, and come back if the agent is shared again. Its Slack bot is left inert until an AX admin removes it or the agent is shared again.
- **Outsiders' approvals** wait for the one owner who set the bot up, not for every owner. Another owner can take over.
- **Slack DMs.** A shared agent never answers DMs. That includes its creator's.
- **Identity is owners-only,** even through chat. `complete_bootstrap` is only offered when the person may change the agent.
- **Files, artifacts, the routine list and Instructions** follow the team rule. Card B's confirmation should name them.
- **Slack wording** names no team now. "A team admin" became "Someone" in the bot-request fallback. About 100 older channel-slack comments still mention teams only. There are no user-facing strings left. A comment sweep is a follow-up.

**Client wording that says "team" on a shared agent (card B, by exact location).** Each line stays true for team agents. On a shared personal agent it names a team that doesn't exist.

- `lib/agent-slack.ts:469` ("Channels are for team agents")
- `lib/agent-slack.ts:492` (`teamAdminCanAdd`)
- `lib/agent-slack.ts:519` (`outsidersUseYourAccess`)
- `lib/agent-slack.ts:521` (`helpLine`)
- `lib/agent-slack.ts:527-528` (needs-claim lines)
- `AgentSlackBotLifecycle.tsx:270` (Take over description)
- `ConnectorsTab.tsx:217` ("Granted by you and your team")
- `ConnectorsTab.tsx:557-558` ("A team admin can remove them")
- `memory-copy.ts:55-56`, `:92-93`, `:192-193` ("for the team", "Team members can fix or forget them")
