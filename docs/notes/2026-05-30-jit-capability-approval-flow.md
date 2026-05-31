# JIT capability-approval flow — when the card fires, and how to approve early (2026-05-30)

**Audience:** anyone wiring, testing, or supporting agent-authored skills that need a
host or a key. **Scope:** the just-in-time (JIT) approval surface for *agent-authored*
cap-bearing skills (the open-mode path). Design: `docs/plans/2026-05-26-just-in-time-capabilities-design.md`.
Decision context: TASK-83.

## TL;DR

A skill your agent writes that needs network access or an API key does **not** go
live the moment it's authored. It lands `pending`, and a human has to approve the
access (and paste any key) before the skill can run. There are now **two** ways to do
that approval:

1. **Just-in-time, in chat** — the default. The approval card fires the first time the
   agent actually tries to use the skill (via the broker's `request_capability`).
   Approve + paste the key right there, and the conversation continues.
2. **Ahead of time, from "My Skills"** — new (TASK-83). A pending cap-skill shows an
   **Approve** button in the My Skills panel, so you can approve it *before* the
   agent's first use and skip the in-chat interruption entirely.

Both write to the *same* records and both keep the human in the loop. We did **not**
make the card fire eagerly the instant a skill is authored — a key prompt for a skill
you might never use is approval fatigue, not security. (See the decision in TASK-83.)

## When does the card fire?

The in-chat approval card (`chat:permission-request` → `PermissionCard`) fires **on
first use**, not on authorship:

- Agent authors a cap-bearing skill via `skill_propose` → the skill lands `pending`
  (the gate is doing its job — nothing with undeclared-but-approved reach ever runs).
- `skills:propose`/`onSkillsProposed` marks the warm session dirty so the skill is
  picked up at the next spawn. It does **not** fire a card.
- Later, when the agent calls `request_capability(<skillId>)` to actually use the
  skill, the broker fires the approval card. You approve hosts + enter the key, the
  session re-spawns, and the original ask is answered.

So: **authoring is silent; using is what prompts.** This matches the just-in-time
design intent (a capability is acquired *at the moment the conversation needs it*).

## How to approve early (before first use)

If you'd rather not wait for the in-chat prompt:

1. Open **My Skills** (top-left avatar menu → My Skills).
2. Under **"Authored by your agents"**, a pending cap-skill shows the status
   **"needs approval"** and an **Approve** button. (An inert pending skill — one that
   needs no host/key — has nothing to approve, so it shows no button.)
3. Click **Approve**. A dialog shows exactly the hosts the skill will reach and a field
   for each key it needs (or "use your existing key" if you've already vaulted that
   service). Same surface as the in-chat card — public info only; the key never goes
   through the model or the transcript.
4. Approve. The key posts straight to the credential store; the skill flips to
   **active**. On the agent's next turn it's already approved — no card.

## How it's wired (for maintainers)

- **Read surface:** `GET /settings/skills/authored` (in `@ax/skills`
  `settings-routes.ts`) now enriches each *pending* listing with
  `pendingCapabilities` — a summary `{ hosts, slots, packages }` parsed from the
  stored proposal manifest. Public manifest data only; never a secret. Active and
  inert-pending skills carry no `pendingCapabilities`.
- **Approve route:** `POST /api/chat/approve-authored-skill` (in `@ax/channel-web`
  `routes-chat.ts`) — the out-of-band twin of `/api/chat/permission-decision`. Auth +
  agent-ACL gated (the `agentId` is accepted from the body, then resolved via
  `agents:resolve`, so you can only approve onto an agent you own) + CSRF-guarded. It
  fires the same authored grant, just with **no `conversationId`**.
- **Grant:** `agent:apply-authored-capability-grant` (in `@ax/chat-orchestrator`)
  accepts an optional `conversationId`. With one (in-chat) it retires the warm session
  / live-widens; without one (early approval) it just writes the approval rows + flips
  the skill active, and the user's next turn cold-spawns with the skill approved.
- **TOCTOU guard:** both paths forward `shown` (exactly what the panel/card displayed).
  The server approves a cap **iff** it's in the current proposal **and** in `shown` —
  an agent that widens its draft between render and click can't sneak in caps you
  never saw.
- **Propose-time hint:** the `skill_propose` tool description (in
  `@ax/tool-skill-propose` `descriptor.ts`) tells the model to say, when it proposes a
  cap-skill, that the skill is waiting on approval and the user can approve it on first
  use **or** ahead of time from My Skills.

## What we did NOT change

- The card still does **not** fire eagerly on `skill_propose`. Just-in-time stays
  just-in-time.
- Capability gating stays strict: approving still requires a human and (for a key)
  the actual key. Nothing auto-grants.
