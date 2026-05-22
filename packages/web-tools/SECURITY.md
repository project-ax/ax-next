# @ax/web-tools — security notes

We give agents web search + page extraction without poking a single hole in the sandbox.

## How the egress stays locked

The sandbox can't reach the internet — that's by design, and we kept it that way.
These tools run on the **host** (`executesIn: 'host'`), and even the host doesn't
fetch arbitrary pages: it asks **Anthropic** to do the search/fetch server-side and
hands back the results. So the only outbound connection is to `api.anthropic.com`,
which we already trust. No new egress surface, no SSRF surface we own.

## The thing we stay paranoid about

Web content is **untrusted** — it's a classic prompt-injection vector. We never
interpret fetched text on the host; it flows back to the agent as tool output,
which the agent already treats as untrusted. The fetch runs in an isolated,
minimal-context call (just "fetch this URL") so a malicious page can't see the
agent's transcript or any secrets.

`web_extract` also runs a defense-in-depth URL guard (`url-guard.ts`) that refuses
non-`http(s)` schemes and internal/private/metadata addresses before we spend an
API call — belt and suspenders, since Anthropic can't reach our cluster anyway.

## Operational note

Web search must be enabled once by an org admin in the Claude Console. Web search
bills ~$10 per 1,000 searches; `web_extract` has no per-fetch fee. The whole plugin
can be turned off with `createWebToolsPlugin({ enabled: false })`.
