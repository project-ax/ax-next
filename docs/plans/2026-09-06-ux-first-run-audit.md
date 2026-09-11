# UX audit — first-time, non-technical user pass (2026-09-06)

Source: full UX audit of `packages/channel-web` on branch `ux/first-run-simplifications`
(working tree as-is). Method: five surface audits applying the project's four UX lenses
(simplicity, progressive disclosure, clear errors, inline help). Every finding is tagged
by code-cost: **[S]** hours (copy/defaults/hiding) · **[M]** ~a day · **[L]** structural.
The design intent: hide complexity from a first-time non-technical user without adding
much underlying code complexity — bias hard to [S]/[M].

## Overall verdict

The workspace surface (TodayView, AgentRail, DecisionRow, HomeComposer) is exemplary and
is the house standard. Complexity leaks concentrate in four systemic patterns:

1. **The permission-grant card is the weak link in the trust chain** — the capability-grant
   `PermissionCard` is where first-time users freeze (raw slug title, unlabeled credential
   field, jargon hostnames, silently disabled button).
2. **Raw machine identifiers surface in user-facing strings** — slot names, skill slugs in
   dialog titles, `ownerId` + model refs in agent cards.
3. **Vocabulary drift** — session vs conversation vs chat; credential vs key; "slot".
4. **The classic-chat surface silently fails where the workspace refuses to** — failed
   fetches render as empty lists, rename silently no-ops, dead close buttons.

## Findings (severity-ranked per surface)

### A. Chat core — the conversation + approvals

- **A1 [Critical, S]** `PermissionCard.tsx:354-366` — credential slot input: `<Label>`
  renders the raw slot id (`api_key`); `<Input type="password">` has no placeholder, no
  description, no "where do I find this". The single trust moment of the product. Fix:
  humanized label + muted helper line under the label; "Where do I get this?" link when a
  URL is available.
- **A2 [Critical, S]** `PermissionCard.tsx:457` — skill card title is raw `Approve
  {request.skillId}?`; no plain-language statement of what "Approve" does (unlike
  `ApprovalCard.tsx:158-162` which reassures). Fix: friendly display name in title
  (fallback to id) + one plain sentence above the buttons: "Approving lets this agent do
  this from now on. Nothing happens until you choose, and you can change it later in
  Settings."
- **A3 [Important, M]** `ChainOfThought.tsx:37-42` + `Thread.tsx:78-84` — a FAILED tool
  step still reads "Ran a command" in the collapsed header; failure hidden behind a
  success-sounding label. Fix: pass failed/held count into the label fn; branch to
  "Couldn't finish a step" / "Waiting for you", tint `text-destructive`/`text-warning`.
- **A4 [Important, S]** `transport.ts:146-147` — provider-unknown error tells everyone to
  "add that provider's key in Model config" (admin-only surface). Rewrite: "This agent
  can't run right now — the AI service it uses isn't set up on this server. An admin can
  fix this in Settings." Keep specifics on console detail.
- **A5 [Important, S]** `PermissionCard.tsx:368-378` — "Installs npm packages → reaches
  `registry.npmjs.org`" is dev jargon. Rewrite: "It will download some extra software it
  needs from the internet to do this."
- **A6 [Important, S]** `PermissionCard.tsx:409-414, 482-487` — Approve disabled silently
  when a slot is blank. Fix: muted helper "Add the key above to continue" gated on
  `!allSlotsFilled`.
- **A7 [Important, M]** `Composer.tsx:161-163` — `InThreadApprovals` and `PermissionCard`
  can stack above the composer, recreating the off-screen hazard InThreadApprovals
  documents against. Mitigation [M]: render at most one at a time (grant takes
  precedence) or cap combined height with an internal scroll region. Unified queue = [L],
  rejected.
- **A8 [Important, S]** `Composer.tsx:164-209` — held composer looks broken: disabled
  input keeps "Message…" placeholder; hold line doesn't point at the card. Rewrite hold
  copy: "Answer the request above and we'll carry straight on."
- **A9 [Minor, S]** `AgentStatus.tsx:56` — lowercase console verbs "stop/retry/dismiss" →
  "Stop / Try again / Dismiss".
- **A10 [Minor, S]** `Thread.tsx:122-129` — empty state teaches nothing about what the
  agent can do. Second line → "Ask anything. Your agent can look things up and get real
  work done — and it'll check with you before anything important."
- **A11 [Minor, S]** `PermissionCard.tsx:390-397, 463-470` — raw ⚠ glyph + jargon on
  authored-item banner → shadcn `Alert` with lucide `TriangleAlert`, plain wording.
- **A12 [Minor, S]** `PermissionCard.tsx:326-335` — "Will access" badge row with bare
  hostnames, no lead-in. Lead-in: "To do this, it needs to reach:"
- **A13 [Nit, S]** `ArtifactChip.tsx:56` — "unknown artifact" pill → "File unavailable".

### B. First run & setup

- **B1 [Important, M]** `App.tsx:236-237` — session expiry swaps the whole app for a bare
  `LoginPage` with no explanation. `HTTP_SESSION_ENDED` copy already exists (used inline
  by SignInAgainButton). Fix: optional `sessionExpired` prop on LoginPage rendering a
  non-destructive `Alert`: "Your session ended, so we signed you out to keep things safe.
  Sign in again and we'll bring you right back."
- **B2 [Important, S]** `LoginPage.tsx:31` — sign-in failure copy blames the operator
  first for what is usually the user's own connection. Reorder: "We couldn't start
  sign-in. Check your connection and try again. If it keeps happening, the sign-in setup
  may need a look from whoever installed ax."
- **B3 [Important, S/M]** `LoginPage.tsx:44-66` — hand-rolled `<button>` (bespoke
  hover/translate/focus) violates invariant #6; the FIRST button a user ever touches.
  Replace with `<Button className="w-full">`.
- **B4 [Important, M]** `ui/dialog.tsx:45` + `App.tsx:339-343` — the non-dismissible
  first-run dialog renders a live-looking close X (Radix also fires Escape/outside-click);
  all three silently no-op on first run. Feels broken on the very first interaction. Fix:
  `dismissible`/`hideClose` prop on DialogContent (conditionally render Close, wire
  `onEscapeKeyDown`/`onInteractOutside` preventDefault), passed by NewAgentDialog on
  first run. [S] stopgap: `className="[&>button]:hidden"` + the two preventDefault props.
- **B5 [Important, S]** `SetupShell` (no step indicator) + `NewAgentDialog.tsx:44` —
  wizard never says "Step X of 3"; first-run dialog asks to "Name your agent" without
  saying what an agent is. Fix: `Step n of 3` muted line in SetupShell; dialog
  description: "An agent is your personal assistant in ax. Give it a name to get started —
  it'll introduce itself in a moment." (+ first-run line "This is the one thing we need
  before you can chat.")
- **B6 [Minor, S tone / M resilience]** `App.tsx:223,312`, `FirstRunAutoCreate.tsx:99` —
  boot limbo states are lowercase mono dev aesthetic (`connecting…`), and a hung
  `fetchBootstrapStatus` strands `connecting…` forever. Fix tone: "Getting things ready…",
  "Loading your agents…", "Bringing your agent online…"; sentence-case, add BrandMark.
  [M]: after ~10s show "This is taking longer than usual — try reloading."
- **B7 [Minor, S]** `StepGate.tsx:31`, `StepAdmin.tsx:33`, `StepModel.tsx:52` — fallback
  errors print raw HTTP status: "Something went wrong (500)." Drop the number (console
  it): "Something went wrong on our end. Give it another try in a moment."
- **B8 [Minor, S]** `StepAdmin.tsx:44` — "No password needed; we remember this browser"
  contradicts the Google-only sign-in page. Stop promising the mechanism: "You're the
  first person here. We'll use this to set up your account and sign you back in later."
  (Open question on the underlying auth model.)
- **B9 [Nit, S]** `StepGate.tsx:48` — "Open the setup link from your terminal" → "Open
  the setup link we printed when you started ax".

### C. Workspace & navigation (default landing surface)

- **C1 [Important, S]** `SessionList.tsx:74-91` — failed conversations fetch renders as
  "No conversations yet." (empty-as-claim; the workspace's own H7 rule forbids this). Fix:
  one-line error + Try again on failure.
- **C2 [Important, S/M]** `SessionHeader.tsx:74-75` TODO admits rename PATCH has no
  backend — a discoverable-but-undiscoverable (double-click, no affordance) action that
  silently no-ops. Also a Half-Wired Code Policy issue. Fix [S]: surface failure or gate
  affordance until endpoint exists; [M] if implementing the endpoint, add a hover pencil.
- **C3 [Important, S]** `NewSessionButton.tsx:64` + `AgentMenu.tsx:99-101` — vocabulary
  drift: "new session" vs "conversation" vs "chat". Fix: "New chat" button label;
  AgentMenu: "Your next message starts a fresh chat with this agent."
- **C4 [Minor, S]** `UserMenu.tsx:113-123` — hand-rolled popover (manual outside-click,
  absolute positioning) instead of installed `dropdown-menu`/`popover` primitive.
  Functional; consistency/keyboard-nav debt.
- **C5 [Nit, S]** `UserMenu.tsx:156-184` — theme tri-toggle is icon-only; add visible
  labels or a tooltip.

### D. Admin configuration

- **D1 [Important, S]** `AgentForm.tsx:579` — RoleCard caption leaks internals:
  `${a.visibility} · ${a.ownerId} · ${a.model || '—'}` renders raw owner ids + model refs.
  Humanize: "Personal · Claude Sonnet" (display labels; owner only when meaningful).
- **D2 [Important, S]** `AgentForm.tsx:421-467` — dev-voice errors: "name is required",
  "team is required when visibility is team", "agent must list at least one tool".
  Rewrite warm+actionable ("Give the agent a name.", "Pick at least one tool this agent
  may use — e.g. Bash, Read, Write."). Also hand-rolled destructive divs (559-566,
  959-966) → `Alert` primitive; native `<select>`/radios → installed `Select` where cheap.
- **D3 [Important, S]** `ModelConfigTab.tsx:175-181` — nav says "Default AI model" but the
  tab only picks the fast/cheap helper model (titles, classification). Actively
  misleading. Fix: rename tab + description ("Helper model — used for conversation titles
  and quick tasks. Each agent picks its own chat model on the Agents tab.").
- **D4 [Important, S]** `AddProviderForm.tsx` — OAuth sign-in form (Client ID / Client
  secret / Discovery URL) has zero inline help for a non-technical admin. Add muted
  helper lines (where to get each; plain gloss for Discovery URL).
- **D5 [Important, S/M]** `AuthProvidersTab.tsx:139-155` — disabling the last enabled
  sign-in method can lock every user out with no warning; toggle is a hand-rolled switch
  (installed `Switch` primitive exists). Fix: warning copy/confirm when disabling the
  last enabled provider; swap to `Switch`.
- **D6 [Minor, S]** `TeamList.tsx:44-50` — shows an internal repo doc path
  (`docs/plans/2026-04-24-week-9.5-multi-tenant-handoff.md`) to admins. → "Team
  management is coming soon." Also empty state teaches nothing.
- **D7 [Minor, S]** `ModelConfigTab.tsx:161-170, 237-244` — load error has no Retry
  button (AuthProvidersTab's does); save error interpolates dev message. Align with
  AuthProvidersTab's error+Retry pattern.
- **D8 [Minor, S]** `SkillEditor.tsx:377-379, 734` — live parse errors show raw
  `${code}: ${message}` prefix. Drop the code prefix (keep console).
- **D9 [Minor, S]** `SkillAttachmentsSection.tsx:126-197` — rows show raw skill ids in
  mono; "No skills attached." empty state doesn't teach; "Cannot save: missing skill
  metadata for x,y" is dev-voice. Show description-first rows, teach the empty state,
  humanize the error.
- **D10 [Important, S]** `BundleReviewDialog.tsx:117-123` — "Cold-start request" alert
  instructs "Author the skill in the Catalog tab" — the Catalog tab was REMOVED from nav
  (TASK-125). Stale pointer to a dead surface. Rewrite: author via Skills → "+ Add to
  workspace". Also title "Review {kind} request: {skillId}" → "Review shared skill:
  {name}"; add one line on what Admit means org-wide ("Admit" → consider "Approve").

### E. Skills, connectors, routines, credentials

- **E1 [Important, S]** `CredentialSlotRow.tsx:46,59` + `CredentialSlotForm` usage —
  machine-voice titles: "Set credential for provider anthropic, slot ANTHROPIC_API_KEY";
  button "Set credential". Fix: humanized ("Anthropic API key", "Add key"/"Replace key").
  Same humanization for `humanDestination` cases.
- **E2 [Important, S]** `ConnectorConnectDialog.tsx:345` — per-slot heading renders raw
  `entry.slot` name. Humanize (label first, slot id only as secondary mono).
- **E3 [Important, S]** `ConnectorsTab.tsx:429` — "Update credentials" → "Update key"
  (matches the tab's own "Needs a key" vocabulary). Admin rows carry 5 buttons (Test /
  Set default / Edit / Delete / Connect) — collapse curation actions into a `⋯`
  DropdownMenu like SessionRow's [M].
- **E4 [Minor, S]** `SkillInstallConsentDialog.tsx:82` — "Install {skill.skillId}" title
  embeds the raw slug; connector badges show raw ids. Consent copy itself is exemplary.
- **E5 [Important, M]** `RoutineEditor.tsx` (cron section ~528-548) — raw cron expression
  input (`0 2 * * *`) + IANA timezone string. [S] mitigation: live human-readable preview
  ("Runs at 2:00 AM, every day") + helper line under the field; [M]: friendly day/time
  picker; [L] natural language — rejected. Trigger labels (Interval/Schedule/Webhook) are
  already plain. Interval quick-presets (1d/7d) are good.
- **E6 [Nit, S]** `AllowedSitesPanel` / `SiteAgentsDialog` — verify the same
  humanized-host lead-in as A12 ("Sites your agents may reach:").

## Already right — do not regress

StepModel's Advanced collapsible; AgentForm's collapsed Advanced for new agents;
SkillEditor form-first with raw escape hatch; ChainOfThought collapsed detail;
ApprovalCard / DecisionRow / AgentRail / decision-copy honesty system; TodayView empty
state; HomeComposer routing proposal; KeyForm/CredentialSlotForm "A key is saved" cue;
SkillInstallConsentDialog consent framing.

## Open questions (need a human decision — NOT for autonomous cards)

1. Credential manifests: do skill/connector manifests carry human slot labels +
   "where do I get this key" URLs, or is that a producer-side field to add? (Affects A1.)
2. Auth model mismatch: can an email-created admin lock themselves out (wizard promises
   browser-remembered, sign-in is Google-only)? (Affects B8.)
3. Should a PermissionCard and an in-thread approval ever render simultaneously above the
   composer? (Affects A7's precedence gate.)
4. Session rename: implement the PATCH endpoint or formally park the feature? (Affects C2.)
