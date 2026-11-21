# TASK-1187: one Slack card per team agent — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task heading carries its `[tier: …]` tag; dispatch each implementer at the model and effort that tag maps to. Run tasks in order: each one leaves channel-web green.

**Goal:** An agent's Slack settings become one card with three states (Not in Slack, Waiting, Live), a ⋯ menu, problem-only status with one action each, each channel's memory setting in that channel's ⋯ menu, and the §4b.4 help line. None of the plumbing words show on it (design §4b.2, §4b.4; card B of §4b).

**Architecture:** channel-web only, UI and copy. No route, hook, IPC action, wire type, parser or dependency changes. Every call the card makes already exists in `lib/agent-slack.ts`.
- `AgentSlack.tsx` still fetches the status and picks the top-level state.
- `AgentSlackBot.tsx` draws the one card for every bot state. The Live card now holds the channel list (`AgentSlackBotChannels.tsx`) instead of it sitting above.
- A new `AgentSlackMenu.tsx` is the one ⋯ menu, used by the card and by each channel row.
- Rename, Change picture and Reconnect are dialogs exported from `AgentSlackBotChanges.tsx`. Set up again and Take over (Rebuild and Claim in code) stay in `AgentSlackBotLifecycle.tsx`. They open from the menu or from a problem row.
- The card's sentences live in `lib/agent-slack.ts` as `AGENT_SLACK_CARD_COPY`.

**Tech stack:** React with shadcn primitives in `packages/channel-web`, vitest and Testing Library. channel-web's `tsc --build` covers its test files.

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` §4b.2 (`:896-921`) and §4b.4 (`:950-955`). Replace, Rebuild and Claim as built: §4 "As built (TASK-1173)" (`:685-733`). The memory switch: TASK-1180/1182 (`:602-613`). The card brief is in the builder's scratchpad (`cards/TASK-1187-brief.md`). Decisions are in `.claude/memory/decisions/2026-11-21-TASK-1187.md`; the builder appends to it.

**Line numbers are as of `8e92668bb`.** After a merge of `origin/main`, find each spot by the function, test name or heading given here.

---

## Where the brief is wrong or incomplete

Each of these was checked against the code at `8e92668bb`.

1. **No status field says a token stopped working.** A live bot's status carries `approverGone`, `needsClaim`, `viewerIsApprover` and nothing about the token (`packages/channel-slack/src/bots.ts:148-157`, `:962-973`). The design's TASK-1173 as-built text says so (`:695-699`): "A dead token … is told at the change that finds it … not before." The card is UI-only, so the two "token stopped working" rows appear **once a Rename or Change picture is refused with `slack-config-token`**. They are held in the Live card's state until the next re-read. A row that shows on page load needs TASK-1178 item 19 (a server-side "token refused" marker). That is listed under what's left.
2. **"@fern lost its connection to Slack" would be false.** A dead configuration token stops changes: rename, picture, and deleting the app. The bot keeps answering. The router never reads a configuration token; `getConfigToken` is only called from the admin routes, the agent routes, `bots.ts`, `bot-requests.ts` and `config-tokens.ts`. Under the Live title "@fern is in Slack", that line would also contradict the card. So the row reads **"Changes to @fern can't reach Slack right now."**, with **Reconnect**, or "… Ask <name> to reconnect it." The actions are the design's.
3. **"People outside AX" breaks a pinned rule, and it's less accurate.** The live view must never name the product (`__tests__/AgentSlackBot.test.tsx:1029-1069`, from TASK-1093's ux pass: the app is white-labeled through Branding, and prod is branded). An AX user without access to the agent is an outsider too (§2, `:61-65`). So the card says **"outside the team"**, which is already the reviewed wording of the Claim dialog (`AgentSlackBotLifecycle.tsx:267`). This applies to the help line and to the Take over row. Precedent: `mistakes/2026-11-20-TASK-1170.md` ("a card's quoted copy is a draft, not a spec").
4. **"Waiting for an admin to approve @fern": there is no @handle yet.** `requested` and `pending` carry only `botName` (`lib/agent-slack.ts:65-67`). The handle is read from Slack when the bot goes live. Waiting lines use the bot's name without an "@".
5. **"Asking an AX admin is the default" has one exception.** Today the form opens on the install-it-myself path when the viewer's own configuration token is stored (`AgentSlackBot.tsx:282-283`). Keep that exception. Such a person has installed Slack apps here before. An AX admin with a stored token who "asks an admin" would be asking themselves and then approving their own request in Admin › Slack. Everyone else opens on asking an admin.
6. **The file glob misses two files.**
   - `SlackRememberField.tsx` is the switch. It is deleted here.
   - `lib/agent-slack.ts` holds agent-settings copy that has forbidden words: "Rebuild the bot to change it.", "Replace it under Slack token". It also holds the channel lead-in.

   Both are in scope. Some shared files change only in their comments: `components/slack/BotTokenReplaceDialog.tsx`, `components/slack/SlackConfigToken.tsx`, `lib/slack-token-copy.ts` and `components/admin/SlackBotRequests.tsx`. Admin › Slack's behaviour and words don't change.
7. **TASK-1188 (in parallel) also edits channel-web.** Its plan (`git show auto-ship/TASK-1188-slack-private-answer-only:docs/plans/2026-11-21-TASK-1188-private-channels-plan.md`, Task 7) adds `isPrivate` to the bot channel row. That row shows "Private channels aren't remembered" instead of the switch. That is the same row this card rewrites. See Step 0.
8. **Confirmed true.**
   - `dropdown-menu.tsx` is installed and exports everything needed, so no `shadcn add` is needed.
   - TASK-1186's member line is at `AgentSlack.tsx:189-195`. It folds into the Not in Slack state.
   - Every bot route needs the viewer to manage the agent (`agent-routes.ts:539-579`), and Replace also needs the approver. So **Reconnect = `canManage && viewerIsApprover`**.
   - The remember route and its locks are unchanged.

## Step 0: TASK-1188, before Task 2 and again before the PR

```bash
git fetch origin && git log --oneline origin/main | grep -m1 'TASK-1188'
```

- **Not merged (the likely case):** go ahead. The handoff's `learnings:` must tell TASK-1188 two things:
  - The bot channel row no longer has a switch. A private row shows its note in place of "Not remembered", and its ⋯ menu offers no memory item. With no item, the row has no ⋯.
  - `SlackRememberField.tsx` is gone.
- **Merged:** run `git merge origin/main` at the next task boundary.
  - Resolve `AgentSlackBotChannels.tsx`, `lib/agent-slack.ts` and the tests toward this card's row: menu, not switch.
  - Then fold in TASK-1188's rule. When `row.isPrivate`, show its note ("Private channels aren't remembered") instead of "Not remembered", and pass no memory item to `AgentSlackMenu`. Keep its `isPrivate` parsing.
  - Add one test for each.
- The design doc edits here touch §4b.2 only. TASK-1188 edits §2a, §3, §4b.3 and the known gaps, so the two don't overlap.

## Global constraints

- **Invoke the `shadcn` skill before editing UI (Tasks 2–4).** Use installed primitives only: `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `DropdownMenu*`, `Alert`, `Button`, `Dialog*`, `Field*`, `Input`, `Spinner`. Colours come from semantic tokens (`text-muted-foreground`, `border-border`, `text-destructive`, …). No raw colours, and no hand-styled `<div>` standing in for a primitive.
- **The pasted token stays write-only.** It goes in an uncontrolled `TokenField`, is read once on submit, and is cleared as the request goes out, whatever the answer. It is never React state and never in a `value` attribute or the DOM text. A refusal never echoes it. The self path keeps exactly this mechanism (`AgentSlackBot.tsx:281-302`).
- **Menus are not modal.** Every ⋯ goes through `AgentSlackMenu`, which is `<DropdownMenu modal={false}>`. A dialog whose outcome re-reads the status unmounts the trigger, and a modal menu then freezes the page: production, 2026-10-19, `decisions/2026-10-19-AXWM-3.md`. Each menu gets the lock test: `expect(document.body.style.pointerEvents).not.toBe('none')`.
- **Radix in tests.** A trigger opens on `pointerdown`, so use `fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })`, not `click`. A menu item runs **after** the menu closes, in a `setTimeout(0)`, so `await` what it does (`findByRole('dialog')`, `waitFor`). Problem rows are `Alert`s (`role="alert"`). Once one shows, query an error with `within(dialog)`, never a bare `screen.findByRole('alert')`.
- **Never optimistic.** A memory change holds the row at its old state while the write is out, and moves only once the server holds it. The `lib/agent-abilities.ts` rule.
- **The words rule.** The pinned list, matched in rendered text and in every `aria-label`:
  - approver, requester
  - claim and rebuild (every form)
  - shared app, own bot / own Slack bot
  - configuration token(s)
  - the product name `AX`

  It applies everywhere on the card except the install-it-myself path: the self path's steps and token field, and the Reconnect dialog. Code identifiers (`RebuildBotDialog`, `ClaimBotDialog`, `claimAgentSlackBot`, …) keep their names, because the rule is about what people read.
- **Running tests.**
  - One file: `pnpm --filter @ax/channel-web exec vitest run <path>`.
  - The package: `pnpm --filter @ax/channel-web test`.
  - Types, including tests: `pnpm --filter @ax/channel-web build`.

  The filter goes before the script. Run the build as well as vitest: vitest tolerates type errors.
- **Memory.** New rows go only into TASK-1187 shards. Never delete a line under `.claude/memory/`.
- **No hook, route or IPC change,** so no boundary review is needed.

## Copy deck

This is the one source for every string the card shows. `who` is `botWho(bot)`: `@handle`, or the bot's name when Slack never said a handle.

**Card frame (`SlackCard`, all states).** The `CardTitle` (`role="heading" aria-level={3}`, `text-base`) is the state sentence, with no full stop. An optional `CardDescription` sits under it. The ⋯ sits on the right of the header (`CardHeader className="flex flex-row items-start justify-between gap-3"`). The content is `CardContent className="flex flex-col gap-4"`.

| State | Title | Description | Body | ⋯ (label `Actions for {who or botName}`) |
|---|---|---|---|---|
| Not in Slack, manager (admin path, the default) | `{agentName} isn't in Slack yet` | `Add it to Slack, and people can mention it in channels.` | notices (below); field `Bot name`, prefilled; button `Add to Slack` (busy `Asking…`); muted `We'll ask an admin to approve it.`; link-button `I can install Slack apps myself`; muted help line (who = agentName) | none |
| Not in Slack, manager (self path: default when `configTokenStored`, or after the link) | same | same | field `Bot name`; then **either** the two steps and the `Refresh token` field, words unchanged from `AgentSlackBot.tsx:380-404`, **or** (stored token, nothing revealed) `We'll use the configuration token you gave us before.`; then `Slack has the final say: only someone allowed to install apps in your Slack workspace can add it.`; button `Add to Slack` (busy `Adding…`); link-button `Ask an admin instead`; help line | none |
| Not in Slack, anyone else (`!canManage && bot.state !== 'live'`) | `{agentName} isn't in Slack yet` | `A team admin can add it.` | — | none |
| Waiting: `requested` | `Waiting for an admin to approve {botName}` | `Asked on {slackShortDate(requestedAt)}.` | error `Alert` if any; while cancelling, a muted `<p role="status">` holding `<Spinner aria-hidden="true" />` and `Cancelling…` (the Spinner's own `role="status"` must stay hidden) | `Cancel request` |
| Waiting: `pending`, `canContinue` | `Almost there: finish adding {botName} in Slack` | — | button `Continue in Slack` (busy `Opening Slack…`); error; `Cancelling…` | `Cancel request` (only when `installId !== null`) |
| Waiting: `pending`, not `canContinue` | `Waiting for {approver} to finish adding {botName} in Slack` | — | error; `Cancelling…` | `Cancel request` (only when `installId !== null`) |
| Live | `{who} is in Slack` | handle: `Invite it to a channel: ` + `<code className="font-mono">/invite @{handle}</code>`; no handle: `Invite it to a channel with /invite.` | problem rows; the saved notice; the channels; muted help line | manager: `Rename`, `Change picture`, then a separator and `Remove from Slack` (destructive, only when `installId !== null`). Anyone else: no ⋯ |

**Notices above the form** (`none`, manager), in this order:
- After Set up again: `{who} was removed from Slack. Add it again below. It's a new bot in Slack, so invite it to each channel again.`
- `AppLeftOverNote`, unchanged except that `We disconnected the bot` becomes `We removed the bot from Slack`.

**Problem rows (Live).** Each is an `Alert` whose `AlertDescription className="flex flex-col items-start gap-3"` holds the sentence and at most one `Button variant="outline" size="sm"`. They come first in the content.

| When | Sentence | Action |
|---|---|---|
| `approverGone` (shown **alone**: it hides the rows below, because Set up again fixes all of them) | `{who} needs to be set up again. The person who added it to Slack has left.` | `Set up again` when `installId !== null && sharedConnected`. Otherwise no action, and the sentence gains ` You can do this here once Slack is connected again.` (`canManage && !sharedConnected`) or ` A team admin can fix this.` |
| `tokenDead && canManage && viewerIsApprover` | `Changes to {who} can't reach Slack right now.` | `Reconnect` |
| `tokenDead`, anyone else | `Changes to {who} can't reach Slack right now. Ask {approver} to reconnect it.` | none |
| `needsClaim` | `People outside the team can't use {who} right now.` | `Take over` when `installId !== null`; otherwise the sentence gains ` A team admin can fix this.` |

`tokenDead` is the Live card's own state. A `slack-config-token` refusal from Rename or Change picture sets it, a Reconnect that lands clears it, and a re-read resets it because the card remounts. With no `approverGone`, the token row and the Take over row can both show.

**Saved notice (Live, `Alert`).** `Slack has the new picture.` (`AGENT_SLACK_BOT_CHANGE_COPY.pictureChanged`) or `BOT_TOKEN_COPY.replaced(botName)`, both unchanged. Opening any dialog clears it.

**Channels (Live, only when there are any).**
- Lead-in (muted): `{who} has answered in these channels. It remembers what team members say there.`
- List: `<ul aria-label="Channels {who} has answered in" className="m-0 list-none divide-y divide-border rounded-md border border-border p-0">`. No nested `Card`.
- Row: a `Hash` icon and the name; muted `Not remembered` when `remember` is false; for a manager, a ⋯ labelled `Actions for #{name}` holding `Don't remember this channel` (when on) or `Remember this channel` (when off).
- A failed write: the row's `role="alert"` line, `We couldn't change that, so nothing is different. Try again.` (unchanged).

**Help line (muted `text-[12.5px] text-muted-foreground`, last in the Not in Slack manager card and in the Live card).** `If {who} needs your OK for something, it asks the person who asked. For people outside the team, it asks the team admin who set {who} up.`

**Dialogs.**

| Dialog | Title | Description | Buttons |
|---|---|---|---|
| Rename | `Rename the bot` | unchanged | `Cancel` / `Rename` (`Renaming…`) |
| Change picture | `Change the bot's picture` | unchanged | `Cancel` / `Save picture` (`Saving…`) |
| Reconnect (the shared `BotTokenReplaceDialog`, **unchanged**; part of the install-it-myself path) | `Replace your Slack token` | unchanged | `Cancel` / `Replace token` |
| Remove from Slack (`DisconnectBotDialog`) | `Remove {who} from Slack?` | `{botName} leaves every Slack channel it's in, and {@handle, or "mentioning it"} stops working. We'll delete its Slack app.` (unchanged) | `Keep it` / `Remove` (`Removing…`) |
| Set up again (`RebuildBotDialog`) | `Set up {who} again?` | `We'll remove {who} from Slack and delete its Slack app. Then you add it again here. It's a new bot in Slack, so invite it to each channel again. If Slack won't let us delete the old app, it may need deleting by hand in Slack's app settings.` | `Keep it` / `Set up again` (`Removing…`) |
| Take over (`ClaimBotDialog`) | `Take over {who}?` | `Right now {who} answers only team members. Once you take over, it answers people outside the team with your access, and anything it needs approved waits in your Today.` | `Not now` / `Take over` (`Taking over…`) |

**What Rename and Change picture say about `slack-config-token`** (`agentSlackBotChangeErrorCopy`; every other code is unchanged):
- the viewer set the bot up: `Changes to {who} can't reach Slack right now. Reconnect it, then try again.`
- the person who set it up has left: `{who} needs to be set up again before it can be changed.`
- anyone else: `Changes to {who} can't reach Slack right now. Ask {approver} to reconnect it.`

**Unchanged:** the `unavailable`, `no-workspace` and `personal-agent` lines in `AgentSlack.tsx`; every request-form refusal (`agentSlackBotErrorCopy`); the Continue refusal; the Admin › Slack copy shared through `AGENT_SLACK_COPY.generic` and `AGENT_SLACK_BOT_COPY`.

## Review focus

1. **The token stays write-only after the form is restructured.** The field is uncontrolled, it is cleared on submit, and the token appears nowhere in `document.body.innerHTML` after a submit or a refusal. Switching to "Ask an admin instead" sends only the name. Tests: Task 3, Step 1.
2. **Menu, then dialog, then re-read never freezes the page,** and Cancel puts focus back on the ⋯. Tests: Task 2 (menu unit) and Task 4 (Remove through a re-read; the focus check).
3. **Problem rules.**
   - `approverGone` shows alone.
   - The token row appears only after a change found the token dead.
   - Reconnect only for `canManage && viewerIsApprover`.
   - Members see sentences but no actions.

   Tests: Task 4, `describe('live: problems, one action each')`.
4. **The words scan covers every view except the install-it-myself path.** A positive control proves the matcher catches each word (Task 1). The self path is opened nowhere in the scan (Tasks 3 and 4).
5. **Memory rows aren't optimistic,** and a 403, 404 or 409 re-reads the status. Tests: Task 2.
6. **Admin › Slack is unchanged.** The shared files change in their comments only.

---

### Task 1 [tier: mechanical]: The card's words, `botWho`, `agentSlackBotTokenDead` and the words matcher

`security-checklist`: not required, because this task only adds strings and pure helpers.

Everything here is **added**. Nothing existing changes yet, so the components and their tests stay green. Tasks 2 and 4 switch to these exports and delete what they replace.

**Files:**
- Modify: `packages/channel-web/src/lib/agent-slack.ts` (add after `AGENT_SLACK_COPY`, `:438-443`)
- Modify: `packages/channel-web/src/lib/__tests__/agent-slack.test.ts`
- Create: `packages/channel-web/src/test-utils/slack-card-words.ts`
- Create: `packages/channel-web/src/test-utils/__tests__/slack-card-words.test.ts`

**Produces:**
- `export function botWho(t: InviteTarget): string`: `@${t.handle}` when the handle isn't null, else `t.botName`.
- `export const AGENT_SLACK_CARD_COPY = Object.freeze({...})`. Each value is a string or a function of plain strings, worded exactly as in the copy deck:
  - `notInSlack(agentName)`, `addItLead`, `teamAdminCanAdd`, `adminWillApprove`, `selfPathLink`, `adminPathLink`, `slackHasFinalSay`, `removedNotice(who)`
  - `waitingForAdmin(botName)`, `askedOn(date)`, `finishInSlack(botName)`, `waitingForPerson(person, botName)`, `cancelling`
  - `inSlack(who)`, `inviteNoHandle`, `channelsLead(t: InviteTarget)` (uses `botWho`), `notRemembered`, `dontRemember`, `rememberAgain` (`Remember this channel`), `helpLine(who)`
  - `setUpAgain(who)`, `changesCantReach(who)`, `askToReconnect(who, approver)`, `outsidersCantUse(who)`, `teamAdminCanFix`, `onceSlackIsBack`
  - `reconnectThenRetry(who)`, `setUpAgainFirst(who)`
- `export function agentSlackBotTokenDead(err: unknown): boolean`: `err instanceof AgentSlackError && err.code === 'slack-config-token'`.
- `test-utils/slack-card-words.ts`:

```ts
/**
 * The words an agent's Slack card never shows (design §4b.2, TASK-1187): the
 * plumbing nobody should have to learn, and the product's own name (the app is
 * white-labeled through Branding). Admin › Slack keeps the plumbing words. The
 * install-it-myself path (the self path's token steps and the Reconnect dialog)
 * is the one place "configuration token" may show, so callers never scan it.
 */
const PLUMBING =
  /\b(?:approvers?|requesters?|claim(?:s|ed|ing)?|rebuild(?:s|ing)?|rebuilt|shared app|own (?:slack )?bot|configuration tokens?)\b/gi;
const PRODUCT = /\bAX\b/g;

/** Every forbidden word in `text`, as written there. Empty: clean. */
export function slackCardWordsFound(text: string): string[] {
  return [...(text.match(PLUMBING) ?? []), ...(text.match(PRODUCT) ?? [])];
}

/** What a person can read now: the body's text (menus and dialogs portal into it) and every aria-label. */
export function slackCardText(root: Element = document.body): string {
  const labels = [...root.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label') ?? '');
  return [root.textContent ?? '', ...labels].join('\n');
}
```

- [ ] **Step 1: Write the failing tests.**
  - In `test-utils/__tests__/slack-card-words.test.ts`:
    - `'finds every plumbing word and the product name'`: each of these is found: `the approver`, `its requester`, `Claim bot`, `claimed`, `needs rebuilding`, `Rebuild`, `rebuilt`, `the shared app`, `its own Slack bot`, `its own bot`, `configuration token`, `Your App Configuration Tokens`, `Ask an AX admin`.
    - `'leaves ordinary words alone'`: `slackCardWordsFound` returns `[]` for `Waiting for an admin to approve Quill Bot`, `anything it needs approved`, `Remember this channel`, `Take over`, `Set up again`, `relax`, `max`.
    - `'slackCardText reads aria-labels too'`.
  - In `lib/__tests__/agent-slack.test.ts`, a new `describe("the Slack card's words (TASK-1187)")`:
    - `'botWho names the @handle, else the bot name'`.
    - `'every card line, word for word'`: one `toBe` per key of the copy deck, with `who = '@quill'`, `agentName = 'Quill'`, `botName = 'Quill Bot'`, `approver = 'Ada Lovelace'`.
    - `'agentSlackBotTokenDead: only a slack-config-token refusal'`: true for `new AgentSlackError(502, 'slack-config-token')`; false for `slack-token`, `slack-error`, `409 not-live` and `new TypeError('x')`.
    - `'no card line names a role, a plumbing word or the product'`: call every value with the sample arguments and expect `slackCardWordsFound(line)` to equal `[]`.
- [ ] **Step 2: Run them and see them fail.** `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/agent-slack.test.ts src/test-utils/__tests__/slack-card-words.test.ts`.
- [ ] **Step 3: Implement.** The strings are the copy deck's, character for character, with straight apostrophes as in the rest of the file.
- [ ] **Step 4: Run both files, then `pnpm --filter @ax/channel-web build`.** Both green.
- [ ] **Step 5: Commit.** `git add` the four paths, then `git commit -m "[TASK-1187] Slack card words, botWho, agentSlackBotTokenDead and the words matcher"`.

---

### Task 2 [tier: integration]: `AgentSlackMenu`, and each channel's memory setting in its ⋯ menu

`security-checklist`: not required. The task changes UI over the existing remember route, with no new capability.

Run Step 0 first.

**Files:**
- Create: `packages/channel-web/src/components/workspace/AgentSlackMenu.tsx`
- Create: `packages/channel-web/src/components/workspace/__tests__/AgentSlackMenu.test.tsx`
- Modify (rewrite): `packages/channel-web/src/components/workspace/AgentSlackBotChannels.tsx`
- Delete: `packages/channel-web/src/components/workspace/SlackRememberField.tsx` (its only importer is `AgentSlackBotChannels.tsx`)
- Modify: `packages/channel-web/src/components/workspace/AgentSlack.tsx`. The two `<AgentSlackBotChannels>` call sites (`:120-127`, `:199-206`) drop `agentName`. They stay where they are until Task 4.
- Modify: `packages/channel-web/src/lib/agent-slack.ts`. Delete `AGENT_SLACK_COPY.botChannelsNotice` (`:441-442`); `channelsLead` replaces it.
- Modify: `packages/channel-web/src/lib/__tests__/agent-slack.test.ts`. Delete `"the bot channel line names the bot's @handle, or its name when Slack never said one"` (`:579-582`); Task 1's word-for-word test covers `channelsLead`.
- Modify: `packages/channel-web/src/components/workspace/__tests__/AgentSlack.test.tsx`: `describe("the agent's own bot's channels (TASK-1180)")` (`:479-590`), plus the one assertion at `:158-159`.

**Produces:**
- `AgentSlackMenu({ label, items, disabled? })`, with `export interface AgentSlackMenuItem { label: string; onSelect: () => void; destructive?: boolean }`.
- `AgentSlackBotChannels` props become `{ agentId, canManage, invite, channels, onStale }`.

`AgentSlackMenu.tsx`. Copy AgentConnectors' `RowMenu` (`AgentConnectors.tsx:724-760`) for the non-modal menu and the trigger, and FactsMemory's `MemoryActions` (`FactsMemory.tsx:347-377`) for running the item after the menu closes. Call hooks before the early return.

```tsx
export function AgentSlackMenu({ label, items, disabled = false }: {
  label: string;
  items: readonly AgentSlackMenuItem[];
  disabled?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const chosen = useRef<(() => void) | null>(null);
  // Nothing to offer: no ⋯ that opens onto an empty menu (items are hidden, never drawn disabled).
  if (items.length === 0) return null;
  const pick = (item: AgentSlackMenuItem) => () => {
    chosen.current = item.onSelect;
  };
  const plain = items.filter((i) => i.destructive !== true);
  const takeAway = items.filter((i) => i.destructive === true);
  return (
    // Not modal: an item's dialog can re-read the status and unmount this trigger (2026-10-19 freeze).
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button ref={trigger} type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={label} disabled={disabled}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="shadow-popover"
        // Run the item once the menu has closed, with focus back on the ⋯, so a dialog it opens returns focus here.
        onCloseAutoFocus={(e) => {
          const run = chosen.current;
          chosen.current = null;
          if (run === null) return;
          e.preventDefault();
          trigger.current?.focus();
          setTimeout(run, 0);
        }}
      >
        {plain.length > 0 && (
          <DropdownMenuGroup>
            {plain.map((i) => (
              <DropdownMenuItem key={i.label} onSelect={pick(i)}>
                {i.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        {plain.length > 0 && takeAway.length > 0 && <DropdownMenuSeparator />}
        {takeAway.length > 0 && (
          <DropdownMenuGroup>
            {takeAway.map((i) => (
              <DropdownMenuItem key={i.label} className="text-destructive focus:text-destructive" onSelect={pick(i)}>
                {i.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

The rows in `AgentSlackBotChannels`:
- Keep the local `rows`, `pending` and `errors` state and `remember()` as they are (`:44-69`).
- Render the lead-in `<p className="text-[13px] text-muted-foreground">{AGENT_SLACK_CARD_COPY.channelsLead(invite)}</p>`, then the bordered `ul` from the copy deck, with no `Card`.
- Each `li` (`flex items-center justify-between gap-3 px-4 py-3`) holds three things:
  - the `Hash` icon and the name;
  - a muted `Not remembered` when `!row.remember`;
  - for a manager, `<AgentSlackMenu label={`Actions for #${row.name}`} disabled={pending.has(row.channelId)} items={[{ label: row.remember ? dontRemember : rememberAgain, onSelect: () => void remember(row, !row.remember) }]} />`.
- The row's error line stays under it (`role="alert"`).
- Rewrite the header comment: the memory setting lives in the row's ⋯; a member reads only "Not remembered".

- [ ] **Step 1: Write `__tests__/AgentSlackMenu.test.tsx` (RED).**
  - `'with no items there is no ⋯ at all'`.
  - `'opens on a press, lists its items, and never locks the page'`: `pointerDown` on the trigger, then the menu lists the items, and `document.body.style.pointerEvents` is not `'none'`.
  - `'an item runs once the menu has closed, with focus back on the ⋯'`: click the menuitem, `await waitFor(onSelect called once)`, then `document.activeElement` is the trigger.
  - `'a destructive item comes after a separator, drawn as destructive'`: there is a `separator`, and the item's `className` contains `text-destructive`.
  - `'disabled: the ⋯ is disabled'`.

  Copy the open helper from `AgentConnectors.test.tsx:91-95`.
- [ ] **Step 2: Implement `AgentSlackMenu`, then run it (GREEN).**
- [ ] **Step 3: Rewrite the channel tests in `AgentSlack.test.tsx` (RED).** Add `openMenu(name)` (as in `AgentConnectors.test.tsx:91-95`). The list query becomes `screen.findByRole('list', { name: 'Channels @quill has answered in' })`.
  - **Rewrite** `'live: the channels its own bot has answered in are listed under one line, each with a memory switch'` as `'live: the channels it has answered in are listed under one line, and a channel that is not remembered says so'`. The lead-in is `@quill has answered in these channels. It remembers what team members say there.`; `ops-desk` shows `Not remembered` and `help` doesn't; there are no switches.
  - **Rewrite** `'a manager flips one: the switch holds its old place while the write is out, then lands'` as `'a manager picks "Don't remember this channel": nothing moves while the write is out, then the row says Not remembered'`. Use the deferred write: while it's out, the row's ⋯ is disabled and `Not remembered` is absent. After it resolves, `Not remembered` shows and the ⋯ is enabled again. The call is `rememberBot('a1', 'C0BOTSUP01', false)`.
  - **New** `'a manager turns memory back on with "Remember this channel"'`: on the ops-desk row, the call is `rememberBot('a1', 'C0BOTOPS01', true)` and `Not remembered` goes.
  - **Rewrite** `'a failed flip leaves the switch where it was and says nothing changed'` to go through the menu. The alert text is unchanged, the row still has no `Not remembered`, and there is no re-read.
  - **Rewrite** the `it.each` stale test (`:532-545`) to go through the menu. Unchanged otherwise.
  - **Rewrite** `'a member sees each channel, and the note only where memory is on; no switch'` as `'a member sees each channel and which are not remembered, and no ⋯'`.
  - **Rewrite** `"with Slack not connected, a live bot's channels are still listed, and a manager can flip them"` to go through the menu.
  - **Keep** `'no botChannels (an older host, or no live bot): no list'` and `'an empty botChannels draws nothing either'`, with the lead-in text updated in the `queryByText` regexes.
  - **Keep** `'with no handle, the line names the bot'`. It now expects `Quill has answered in these channels. It remembers what team members say there.`
  - **New** `'the channel menu never locks the page'`.
  - **Update** `:158-159` (`describe("the agent's own bot, in the ready section")`) to the new lead-in and list name.
- [ ] **Step 4: Rewrite `AgentSlackBotChannels.tsx` and delete `SlackRememberField.tsx`.** `git grep -n SlackRememberField` must return nothing. Remove `botChannelsNotice` and its lib test.
- [ ] **Step 5: Run and check types.** `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/AgentSlack.test.tsx src/components/workspace/__tests__/AgentSlackMenu.test.tsx src/lib/__tests__/agent-slack.test.ts`, then `pnpm --filter @ax/channel-web build`.
- [ ] **Step 6: Commit** the paths above, with the deletion: `[TASK-1187] Slack: the ⋯ menu, and each channel's memory setting in it`.

---

### Task 3 [tier: sensitive]: The card frame, Not in Slack, and Waiting

`security-checklist`: not required. No sandbox, IPC, plugin, hook or dependency changes. The tier is sensitive because this task restructures the one form that takes a secret, the pasted configuration token. Review focus 1 is this task's.

**Files:**
- Modify: `packages/channel-web/src/components/workspace/AgentSlackBot.tsx`:
  - the header comment (`:1-51`);
  - `Section` (`:163-175`) becomes `SlackCard({ title, description, menu, children })`, the frame in the copy deck;
  - `AppLeftOverNote` (`:184-201`): only `We disconnected the bot` → `We removed the bot from Slack`;
  - the `none` branch of `AgentSlackBot` (`:217-240`): the notice text becomes `removedNotice`;
  - `RequestForm` (`:262-442`), `Requested` (`:445-491`) and `Pending` (`:493-561`).

  `Live` keeps its current body and passes the old title `Its own Slack bot` to `SlackCard` until Task 4 rewrites it. That keeps every live test green in this task, and none of this task's words scans renders a live bot.
- Modify: `packages/channel-web/src/components/workspace/AgentSlack.tsx`. `ReadySection` (`:185-195`) drops the member paragraph and always renders `<AgentSlackBot>`; the member card is now `AgentSlackBot`'s. Update the header comment (`:1-15`).
- Modify: `packages/channel-web/src/components/workspace/__tests__/AgentSlackBot.test.tsx`: `describe('none')` `:108-366`, `describe('pending')` `:368-530`, `describe('requested')` `:532-589`, the notice tests in `describe('none after a Rebuild (TASK-1173)')` `:963-1027`, and `describe('words')` `:1029-1045` (its first test).
- Modify: `packages/channel-web/src/components/workspace/__tests__/AgentSlack.test.tsx`: `describe('the states')`, `describe("the agent's own bot, in the ready section")`, `describe("a cancelled bot request whose Slack app couldn't be deleted")`, the button names in `describe("a team agent's own live bot")` and `describe('a rebuilt bot (TASK-1173)')`, and a new `describe('words (TASK-1187)')`.

**The behaviour.**
- **`AgentSlackBot`.** When `!canManage && bot.state !== 'live'`, it returns the member card from the copy deck, in place of `null` for `none`, `requested` and `pending`.
- **`RequestForm`.**
  - Keep `way`, `revealed`, `showToken`, `tokenRef`, `submit()` and the error mapping exactly as they are. That includes the default `useState<Way>(configTokenStored ? 'self' : 'admin')`.
  - Remove the `FieldSet`/`RadioGroup` (`:345-378`), and the `RadioGroup*` and `FieldContent`/`FieldLegend`/`FieldSet` imports if nothing else uses them.
  - Order: notice, then the `Bot name` field, then (self path only) the steps, the token field or the stored line, and the final-say line. Then the form error, then `Add to Slack`. Then (admin path) the muted `We'll ask an admin to approve it.`, then the link-button. The help line comes last.
  - Both link-buttons are `<Button type="button" variant="link" size="sm" className="h-auto self-start p-0" disabled={busy} onClick={() => setWay(…)}>`. Leaving out `type="button"` would submit the form.
  - The submit button reads `Add to Slack`, or the busy face (`Asking…` or `Adding…`).
- **`Requested` and `Pending`.**
  - Cancel moves into `<AgentSlackMenu label={`Actions for ${bot.botName}`} disabled={busy !== null} items={…Cancel request…} />` in the card header. `Pending` gives it no item when `installId === null`.
  - `Continue in Slack` stays a visible button.
  - While a cancel is out, show the `Cancelling…` status line.
  - Errors are a destructive `Alert`, as today.
  - The `cancel` and `run` logic is unchanged.

- [ ] **Step 1: Rewrite or add the tests (RED).** In `AgentSlackBot.test.tsx`:
  - Replace the `chooseSelf()` helper: it now clicks the button named `I can install Slack apps myself`. `submit()` clicks `Add to Slack`. Add `openMenu` and `choose(menu, item)` helpers.
  - `describe('none')`:
    - **Rewrite** `'a manager with no stored token sees the steps, the token field (required), the name and the button'`. Split it in two:
      - `'a manager with no stored token: the card says Quill is not in Slack yet, the name is prefilled, and Add to Slack asks an admin'`. Check the heading (level 3) `Quill isn't in Slack yet`, the description, `Bot name` = `Quill`, `We'll ask an admin to approve it.`, the link, the help line, and no token field, steps or `radio`.
      - `'"I can install Slack apps myself" shows the steps and the required token field, and "Ask an admin instead" goes back'`. Use the existing assertions from `:117-128`.
    - **Rewrite** `'with a stored token there is no field and no steps, only the line saying it will be used'`: it now also shows `Ask an admin instead`.
    - **Rewrite** `'defaults to Ask an AX admin when no token is stored, and to self when one is'` as `'opens on asking an admin when no token is stored, and on the install-it-myself path when one is'`. There is no radio: check which link-button shows.
    - **Rewrite** `'Ask an AX admin shows no token field and never sends one'` as `'Add to Slack, by default, asks an admin and sends only the name'`. The assertions are unchanged.
    - **Rewrite** `'a person with a stored token can still choose to ask an admin…'` to go through `Ask an admin instead`.
    - **Rewrite** `'says Slack has the final say either way'` as `'only the install-it-myself path says Slack has the final say'`.
    - **Rewrite** `'switching to self shows the token steps when none is stored, and the button follows the choice'` as `'the link shows the steps, and the button still reads Add to Slack'`.
    - **Keep, with new names and labels:** `'a refused ask shows its line under the name field'`, `'a stale ask re-reads the status and says nothing'`, every self-path request test (`:227-365`), and the busy test, which now expects `Adding…`.
    - **Rewrite** `'a member sees nothing'` as `'a member sees that Quill is not in Slack yet, and that a team admin can add it'`.
    - **New** `'the pasted token never reaches the page'`. Paste `fakeConfigRefreshToken()` on the self path, then submit: `document.body.innerHTML` does not contain it, and the field has no `value` attribute. Repeat with a `slack-refresh-token` refusal, after its line shows. Then paste, switch to `Ask an admin instead`, and submit: `ask` gets `{ botName }` only.
  - `describe('pending')`:
    - **Rewrite** `'the person who started it sees where it stands, Continue in Slack and Cancel request'`. The title is `Almost there: finish adding Quill Bot in Slack`. `Continue in Slack` is a button. `Cancel request` is a menuitem under `Actions for Quill Bot`.
    - **Rewrite** `'another manager sees who is finishing it, and can only cancel'`. The title is `Waiting for Ada Lovelace to finish adding Quill Bot in Slack`, and there is no Continue.
    - **Rewrite** `'a member never sees a pending request'`: a member sees the member card.
    - **Keep, cancelling through the menu:** the Continue, Cancel, not-approver, not-pending, failure and left-over tests. `'Cancel posts the pending bot's id, and with no id (an older host) there is no Cancel'` now expects no ⋯ at all.
    - **New** `'while the cancel is out, the ⋯ and Continue are disabled and the card says Cancelling…'`.
  - `describe('requested')`:
    - **Rewrite** `'a manager sees the waiting line, when it was asked, and Cancel request'`. The title is `Waiting for an admin to approve Quill Bot`; the description is `Asked on …`; the menu holds `Cancel request`.
    - **Keep** `'a date we cannot read shows as it came'`.
    - **Rewrite** `'nothing to anyone else'`: the member card.
    - **Keep, through the menu:** the cancel tests.
  - `describe('none after a Rebuild (TASK-1173)')`: update the notice text to `@quill_bot was removed from Slack. Add it again below. It's a new bot in Slack, so invite it to each channel again.` In the left-over tests, update `We disconnected the bot` to `We removed the bot from Slack`.
  - `describe('words')`: **delete** its first test (`:1030-1045`), because the words scan in `AgentSlack.test.tsx` replaces it. The two live-view tests stay until Task 4.

  In `AgentSlack.test.tsx`:
  - **Rewrite** `'no workspace, with a pending request: it can still be cancelled…'` and `'no workspace, with a request waiting for an AX admin: a manager can still cancel it'` to go through the menu, with the new title.
  - **Rewrite** the `it.each(['none', 'requested', 'pending'])` member test: the heading `Quill isn't in Slack yet`, plus `A team admin can add it.`
  - **Rewrite** `'a manager with no bot sees the setup form, not the "not in Slack yet" line'` as `'a manager with no bot sees Add to Slack, not "A team admin can add it."'`.
  - **Delete** `"a manager sees the request form; a member sees nothing of the bot until it is live"`. The two tests above cover it.
  - In the cancelled-request describe, `cancelThroughReRead` cancels through the menu. `Create the Slack bot` becomes `Add to Slack`, and `We disconnected` becomes `We removed the bot from Slack`.
  - **New** `describe('words (TASK-1187): no plumbing word and no product name on the card')`. For each view, `render` through `AgentSlack`, then `expect(slackCardWordsFound(slackCardText())).toEqual([])`:
    - ready manager, no token;
    - ready manager, stored token, after `Ask an admin instead`;
    - ready member, none;
    - ready manager, requested, and again with its menu open;
    - pending, `canContinue` true and false, each with its menu open;
    - no-workspace manager, requested.

    Add a positive control, `'the install-it-myself path is the one place the token words show'`: open the link, then expect `slackCardWordsFound(slackCardText())` not to be empty.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** the behaviour above. Every sentence comes from `AGENT_SLACK_CARD_COPY`. Rewrite the header comments of `AgentSlackBot.tsx` and `AgentSlack.tsx` for one card with three states and the menu. No "radio", no "Its own Slack bot".
- [ ] **Step 4: Run and check types.** `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/AgentSlackBot.test.tsx src/components/workspace/__tests__/AgentSlack.test.tsx`, then `pnpm --filter @ax/channel-web build`.
- [ ] **Step 5: Commit:** `[TASK-1187] Slack card: the frame, Not in Slack (ask an admin by default) and Waiting`.

---

### Task 4 [tier: integration]: The Live card: ⋯ menu, problems with one action each, channels inside, help line

`security-checklist`: not required. Reconnect opens the shared `BotTokenReplaceDialog` unchanged, and its write-only token handling is its own and already tested (`components/slack/__tests__/BotTokenReplaceDialog.test.tsx`).

**Files:**
- Modify: `packages/channel-web/src/components/workspace/AgentSlackBot.tsx`:
  - `AgentSlackBotProps` gains `channels?: BotChannelRow[]` (live only), and the `live` branch passes it on;
  - `Live` (`:563-672`) is rewritten;
  - `DisconnectBotDialog` (`:678-760`) gets the Remove copy.
- Modify: `packages/channel-web/src/components/workspace/AgentSlackBotChanges.tsx`:
  - **delete `BotChanges`** (`:87-171`);
  - **export** `RenameDialog` and `PictureDialog`, each with a new required prop `onTokenDead: () => void`, called before `setError` when `agentSlackBotTokenDead(err)`;
  - **add** `export function ReconnectDialog({ open, onOpenChange, agentId, bot, onReconnected, onStale })`, which renders `BotTokenReplaceDialog` with exactly the props `BotChanges` gave it (`:159-168`);
  - rewrite the header comment (`:1-42`).
- Modify: `packages/channel-web/src/components/workspace/AgentSlackBotLifecycle.tsx`. Change the Rebuild and Claim copy (`:200-204`, `:266-270`) and the header (`:1-19`). The component names stay.
- Modify: `packages/channel-web/src/components/workspace/AgentSlack.tsx`. Remove both standalone `<AgentSlackBotChannels>` blocks (`:119-128`, `:198-207`) and pass `channels={botChannels}` into `<AgentSlackBot>` in both branches.
- Modify: `packages/channel-web/src/lib/agent-slack.ts`.
  - In `AGENT_SLACK_BOT_CHANGE_COPY` (`:507-517`), delete `tokenNeedsReplacing`, `yourTokenNeedsReplacing` and `tokenDeadApproverLeft`.
  - `agentSlackBotChangeErrorCopy` (`:523-557`) now takes `bot: Pick<Extract<AgentSlackBot, { state: 'live' }>, 'botName' | 'handle' | 'approver' | 'approverGone' | 'viewerIsApprover'>`. For `slack-config-token` it answers `reconnectThenRetry`, `setUpAgainFirst` or `askToReconnect`, in that priority. Update its doc comment.
- Tests: `__tests__/AgentSlackBot.test.tsx`, `__tests__/AgentSlackBotChanges.test.tsx`, `__tests__/AgentSlackBotLifecycle.test.tsx`, `__tests__/AgentSlack.test.tsx` and `lib/__tests__/agent-slack.test.ts`.

**`Live`, concretely:**
- `const who = botWho(bot)` and `const installId = canManage ? bot.installId : null` (as today).
- State:
  - `dialog: 'rename' | 'picture' | 'reconnect' | 'remove' | 'setUpAgain' | 'takeOver' | null`;
  - `tokenDead: boolean`;
  - `saved: 'picture' | 'token' | null`.

  `open(d)` clears `saved`, then sets `dialog`.
- Menu items (a manager only): `Rename`, then `Change picture`, then (when `installId !== null`) `Remove from Slack`, which is destructive.
- `problems` is a small pure function in this file. It takes `{ bot, who, canManage, installId, sharedConnected, tokenDead }` and returns `{ key, text, action: { label, dialog } | null }[]`, following the problem table exactly.
- Content order: the problem `Alert`s; the saved `Alert`; the channels (`<AgentSlackBotChannels agentId canManage invite={bot} channels onStale={onChanged} />`, when `channels.length > 0`); the help line.
- Dialogs: `RenameDialog` and `PictureDialog` (`onTokenDead={() => setTokenDead(true)}`, and `PictureDialog onSaved={() => setSaved('picture')}`), `ReconnectDialog` (`onReconnected={() => { setTokenDead(false); setSaved('token'); }}`, `onStale={onChanged}`), `DisconnectBotDialog`, `RebuildBotDialog` and `ClaimBotDialog`. Each is `open={dialog === …}` and closes with `setDialog(null)`. The props they hand up (`onCancelled`, `onRebuilt`, `onChanged`) are unchanged.
- Gone: the "You set it up." / "Set up by …" line (`:594-602`), the standalone needs-claim paragraph (`:616-620`), and the button row (`:637-669`).

- [ ] **Step 1: Rewrite or add the tests (RED).**
  - **`lib/__tests__/agent-slack.test.ts`:** rewrite `'agentSlackBotChangeErrorCopy: every code has its sentence and its field'` (`:624-656`) and `'… a dead token says who can fix it …'` (`:658-678`). Pass `{ botName: 'Quill Bot', handle: 'quill_bot', … }` and expect the three new lines. The viewer being the approver still wins over `approverGone`.
  - **`AgentSlackBotChanges.test.tsx`:** render each dialog through a test `Harness` that owns `open` (`useState(true)`) and has an `Open` button to reopen it.
    - **Delete** `describe('the bot row')`.
    - **Keep** `describe('Rename')` and `describe('Change picture')` through the Harness. In the picture-saved test, assert that `onSaved` was called, instead of looking for the notice text; the notice is the Live card's now.
    - `describe('Slack token: Replace…')` becomes `describe('ReconnectDialog')`.
      - Keep the replace, refusal and stale tests, through the Harness, asserting `onReconnected` instead of the notice.
      - **Delete** the `'%s gets no Slack token row'` and `'the person who set it up gets a Slack token row…'` tests, and the two notice-clearing tests (`:362-380`), which move to `AgentSlackBot.test.tsx`.
    - **Rewrite** `describe('a dead token: …')`. The three new sentences, and `onTokenDead` is called once for Rename and once for Change picture. A `bot-name-taken` refusal does not call it.
    - **Rewrite** `describe('words')`: the Rename and Change picture dialogs, each with an error showing, have no forbidden word.
  - **`AgentSlackBotLifecycle.test.tsx`:** update the pinned words in `'says what a rebuild does, in the pinned words, and never writes AX'` and `'says what a claim does, …'`. Update the button names: `Rebuild` → `Set up again`, `Claim it` → `Take over`. Update the busy faces: `Disconnecting…` → `Removing…`, `Claiming…` → `Taking over…`. Add `expect(slackCardWordsFound(slackCardText())).toEqual([])` to both "pinned words" tests.
  - **`AgentSlackBot.test.tsx`:**
    - Extend the mocks: `renameAgentSlackBot`, `setAgentSlackBotPicture` and `replaceAgentSlackBotToken` in the `@/lib/agent-slack` mock, and `drawPickedSlackAvatar` in the `@/lib/slack-avatar` mock.
    - `describe('live')`:
      - **Rewrite** `'a manager sees the handle, how to invite it, and who set it up'` as `'a manager sees @quill_bot is in Slack, how to invite it, the help line, and a ⋯ with Rename, Change picture and Remove from Slack'`. Use `toHaveTextContent` on the description, because the `<code>` splits the text node. Nobody sees `Set up by` or `You set it up`.
      - **Rewrite** `"a manager sees the bot's name with Rename and Change picture, even when the handle doesn't match it"`: the title uses the handle, and `Rename` opens on `Quill Bot`.
      - **Rewrite** `'a member sees neither Rename nor Change picture'` as `'a member sees the card and the help line, and no ⋯'`.
      - **Delete** `'a member sees the live line but not who set it up'`; the first test covers it.
      - **Keep** `'with no handle the line names the bot'`: `Quill Bot is in Slack` / `Invite it to a channel with /invite.`
      - **Move** `'a bot that needs claiming says so to everyone who sees it'` to the problems describe.
      - **Rewrite** `'a manager sees Disconnect bot; a member does not'` and `'a live bot with no install id … offers no Disconnect bot, even to a manager'` around `Remove from Slack` in the menu.
      - **Rewrite** the five Disconnect dialog tests (`:676-763`) as Remove from Slack. Title `Remove @quill_bot from Slack?`; buttons `Keep it` / `Remove`. The `onCancelled` payload and the order assertions are unchanged.
      - **New:** `'the card menu never locks the page'`; `'Cancel in a dialog opened from the menu puts focus back on the ⋯'` (copy `FactsMemory.test.tsx:922-935`); `'opening any dialog clears the saved notice'` (moved from Changes); `'a picture that lands says Slack has the new picture, with nothing read again'`.
      - **New** `'channels sit inside the card, under the invite line, and above the help line'`: check order with `compareDocumentPosition`.
    - `describe('live: needs attention (TASK-1173)')` becomes `describe('live: problems, one action each')`:
      - **Delete** the approver-line tests (`:771-790`).
      - **Rewrite** the approver-gone test (`:791-814`) as three cases. A manager with Slack connected gets `Set up again`. A manager without Slack (no `sharedConnected`) gets `… You can do this here once Slack is connected again.` and no button. A member gets `… A team admin can fix this.`
      - **Keep** `'an approver who is still here gets no alert'`, renamed `'nothing wrong: no problem row at all'`.
      - **Rewrite** the three Claim tests as Take over: `Take over` only for a manager, only when needed, only with an install id; it asks first; `claim-not-needed`.
      - **Rewrite** the Rebuild tests as Set up again (`:857-934`). **Delete** `'Rebuild bot sits beside Disconnect bot'`.
      - **Keep** `'the Disconnect dialog hands up the viewer as the approver, and whether the approver is gone'`, going through the menu.
      - **New** `'approver gone shows alone: no Take over, no Reconnect'`, with `{ approverGone: true, needsClaim: true }`.
      - **New** `'a dead token found by Rename: the person who set the bot up gets the row with Reconnect; a reconnect clears it and says the token was replaced'`. Rename is refused with 502 `slack-config-token`. The dialog says `…Reconnect it, then try again.`. Close it, and the card row says `Changes to @quill_bot can't reach Slack right now.` with a `Reconnect` button, which opens `Replace your Slack token`. Paste and submit: `replaceAgentSlackBotToken('a1', TOKEN)` is called, the row is gone, and the notice is `BOT_TOKEN_COPY.replaced('Quill Bot')`.
      - **New** `'a dead token found by Change picture: another team admin is told whom to ask, with no button'`.
      - **New** `'a member never sees a token row'`: there is no menu, so nothing can find the dead token.
      - **New** `'needsClaim for a member: the sentence and "A team admin can fix this.", no button'`.
    - `describe('words')`: **delete** the two remaining live tests (`:1047-1069`), because `AgentSlack.test.tsx` replaces them.
  - **`AgentSlack.test.tsx`:**
    - Add these to the `@/lib/agent-slack` mock: `renameAgentSlackBot`, `setAgentSlackBotPicture`, `replaceAgentSlackBotToken` and `claimAgentSlackBot`.
    - **Rewrite** `"shows the bot's channels and the bot card, and no picker or shared list"`: the list is inside the card (`within(heading.closest('[data-slot="card"]'))`), and `Remove from Slack` is in the menu.
    - **Rewrite** the four tests in `describe("a team agent's own live bot")`, where Disconnect bot becomes ⋯ → `Remove from Slack` → `Remove`. Expect the new titles; the left-over note says `We removed the bot from Slack…`.
    - **Rewrite** `describe('a rebuilt bot (TASK-1173)')` with `Set up again`. In `'no workspace: a gone approver still gets the alert, with no Rebuild button'`, the alert now reads `@quill_bot needs to be set up again. The person who added it to Slack has left. You can do this here once Slack is connected again.`
    - **Extend** `describe('words (TASK-1187)')` with:
      - live manager with channels, with the card menu open and again with a row menu open;
      - live member;
      - each problem row (approver gone ×3; needsClaim, manager and member; dead token, approver and not, reached through Rename);
      - each dialog except Reconnect: open it, scan, close it;
      - the form after Set up again, with the removed notice and the left-over note.

      The Reconnect dialog is the documented exception. Say so in a comment.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** `Live`, the dialog exports, the Lifecycle copy, the `AgentSlack.tsx` plumbing and the lib change. Then `git grep -n "BotChanges\b"` and `git grep -n "Its own Slack bot"` in `packages/channel-web/src` must return nothing, comments included.
- [ ] **Step 4: Run all of channel-web.** `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build`.
- [ ] **Step 5: Commit:** `[TASK-1187] Slack card: Live with the ⋯ menu, problems with one action each, channels inside, the help line`.

---

### Task 5 [tier: integration]: Docs, stale lines, changesets, the ux and shadcn pass, screenshots, final gate

`security-checklist`: not required. The task changes docs, comments and copy only; its reason is recorded in the decisions shard and the PR.

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`. **§4b.2 only.**
  - At `:906-908`, "Today the form opens with a two-way choice, 'Who sets it up in Slack?'." becomes "Until TASK-1187 the form opened with a two-way choice, 'Who sets it up in Slack?'."
  - Add an **"As built (TASK-1187)."** paragraph after the problem table (`:921`). It records:
    - one card, the title as the state sentence, the ⋯ menu;
    - asking an admin is the default unless the person's configuration token is stored;
    - Waiting names the bot, not an @handle;
    - `approverGone` shows alone;
    - the token rows appear only once a Rename or Change picture finds the dead token, and don't survive a reload (TASK-1178 item 19 would persist them);
    - the deliberate copy differences: "outside the team", not "outside AX" (white-labeled; §2's outsiders include AX users without access), and "Changes to @fern can't reach Slack right now", not "lost its connection" (the bot keeps answering);
    - the memory switch is the channel row's ⋯ item, with storage, route and locks unchanged;
    - the help line is on the Not in Slack and Live cards;
    - the words test.
- Modify (comments only; Admin › Slack behaviour unchanged):
  - `packages/channel-web/src/components/slack/BotTokenReplaceDialog.tsx:2-4`: agent settings opens it from Reconnect, the card's problem row, once a change finds the token stopped working.
  - `packages/channel-web/src/components/slack/SlackConfigToken.tsx:3-5`: an agent's Slack card, on its install-it-myself path.
  - `packages/channel-web/src/lib/slack-token-copy.ts:2-4`: an agent's Slack card.
  - `packages/channel-web/src/components/admin/SlackBotRequests.tsx:3-4`: agent settings, "Add to Slack".
- Modify the pending changesets so they don't ship false notes. Nothing in channel-web or channel-slack has been released (no `CHANGELOG.md`); the precedents are TASK-1186 and TASK-995. Change only the sentences that name the old UI:
  - `.changeset/slack-bot-remember-switch.md`: the "switch" → its memory setting, "Don't remember this channel" in the channel's ⋯ menu. "Check those channels' switches" → "Check those channels in the agent's settings: one that isn't remembered says so".
  - `.changeset/slack-bot-replace-rebuild.md`: Replace from the agent's settings → Reconnect, once a change finds the token stopped working (Admin › Slack keeps Replace). "needs rebuilding … Rebuild" → "needs to be set up again … Set up again". "claim" → "take over (Take over)".
  - `.changeset/slack-bot-rename-picture.md`: "the settings say whose token needs replacing" → "the card says who can reconnect it".
  - `.changeset/slack-bot-disconnect.md`: "disconnect … from the agent's settings, pending or live" → "remove … from Slack (Remove from Slack), or cancel a pending one".
- Create: `.changeset/slack-agent-card.md`, `'@ax/channel-web': patch`. Write it in the house voice: one card with three states; Add to Slack, with asking an admin as the default; the ⋯ menus; problems only when something is wrong, with one thing to do; the plumbing words stay in Admin › Slack.

- [ ] **Step 1: Stale lines.** Edit the design doc and the four comments. Then:

  ```bash
  git grep -n "Its own Slack bot\|Slack token. row\|Who sets it up in Slack\|Ask an AX admin\|Rebuild bot\|Claim bot\|Disconnect bot" -- packages/channel-web/src
  ```

  must print nothing. Every hit outside `packages/channel-web/src` is a dated plan or Admin › Slack's own words, which stay.
- [ ] **Step 2: Changesets.** Make the four edits and create the new file.
- [ ] **Step 3: The ux and shadcn pass.** Commit first, because a reviewer runs in this tree. Then dispatch the `ux-designer` agent with **no `name`**. Tell it to `cd /Users/vpulim/dev/ai/ax-next/.claude/worktrees/agent-a2a42de54a684b75c` and run every command there, and give it the diff vs `main` and the screenshots from Step 4. Invoke the `shadcn` skill on the changed components.
  - Apply Critical and Important findings that don't contradict this plan's decisions.
  - Log each deviation, or each finding you declined, as a row in `.claude/memory/decisions/2026-11-21-TASK-1187.md`.
  - Any copy change must keep the words tests green.
- [ ] **Step 4: Screenshots.**
  - Take the three states and one problem state: Not in Slack (manager), Waiting (`requested`), Live with channels (manager), and Live with `needsClaim`.
  - Render them in real Chromium from a throwaway harness that is never committed. For example, a `slack-card-shots.html` plus an entry that renders `AgentSlackBot` with fixture props and the app's CSS, served by `pnpm --filter @ax/channel-web dev`. Capture with Playwright into `<scratchpad>/TASK-1187/`.
  - Delete the harness; `git status --short` must be empty.
  - Attach the shots the way TASK-739 and TASK-740 did: assets-only commits `561d64516` and `b95e329f4`, linked from the PR body, "delete after merge".
- [ ] **Step 5: Final gate.**

  ```bash
  pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint
  ```

  This card changes only channel-web, docs and changesets. If the Docker-backed suites can't run locally, say so in the handoff, and still run `pnpm --filter @ax/channel-web build && pnpm --filter @ax/channel-web test && pnpm lint && pnpm test:scripts`. CI runs the affected packages.
- [ ] **Step 6: Commit:** `[TASK-1187] Slack card: design as-built, stale comments, changesets`.

---

## What's left from TASK-1181 and TASK-1178

Checked against the card bodies in the builder's scratchpad (`cards/TASK-1181-body.md`, `cards/TASK-1178-body.md`).

- **TASK-1181:** nothing fits this card. Items 1–6 are Admin › Slack or server work:
  1. the requests list without the shared app;
  2. a `forbidden` wording and a 404 for a gone request;
  3. a landing for an approver outside the team;
  4. a toast for a demoted approver;
  5. stalled bots and failed Approves;
  6. the setup-wizard admin's DMs.

  All are left as filed.
- **TASK-1178, items that touch the settings UI:**
  - **Done or obsolete.** Item 7 (list the bot's own channels) was done by TASK-1180. The moved-channels list it sat beside is gone (TASK-1186), and this card puts the list inside the card. Item 17 (`stillWaiting`) went with TASK-1186.
  - **Left.**
    - Item 19, a per-person "token refused" marker. It is the prerequisite for a token row that shows on page load; today the row needs a failed change first.
    - Item 10, explaining a refresh after a stale refusal. Today the card re-reads silently.
    - Item 13, picking the picture at request time. It needs server storage on the ask-an-admin path, and it fights "one button".
    - Item 2, saying why an Allow failed (team mismatch). It needs a new return outcome from `bot-callback.ts`.
    - Item 21, the product call on an AX admin re-creating a team's bot.
  - **Server or admin only, left as filed:** items 1, 3, 5, 6, 8, 9, 11, 12, 14, 15, 16, 18, 20, 22, 23 and 24.

## Handoff notes for the builder

- **Learnings to return:**
  - For TASK-1188 (unless it merged first): the bot channel row is a ⋯ menu; a private row shows its note instead of "Not remembered" and offers no memory item; `SlackRememberField.tsx` is gone.
  - For TASK-1189 (the walk), the new labels: Add to Slack, I can install Slack apps myself, Cancel request (⋯), Remove from Slack, Set up again, Take over, Reconnect, and Don't remember this channel (row ⋯). The token row shows only after a Rename or Change picture is refused.
  - One pattern: `AgentSlackMenu` = non-modal plus run-after-close.
- **Follow-ups to propose:**
  - A token row on page load (TASK-1178 item 19).
  - The §4b.3 rule line, if TASK-1188 doesn't add it to the card.
  - The return toast `SLACK_BOT_RETURN_MESSAGES.connected` ("The Slack bot is live…") could say "is in Slack" to match the card (`lib/slack-bot-return.ts`).
