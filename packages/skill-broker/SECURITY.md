# @ax/skill-broker — security notes

This plugin gives the agent two always-on host tools — `search_catalog` and
`request_capability` — so the model can discover skills in the capability catalog and
ask for one to be connected. Both tools take text the **model** wrote, which means we
treat every argument as untrusted from the moment it arrives.

## What new reach the model actually gets

Exactly one thing: a **read** of the skill catalog. That's it. The broker adds no
filesystem access, no process spawning, no environment access, and no new network
egress. Its two tools are `executesIn: 'host'` and ride the **existing**
`tool.execute-host` IPC action — we did not open a new wire surface.

## The untrusted-intent surface (the one we stay paranoid about)

`search_catalog` takes a free-text `intent`. We match it **in memory** over the
catalog list — it never reaches SQL, a shell, a file path, or another model prompt as
an instruction. So an intent like `'; DROP TABLE skills; --` is just a string that
fails to match anything. We closed the injection surface by construction, not by
escaping (which is the kind of thing that's easy to get subtly wrong).

`request_capability` takes a `skillId`. Before we hand it to the catalog we re-validate
its shape against a strict id pattern at the broker boundary — defense in depth, even
though the catalog also binds it as a query parameter. A malformed id (e.g. `../evil`)
is rejected before it touches anything.

## Minimal by design

`request_capability` returns the bare minimum — a status and the skill id. It
deliberately does **not** echo back hosts or credential slot names to the model. The
human approval card (a later component) is the surface that shows those; the model has
nothing sensitive to be steered into narrating or exfiltrating.

The candidate summaries `search_catalog` returns (descriptions, hosts, slots) come from
**admin-vetted** catalog skills, and the human is the ultimate backstop at the approval
step. We don't let the model self-approve anything.

## Supply chain

`@ax/skill-broker` has **no** third-party dependency — its only runtime dependency is
`@ax/core` (a workspace package). Nothing to pin, nothing to audit, no install-time
scripts.
