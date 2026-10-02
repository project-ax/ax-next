# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary: a non-technical team member.** Smart, not necessarily technical, here to get a job done. Signs in (Google today) and works with their own AI agent(s): chats, hands off files, connects work tools, installs skills, and sets routines that run without them. They should never be made to feel dumb, and they should never need docs to know what to do on a screen.
- **Secondary: the workspace admin.** The person who installs or operates ax for their team. Sets up model keys, sign-in providers, shared connectors, skills, branding, storage and usage limits, and reviews what agents ask to do.

## Product Purpose

ax gives every person on a team their own always-on AI agent that keeps working when they aren't watching. Each agent has its own sandbox, files, memory, connectors, skills and scheduled routines. Success means a non-technical person can hand real recurring work to their agent, trust what it touched, and correct what it learned, while the admin stays in control of reach and spend.

## Positioning

Open-source, 24/7 agents for teams. Self-hostable, admin-brandable, and built around two commitments a hosted consumer chat product can't truthfully make:

- **Security:** every agent runs in its own sandbox with the smallest set of capabilities it needs; credentials stay on the host and are bound to the sites they're for; connectors and tool reach are disclosed and approved; untrusted content is treated as untrusted at every hop.
- **Cost:** the operator sees and caps spend (usage limits, storage quotas, rate caps), and the product makes cost legible rather than hiding it.

## Operating Context

- One deployment serves a team. The hosted instance is canopyworks.ai; others self-host on Kubernetes (local dev runs on a kind cluster).
- Daily surfaces live in one web app (`packages/channel-web`): Today view, agent workspace (conversation, files, memory, activity rail), settings (connectors, skills, allowed sites), admin (team, models and keys, providers, branding, storage, usage), first-run setup wizard, sign-in.
- Agents act asynchronously: routines fire on schedules, extraction and memory updates happen after the fact, and some actions wait for human approval. The UI has to report state honestly while nobody is watching live.
- Operators pay for model usage with their own keys (API-key-only; no OAuth provider credentials).

## Capabilities and Constraints

- Agents: per-agent sandbox, conversations, durable user files, per-fact memory with Fix / Forget correction, "What I learned in this chat" and "Memory used" signals.
- Connectors: direct-API and remote MCP; shared by default with explicit attachment to an agent; OAuth for MCP connectors only.
- Skills: installable and authored, with install consent.
- Routines: scheduled work that runs without the user present.
- Approvals: agents can be held for review before acting; Stop interrupts a running turn.
- Admin controls: model catalog and keys, sign-in providers and allowed domains, branding (name + logo, applied across the app), storage and usage limits, pausing agents.
- Terminology in use: agent, workspace, routine, connector, skill, memory/fact, allowed sites, approval.
- Architecture constraints that shape UI: plugins talk only through the hook bus; one source of truth per concept; every surface uses the shared shadcn install in `packages/channel-web` with semantic tokens (CLAUDE.md invariant #6).

## Brand Commitments

- **Name:** "ax" (lowercase in UI). Deployments may rebrand name and logo through admin branding, so UI must work with an operator's name and mark, not just ax's.
- **Voice (binding, from CLAUDE.md):** self-deprecating but competent; warm and never gatekeeping; honest about complexity; sarcastic about bad practices, never people. Plain language first, short sentences, "we" over "you". Drop the jokes entirely for security, data loss, or anything where a wrong move costs real harm.
- **Errors** state what happened, why when knowable, and one concrete next action. No bare codes or "something went wrong."
- **One design language:** shadcn primitives plus semantic color tokens; no raw color values or hand-rolled components.

## Evidence on Hand

- Product UI and copy: `packages/channel-web/src` (copy modules such as `decision-copy.ts`, `memory-copy.ts`, `stop-copy.ts`).
- Design and architecture docs: `docs/plans/` (current state: `2026-05-24-current-architecture.md`).
- Screenshots of shipped surfaces are scattered at the repo root (`*-light.png`, `t357-*`, `t455-*`).
- **Absent, do not fabricate:** customer testimonials, logos, case studies, benchmarks, pricing, user counts, compliance certifications.

## Product Principles

1. **The non-technical person is the north star.** Working defaults, one primary action per screen, zero jargon on the default path, advanced controls disclosed progressively.
2. **Show what the agent did and can reach.** Reach, spend and memory are visible and correctable; nothing an agent touches is a surprise.
3. **Least capability by default.** Every grant (connector, site, tool, credential) is explicit, minimal and revocable, and the UI makes that legible rather than burying it.
4. **Honest state for work that happens without you.** Async work, waits, failures and costs are reported plainly, never smoothed over.
5. **The operator owns the brand and the bill.** Rebranding and cost controls are first-class, not afterthoughts.

## Accessibility & Inclusion

No formal standard has been committed. Working assumption from the user base: plain-language copy and keyboard-usable, screen-reader-labelled controls, in light and dark themes.
