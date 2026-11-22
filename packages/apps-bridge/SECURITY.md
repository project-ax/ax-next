# Security — `@ax/apps-bridge`

## What it does

The apps bridge lets an outside apps platform (say, an app builder that runs apps people make) call the connectors an AX agent is signed in to. The platform never gets a credential. It asks AX to make one tool call, and AX answers with what the tool said.

That makes it a new way into AX's credential use from outside, which is exactly the kind of thing we get nervous about. So this file spells out who can get in, what they can do once they're in, and what we know we haven't closed.

The package owns four things, and no other plugin stores them:

- **Link codes**: one-time codes a person makes in AX to link an app to an agent.
- **App links**: which platform app is linked to which agent, and who linked it.
- **Grants**: per app link, which connector and which of its tools the app may use, and in which mode (`builder` or `viewer`).
- **Viewer approvals**: a person's own "yes, this app may use this connector as me, through this agent of mine".

## Reach

- **Its own listener.** The bridge serves on a separate `node:http` server (default port **9092**, host `AX_HTTP_HOST`), never on `@ax/http-server`'s listener. The chart never puts that port on the Ingress. It gets a container port, a Service port and a NetworkPolicy rule that admits only the operator's `appsBridge.allowFrom` peers. Reaching it from the platform's network is the operator's call, on purpose.
- **Off by default.** With no `AX_APPS_BRIDGE_PLATFORM_ID` nothing listens at all. A partial `AX_APPS_BRIDGE_*` set fails the boot rather than starting half-configured.
- **Three routes, nothing else.** `POST /api/apps-bridge/v1/links/claim`, `POST /api/apps-bridge/v1/call`, `GET /api/apps-bridge/v1/apps/:appId/grants`. Any other path is a 404 with no body; a known path with another method (OPTIONS and HEAD included) is a 405 with `Allow` and no body. There are no CORS headers, ever.
- **Limits.**
  - Timeouts: headers 10 s, whole request 90 s, keep-alive 5 s. A request Node can't parse gets one fixed 400 and the socket is closed. A request with an `Expect` other than `100-continue` gets an empty 417 (with the same no-store and nosniff headers), before routing or authentication. After the bridge stops accepting, a request still arriving on an open connection is a 503 and the connection is closed.
  - Bodies: `/call` at most 1 MiB, `/links/claim` at most 16 KiB. A declared `Content-Length` over the cap is refused without reading a byte; otherwise the body is counted as it arrives and refused the moment it passes the cap. Bodies are read only after the caller is authenticated, and a client that sent `Expect: 100-continue` is told to send its body only then. A refusal made before the body was read closes the connection, so a refused client can't make us drain whatever it keeps sending.
  - Tokens: the bearer token and the viewer assertion are each at most 8192 characters.
  - Rates (in memory, sliding 60 s window, at most 10,000 tracked keys): 600 requests a minute per platform on every route, 120 calls a minute per app, 32 calls in flight per platform. An in-flight slot is released however the request ends, client hang-ups included (at any point: while the caller is still being authenticated, while the body is arriving, or mid-call), so a flaky client can't use up the 32 slots.
  - The grants answer carries schemas for at most 4 MiB of tool entries. Past that, tools keep their names and descriptions but their `inputSchema` is `null`.
  - Calls inherit the connector call limits: 45 s budget, 2 MiB reply, one `tools/call`, never retried.
- **Outbound.** The bridge itself fetches only the two JWKS URLs (`https:`, or `http:` on loopback, no credentials in the URL). Every connector call goes through `connectors:call-tool-result` in `@ax/mcp-client`, with its own URL rules.
- **No processes, no files, no env reads** beyond the preset reading `AX_APPS_BRIDGE_*` at boot.

## Authentication

- **The caller, on every request.** `Authorization: Bearer <OIDC ID token>`, the scheme in any case. It is verified against the operator's `issuer`, `jwksUrl`, `audience` and an **exact** `subject` (the platform's workload identity), and maps to one `platformId`. Nothing else counts as authentication. It is checked from the headers alone, before any body byte is read. A key-set outage is `503 unavailable` (`Retry-After: 5`); every other failure is `401 unauthenticated`.
- **The viewer, in viewer mode.** The call carries `viewerAssertion`, a JWT the platform got from its sign-in gateway, forwarded as is. It is verified against a second `issuer`, `jwksUrl` and `audience`, with `exp`, `iat` and `email` required and a max age of 30–3600 s (default 600). An `email_verified` claim, when present, must be `true`. The email maps to an AX account through `auth:find-user-by-email`. The max age is enforced as a whole number in range both when the config is parsed and when the verifier is built, because NaN or Infinity would quietly turn jose's age check off.
- **JWT rules.** Asymmetric algorithms only (`RS*`, `PS*`, `ES*`, `EdDSA`), never `HS*` or `none`. 30 s clock tolerance. `exp` required.
- **No cookies, no sessions, no CORS.** Nothing on this listener reads or sets a cookie, so a browser can't be tricked into calling it with someone's AX session.

## Linking

- A link code is minted in AX, by a person who can manage the agent's connectors (`agents:can-manage-connectors` with `isAdmin: false`: a personal agent's owner, or an admin of a team agent's team; workspace-admin status alone doesn't count).
- `axl_` plus 32 base32 characters (20 random bytes). Only its SHA-256 is stored.
- It expires 15 minutes after minting, works once, is bound to `(person, agent)`, and an agent has at most 10 open.
- At claim time the minter's rights are checked again. A malformed, unknown, expired or used code gets one answer, `link_code_invalid`, so the answer doesn't tell an attacker which.
- There is no way to link an app by typing its id into AX, and a link on its own grants nothing.

## Authorization

A call goes through, in order (the first failure answers):

1. **Link**: the `(platform, app)` is linked.
2. **Grant**: the connector is granted to the app in the call's mode, and the tool is on the grant's list.
3. **Who**: builder mode acts as the person who linked the app, through the linked agent, and that person must still be able to manage the agent's connectors. Viewer mode acts as the viewer, through one of the viewer's **own personal** agents, and only for tools the viewer approved for this app.
4. **Policy**: `tool-policy:evaluate` for `(agent, tool)`. Only a plain `allow` proceeds. `hold` is `approval_required`; `deny` is `tool_not_allowed`. Connector tools are Ask first by default, so a tool works only once both the admin default and the agent allow it.
5. **The hook's own checks**: `connectors:call-tool-result` re-checks that the agent is still the person's, the connector is in the agent's effective set, the URL rules hold, and takes the credential as `(person, agent)`.

The grants route answers only for a linked app whose linker can still manage the agent.

## Untrusted input

- From the platform (and the app code its agents write): every header, the path, the body, `input`, `viewerAssertion`, `appName` and the link code. Request ids are checked against their grammar before use and before they reach a log line. `appName` is normalized (NFC, control and bidi characters removed, at most 80 code points) and is display-only. `input` goes to the connector as the app sent it and is never logged.
- From connector servers: `content`, tool descriptions and input schemas. They go back to the platform only. AX never hands them to a model on this path, and never compiles a schema.
- The body must be valid UTF-8 JSON; bytes that aren't are refused rather than patched.

## Credentials

Credentials never leave AX. The platform gets tool content, descriptions and input schemas, and nothing about URLs, headers, tokens or sign-ins. A refusal body is a closed code (plus an AX approve link for `viewer_approval_required`).

## Logging

One info line per request on the three routes: `apps_bridge_link_claim`, `apps_bridge_call` or `apps_bridge_grants`. It carries the platform id once the caller is authenticated, the app id, connector id, tool and mode once each passed its grammar, and a closed `outcome` and `reason`. It never carries input, content, descriptions, schemas, link codes, app names, tokens, the assertion, the email, headers, the path or URLs. 404s, 405s and requests Node can't parse are not logged, and nothing of a thrown error's message is.

## Residuals

- **A leaked link code** is good for one claim within 15 minutes, for an app the platform names, and the link it makes grants nothing until someone with rights sets grants in AX.
- **Assertion replay.** A viewer assertion can be replayed within its max age (600 s by default). v1 accepts that; a shorter max age narrows it.
- **Other host plugins can call `connectors:call-tool-result`.** It is a named service hook, not an IPC action or a `tool:execute:*` tool, so no runner reaches it, but any host plugin could. That is the same trust we already give host plugins.
- Rate limits live in memory. The host runs one replica, so they hold; more replicas would each have their own.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
