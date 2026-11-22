# Apps connector bridge — design and contract

**Date:** 2026-11-21
**Status:** Approved in conversation 2026-11-21 (owner); contract v1 below. Revised 2026-11-21 after the platform side's contract review and AX planning: linking by a one-time code, opaque app ids, tool details in grants, content on tool errors, and the planning corrections (own listener, two more refusal codes, per-approval tool lists, an approve link with no query string, link rights asked as a non-admin). Implementation plan: `docs/superpowers/plans/2026-11-21-apps-connector-bridge.md`.

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
- Renaming a linked app. Its display name is set when the link is claimed; a new name needs a new link.

## Anti-goals

- Any path where an app, the platform, or agent-written code can read a sign-in, token, header or connector URL.
- The platform asserting who owns an app or which agent it may borrow. Links start in AX, from a person with rights over the agent, and grants are set in AX.
- Bypassing `tool-policy` or the agent's effective connector set.

## Approaches considered

| Approach | Verdict |
|---|---|
| Send app traffic through AX's running credential proxy | Rejected: session-scoped, lives in AX's cluster, placeholder `replaceAll` lets code that controls a request make an API echo a secret back, and it would put internet-facing app traffic through the component that guards sandboxes. |
| Platform re-collects sign-ins in its own store | Works standalone (and the platform does that too), but people sign in twice. |
| **AX plugin exposing a narrow, service-authenticated call endpoint** | Chosen. Reuses AX's existing connector access checks; AX keeps the grants. |

## Design

### New plugin: `@ax/apps-bridge`

Fully registered in the presets that serve HTTP (`presets/k8s`, which the production memory preset reuses), reachable from the canary acceptance test (a fake platform calls the endpoint). Owns:

- **Link codes**: one-time codes a person mints in AX to link an app to an agent (below). Only a hash is stored.
- **App links**: `(platformId, appId) → (userId, agentId, appName)`, made when the platform claims a link code. `userId` is the person who minted the code.
- **Grants**: per app link, a connector id, the allowed tools and a mode (`builder` | `viewer`). Set in AX by someone with rights over the agent.
- **Viewer approvals**: `(viewer userId, platformId, appId, connector id) → (viewer's agentId, the tools approved)`, created by the viewer in AX, revocable. The approval records only the tools the viewer was shown (the approve body is `{agentId, tools}`), so a tool the grant gains later needs a fresh approval. Changing a grant's mode clears its approvals, and a deleted connector sign-in removes its grants and approvals even if the connector id lives on.

**Who has rights over an agent** (minting link codes, setting grants, unlinking; for a builder-mode call or the grants answer, the person who linked the app must still have them, or the answer is `agent_unavailable`): `agents:can-manage-connectors`, always asked with `isAdmin: false`. That is a personal agent's owner, or an admin of a team agent's team. Lending an agent's sign-in is the agent owners' call, so workspace-admin status alone doesn't count (the same rule as TASK-813 and channel-slack).

**Viewer's access borrows a personal agent only**: one of the viewer's own (`ownerType: 'user'`, owned by the viewer). A team agent's sign-in is the team's account, so a call through it wouldn't be "as the viewer".

### Linking an app (link-code handshake)

1. In AX, a person with rights over the agent opens agent settings → Apps → **Link an app**. AX mints a one-time **link code** and shows it once:
   - `axl_` followed by 32 lowercase base32 characters (20 random bytes, 160 bits);
   - expires after **15 minutes**, and works **once**;
   - bound to `(userId, agentId)`;
   - only its SHA-256 is stored.
2. The person (or the agent building the app) hands the code to the platform.
3. The platform calls `POST /links/claim` with the app's id, its display name and the code (contract below).
4. AX checks the code: well formed, known, unexpired and unused. It re-checks that the code's person still has rights over the agent, then binds `(platformId, appId)` to that person and agent and burns the code. If the app id is already linked, the answer is `409 already_linked` until that link is removed in AX, and the code is left unused.
5. Grants are then set in AX, on the agent's Apps tab. A link alone grants nothing.

There is no way to link an app by typing its id into AX.

### Reusing connector access without returning nothing

`connectors:call-tool` (TASK-1046) already does the right access checks: the agent is still the user's, the connector is in the agent's effective set, the connector resolves, URL rules and `allowedHosts` hold, and headers come from `credentials:get` as (user, agent). But by design its output carries **no server text** (it exists for approval replay). The bridge needs the result.

So `@ax/mcp-client` adds a sibling service hook, **`connectors:call-tool-result`**, sharing the same checks and limits (factor the steps out, don't copy them). Its output adds the tool's result content, size-capped: on success, and with a tool error (`isError`), so an app can show "issue not found". Boundary review for it:

- *Alternate impl:* a connector runtime that isn't MCP (e.g. a native API adapter) returning the same `{outcome, content}` shape.
- *Leaky fields:* none. `toolKey`, `input` and `content` are generic (`content` is opaque typed blocks).
- *Server text:* the existing hook's no-server-text rule exists because its answers reach people and models inside AX. This hook's content goes only to the apps platform, never to a model or a screen inside AX, so that rule doesn't apply here. The content is still untrusted and capped.
- *Subscriber risk:* none (service hook, single implementer).
- *Caller restriction:* named service hook, not IPC, not `tool:execute:*`, so no runner can reach it.

Before each call the bridge also runs `tool-policy:evaluate` for `(agent, toolKey)` and refuses anything that isn't plainly allowed. Connector tools are Ask first by default (no admin default means `hold`), so a granted tool works only once an admin's default and the agent's own choice are both Allow. The Apps tab lets people grant only such tools.

The connector inventory (`connectors:describe-tools`) also starts keeping each tool's `inputSchema`, as opaque JSON it never compiles, so the bridge can tell the platform what arguments a tool takes.

### Contract v1 (wire)

The shapes live in one zod module, `packages/apps-bridge-contract/src/wire.ts` (it imports only `zod`). The platform vendors a copy from a pinned ax-next commit, and both sides assert its exported `CONTRACT_VERSION = 1` in a test. The package's test pins the file's sha256 (as built, `7b94153a…` at commit `6d5912dda`; the version stays 1 until a change breaks the platform). It uses a `const` type parameter, so vendoring it needs TypeScript 5.0 or newer.

**Where it is served.** Base path `/api/apps-bridge/v1`, on the bridge's **own listener** (default port 9092). The chart never puts that port on the Ingress; it gets a container port, a Service port and a NetworkPolicy rule that admits only the operator's `appsBridge.allowFrom` peers (an empty list denies the port to everyone, the host's own namespace included). Exposing it to the platform's network is the operator's job. (`@ax/http-server` runs one listener and the Ingress routes all of its paths, so a route there couldn't be kept off the public ingress.)

**Operator config.** `AX_APPS_BRIDGE_PLATFORM_ID`, `AX_APPS_BRIDGE_PORT` (default 9092; from the environment, 1 to 65535), `AX_APPS_BRIDGE_CALLER_{ISSUER,JWKS_URL,AUDIENCE,SUBJECT}`, and `AX_APPS_BRIDGE_VIEWER_{ISSUER,JWKS_URL,AUDIENCE,MAX_AGE_SECONDS}` (default 600). With no platform id the bridge is off: no listener, and the Apps tab says the apps platform isn't set up.

**Caller authentication (every request).** `Authorization: Bearer <OIDC ID token>`. Verified against operator config: `issuer`, `jwksUrl`, `audience`, and an exact allowed `subject` (the platform's workload identity). Maps to one `platformId`. No other auth accepted. Operator-neutral: any OIDC workload-identity issuer works.
- Asymmetric signatures only (`RS*`, `PS*`, `ES*`, `EdDSA`; never `HS*` or `none`).
- `exp` required; 30 s clock tolerance.
- The JWKS URL must be https (or loopback http, for tests).
- The token is checked before the request body is read.
- The listener answers an unknown path with an empty 404 and a wrong method with an empty 405, both with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and doesn't log them. An `Expect` other than `100-continue` gets a fixed 417.

**Viewer assertion (viewer mode only).** Field `viewerAssertion`: a JWT the platform received from its sign-in gateway for the current request, forwarded verbatim. Verified against a second operator config (`issuer`, `jwksUrl`, `audience`, max age of 30 to 3600 seconds, checked twice), with `exp`, `iat` and `email` required. An `email_verified` claim, when present, must be true. Its email claim maps to an AX user via `auth:find-user-by-email`. Replay is bounded by the assertion's max age; v1 accepts that.

**Ids.**
- `appId`: the platform's own opaque id (e.g. `app_01JDZ8M5Q4X7RT3VKF0N2C9H6B`), 1–64 characters of `[A-Za-z0-9_-]`. People see the app's `appName` instead.
- `connectorId`: AX's connector id, `^[a-z0-9][a-z0-9_-]{0,127}$`.
- `tool`: the tool's name, 1–128 printable ASCII characters, no spaces.
- `appName`: display-only. Sent once, on claim, at most 200 characters. AX normalizes it with the contract's `normalizeAppName`, in this order: Unicode NFC; whitespace runs become one space (so `"a\nb"` becomes `"a b"`); control, invisible-format and lone-surrogate characters (Unicode Cc, Cf, Cs, bidi controls included) removed; space runs collapsed; NFC once more (a removed character may have kept a letter from its combining mark); trimmed; at most 80 code points. A name that normalizes to nothing is refused.

**`POST /links/claim`**

```jsonc
// request
{ "appId": "app_01JDZ8M5Q4X7RT3VKF0N2C9H6B", "appName": "Expense approvals", "code": "axl_…" }
// 200
{ "appId": "app_01JDZ8M5Q4X7RT3VKF0N2C9H6B" }
```

Refused with `link_code_invalid` when the code is malformed, unknown, expired or used: one answer for all four. `already_linked` when the app id is linked already (the code stays usable). Repeating the claim that already used a code, for the same app id, answers 200 again, so a retry after a lost response is safe.

**`POST /call`**

```jsonc
// request
{ "appId": "app_01JDZ8M5Q4X7RT3VKF0N2C9H6B", "connectorId": "linear", "tool": "list_issues",
  "input": { … }, "mode": "builder" | "viewer", "viewerAssertion": "…" }   // viewerAssertion: viewer mode only, required there
// 200
{ "outcome": "succeeded", "content": [ … ] }                          // MCP content blocks, capped
{ "outcome": "failed", "reason": "tool-error", "content": [ … ] }     // the tool said it failed; may have done part of it
{ "outcome": "failed", "reason": "<closed code>" }
{ "outcome": "unknown", "reason": "timeout" | "interrupted" }
```

`input` must be a plain JSON object. It reaches the connector as the app sent it, own `__proto__` and `constructor` keys included, and touches no prototype.

Content is capped at the connector call's per-reply limit (2 MiB). A bigger reply is `unknown/interrupted`. A call takes at most about 45 s, so use a client timeout of at least 60 s. Never retry a write on `unknown`: it may have happened.

**No answer counts as `unknown` too.** A `/call` that gets no HTTP answer (the connection drops, the client times out, or a proxy in between answers 502/504) may still have run, and may still land after the platform has given up. A call isn't cancelled when its connection goes away. On shutdown the bridge waits up to 9 s for calls in flight and then cuts the connections, while a call's own budget is 45 s. So the platform treats any `/call` without a 200 or a refusal body as `unknown`, and never retries a write automatically. Anything in front of the bridge (a load balancer, a mesh) needs a request timeout of at least 60 s; a proxy with a 30 s default would answer 502/504 for a call that still goes through.

**Refusals, before anything is sent.** Body `{ "code": <code> }`, plus `approveUrl` for `viewer_approval_required` only. Key on `code`, not on the status.

| code | status | meaning |
|---|---|---|
| `invalid_request` | 400 | body or path isn't the contract's shape |
| `unauthenticated` | 401 | caller token invalid |
| `link_code_invalid` | 403 | link code malformed, unknown, expired or used (one answer for all four) |
| `already_linked` | 409 | this app id is already linked; remove that link in AX first |
| `app_not_linked` | 404 | no link for `(platformId, appId)` |
| `not_granted` | 403 | connector not granted to this app in this mode |
| `tool_not_allowed` | 403 | tool not on the grant's list (or its key doesn't belong to the grant's connector), or the agent's policy denies it |
| `approval_required` | 403 | AX policy needs approval for this tool |
| `viewer_invalid` | 403 | viewer assertion missing/invalid/expired, or email isn't an AX user |
| `viewer_approval_required` | 403 | viewer hasn't approved this tool for this app; body includes `approveUrl` (an AX page) |
| `agent_unavailable` | 403 | linked/approved agent gone, no longer the user's, or (builder mode, and the grants answer) the person who linked it no longer manages it |
| `rate_limited` | 429 | per-app or per-platform limit, or too many calls in flight; `Retry-After` |
| `unavailable` | 503 | AX couldn't run its own checks right now (keys or storage); `Retry-After` |

`approveUrl` is an absolute http(s) URL with no query string or fragment, `https://<AX>/apps/approve/<platformId>/<appId>/<connectorId>` (built from the origin of AX's public URL), so it survives sign-in (a query string wouldn't).

Upstream failures reuse `connectors:call-tool`'s closed reasons (`invalid-call`, `not-connected`, `needs-auth`, `unavailable`, `unreachable`, `rejected`, `tool-error`). No upstream text is returned except `content` on success or a tool error.

**`GET /apps/:appId/grants`**: the app's grants, so the platform can tell agents what's available and what arguments each tool takes. No URLs, no credential info.

```jsonc
// 200
{ "grants": [ { "connectorId": "linear", "displayName": "Linear", "mode": "viewer",
                "tools": [ { "name": "list_issues", "description": "…", "inputSchema": { … } | null } ] } ] }
```

`description` and `inputSchema` come from the connector inventory, as the linked agent's sign-in last saw them. They are the connector server's own words (untrusted). `inputSchema` is `null` when the inventory doesn't have one. The grants response has a 4 MiB budget that counts the whole answer so far: the first `inputSchema` that would push it past 4 MiB, and every one after it, becomes `null`. The tools themselves stay listed, so their names and descriptions can carry the answer a little past 4 MiB.

### AX UI (channel-web, shadcn)

- **Agent settings → Apps.** Link an app with a one-time code (above); there is no free-typed app id. Choose connectors, tools and mode per connector; only tools the agent may use without asking can be ticked. Unlink. The person's own viewer approvals on this agent are listed here with Revoke.
- **Approve page** (`approveUrl`): "*{appName}* wants to use Linear as you", with the tools it asks for ("It's asking to use:"). It doesn't promise they'll work: calls check the chosen agent's own tool policy, so the page says each tool also has to be set to Allow on that agent under Connectors. Pick which of your agents' sign-in to use (auto-picked when only one of your agents has the connector), then Allow. The app's name is labeled "The app chose this name.", Allow stays disabled for the first 500 ms after the card shows (so a double-click can't land on it), and inside a frame the page asks to be opened in its own tab instead.

### Logging and limits

One line per request: platform, app, connector id, tool, mode, outcome code. Never input, content, codes, assertions, emails, headers or URLs. Request fields are logged only after they pass their grammar.

Limits are in memory (the host runs one replica, as for other host limits):
- 120 calls a minute per app;
- 600 requests a minute per platform;
- 32 calls in flight per platform.

The call budget and content cap are inherited from the connector call limits.

## Security notes

- New external entry point into AX credential use → `security-checklist` is mandatory in the plan.
- Untrusted input: `input`, `viewerAssertion`, `appName` and the link code come from the platform or agent-written app code. `content`, `description` and `inputSchema` returned to the platform are upstream data; AX doesn't feed them to any model, and never compiles a schema.
- Capability: the endpoint can only do what a grant allows, on tools policy plainly allows, through the same checks a sandbox's connector call gets.
- Linking needs a code minted in AX by someone with rights over the agent, so the platform can't attach an app to an agent on its own. A leaked code is good for one claim within 15 minutes, and the link it makes grants nothing until grants are set in AX.

## Decided in the plan

Listener placement and OIDC config shape, the content cap, the table layout and migrations: see "Builder calls made in this plan" in `docs/superpowers/plans/2026-11-21-apps-connector-bridge.md`.
