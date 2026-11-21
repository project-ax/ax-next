# Apps connector bridge — design and contract

**Date:** 2026-11-21
**Status:** Approved in conversation 2026-11-21 (owner); contract v1 below.

## Why

An operator may run an external **apps platform** where agents (AX or otherwise) build small internal web apps. Those apps need to call MCP connectors. People have already signed those connectors in on their AX agents, and they should not have to sign in again for an app.

This plugin lets an approved apps platform make connector calls **through AX, using sign-ins AX already holds**, without any secret leaving AX. The platform itself is out of this repo; its design lives with it. This doc is the AX side and the contract both sides build against.

## Goals

1. An app linked to an AX agent can call that agent's connector tools ("builder's access").
2. An app can call connector tools as the **viewing person**, using a sign-in on one of that person's own agents, after the person approves ("viewer's access").
3. AX is the single source of truth for which app may use which connector, which tools, and in which mode.
4. No credential, header or connector URL ever leaves AX. Only tool results do.

## Non-goals (v1)

- Serving API-key credentials to the platform's egress proxy (possible later; not needed now).
- Tools that AX policy says need approval: the bridge refuses them. Nobody is in a conversation to approve.
- More than one apps platform per AX install. (The contract keys everything by platform id so a second one is cheap later.)

## Anti-goals

- Any path where an app, the platform, or agent-written code can read a sign-in, token, header or connector URL.
- The platform asserting who owns an app or which agent it may borrow. Links and grants are made **in AX, by people with rights over the agent**.
- Bypassing `tool-policy` or the agent's effective connector set.

## Approaches considered

| Approach | Verdict |
|---|---|
| Send app traffic through AX's running credential proxy | Rejected: session-scoped, lives in AX's cluster, placeholder `replaceAll` lets code that controls a request make an API echo a secret back, and it would put internet-facing app traffic through the component that guards sandboxes. |
| Platform re-collects sign-ins in its own store | Works standalone (and the platform does that too), but people sign in twice. |
| **AX plugin exposing a narrow, service-authenticated call endpoint** | Chosen. Reuses AX's existing connector access checks; AX keeps the grants. |

## Design

### New plugin: `@ax/apps-bridge`

Fully registered in the presets that serve HTTP, reachable from the canary acceptance test (a fake platform calls the endpoint). Owns:

- **App links** — `(platformId, appId) → (ownerUserId, agentId)`, created in AX by someone who can manage that agent's connectors (`agents:can-manage-connectors`).
- **Grants** — per app link: connector id, allowed tool names, mode (`builder` | `viewer`).
- **Viewer approvals** — `(viewer userId, platformId, appId, connector id) → viewer's agentId`, created by the viewer in AX, revocable.

### Reusing connector access without returning nothing

`connectors:call-tool` (TASK-1046) already does the right access checks — agent still the user's, connector in the agent's effective set, connector resolves, URL rules and `allowedHosts`, headers from `credentials:get` as (user, agent) — but by design its output carries **no server text** (it exists for approval replay). The bridge needs the result.

So `@ax/mcp-client` adds a sibling service hook, **`connectors:call-tool-result`**, sharing the same checks and limits (factor the steps out, don't copy them), whose output adds the tool's result content, size-capped. Boundary review for it:

- *Alternate impl:* a connector runtime that isn't MCP (e.g. a native API adapter) returning the same `{outcome, content}` shape.
- *Leaky fields:* none — `toolKey`, `input`, `content` are generic.
- *Subscriber risk:* none (service hook, single implementer).
- *Caller restriction:* named service hook, not IPC, not `tool:execute:*`, so no runner can reach it.

Before each call the bridge also runs `tool-policy:evaluate` for `(agent, toolKey)` and refuses anything that isn't plainly allowed.

### Contract v1 (wire)

Shared schema module so both sides validate the same shapes. Base path `/api/apps-bridge/v1`, served on a listener the operator can keep off the public ingress.

**Caller authentication (every request).** `Authorization: Bearer <OIDC ID token>`. Verified against operator config: `issuer`, `jwksUrl`, `audience`, and an exact allowed `subject` (the platform's workload identity). Maps to one `platformId`. No other auth accepted. Operator-neutral: any OIDC workload-identity issuer works.

**Viewer assertion (viewer mode only).** Field `viewerAssertion`: a JWT the platform received from its sign-in gateway for the current request, forwarded verbatim. Verified against a second operator config (`issuer`, `jwksUrl`, `audience`, max age). Its email claim maps to an AX user via `auth:find-user-by-email`. Replay is bounded by the assertion's lifetime; v1 accepts that.

**`POST /call`**

```jsonc
// request
{ "appId": "expenses", "connectorId": "…", "tool": "list_issues",
  "input": { … }, "mode": "builder" | "viewer", "viewerAssertion": "…" }
// 200
{ "outcome": "succeeded", "content": [ … ] }            // MCP content blocks, capped
{ "outcome": "failed", "reason": "<closed code>" }
{ "outcome": "unknown", "reason": "timeout" | "interrupted" }
```

Refusals before anything is sent (4xx with a closed `code`):

| code | meaning |
|---|---|
| `unauthenticated` | caller token invalid |
| `app_not_linked` | no link for `(platformId, appId)` |
| `not_granted` | connector not granted to this app in this mode |
| `tool_not_allowed` | tool not on the grant's list |
| `approval_required` | AX policy needs approval for this tool |
| `viewer_invalid` | viewer assertion missing/invalid/expired, or email isn't an AX user |
| `viewer_approval_required` | viewer hasn't approved; body includes `approveUrl` (an AX page) |
| `agent_unavailable` | linked/approved agent gone or no longer the user's |
| `rate_limited` | per-app or per-platform limit |

Upstream failures reuse `connectors:call-tool`'s closed reasons (`not-connected`, `needs-auth`, `unreachable`, `rejected`, `tool-error`, …). No upstream text is returned except `content` on success.

**`GET /apps/:appId/grants`** → the app's grants (connector id, display name, tools, mode), so the platform can tell agents what's available. No URLs, no credential info.

### AX UI (channel-web, shadcn)

- **Agent settings → Apps:** link an app by id (shown by the platform when the app is created), choose connectors, tools and mode per connector; unlink.
- **Approve page** (`approveUrl`): "*expenses* wants to use Linear as you" → pick which of your agents' sign-in to use (auto-picked when only one agent has the connector) → Allow. Revocable from the same Apps settings area.

### Logging and limits

One line per call: platform, app, connector id, tool, mode, outcome code. Never input, content, headers or URLs. Per-app and per-platform rate limits (single-replica in-memory is acceptable for v1, matching other host limits). Call budget and content cap inherited from the connector call limits.

## Security notes

- New external entry point into AX credential use → `security-checklist` is mandatory in the plan.
- Untrusted input: `input` and `viewerAssertion` come from agent-written app code. `content` returned to the platform is upstream data; AX doesn't feed it to any model.
- Capability: the endpoint can only do what a grant allows, on tools policy plainly allows, through the same checks a sandbox's connector call gets.

## Left to the builder

- Listener placement and config shape for the OIDC verifiers.
- Content size cap value.
- Exact table layout and migrations.
