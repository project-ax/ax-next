# Security notes — @ax/conversation-titles

We do one thing: when an assistant turn ends, we ask another model to summarize the conversation in eight words or fewer, sanity-check the answer, and stash it as the conversation's title. That's it. If we ever start doing more, that's a sign we're overreaching.

## Capability budget

We're picky here. If a future change needs more, take a hard look at whether it really belongs in this plugin:

- **Filesystem reads:** none.
- **Filesystem writes:** none.
- **Network:** none. The LLM call goes through the `llm:call` service hook — the registrar (`@ax/llm-anthropic` today, anyone tomorrow) holds the network capability. We don't talk to the internet directly.
- **Process spawn:** none.
- **Environment variables:** none. We don't read `ANTHROPIC_API_KEY`, model names from env, or anything else. Configuration comes through the bus or the plugin config; the API-key-holding plugin keeps the secret to itself.

If a later change adds `fs`, `child_process`, `process.env`, or a direct outbound network call — please push back hard or come talk to us. Every one of those is a capability some other plugin already has, and centralizing them there is the whole point.

## Untrusted input

The transcript we summarize is model-generated content (per the v2 untrusted-content rule, model output is untrusted at every hop). We pass it through to a different LLM call as a prompt body. We don't render it anywhere, parse it for instructions, or interpret it.

The model's response is also untrusted. The trust boundary is `validateGeneratedTitle()` in `src/validate.ts`:

- Strips outer matched quotes (Anthropic likes to wrap titles in quotes despite the prompt saying not to).
- Takes only the first line — newline-padded "title" output is not a title.
- Trims whitespace.
- Rejects empty results.
- Rejects the literal string `Untitled` — that's the model's "I have nothing to say" output, and an empty row in the DB is more honest than the word "Untitled" in the sidebar.
- Caps at 256 characters (matches the `conversations.title` column's CHECK).

Everything that flows out of the validator is what `conversations:set-title` writes. Nothing else from the LLM response touches the database, no field gets promoted into a control field, and the validated title is the only string that ever surfaces in user-facing UI from this plugin.

## What we deliberately don't do

A few things we could implement, but won't, because they belong elsewhere:

- **Retitling.** A title gets set once, ever (we use `ifNull: true` so we can't clobber a user rename). Retitling is a separate UX decision the orchestrator can make later.
- **Caching the model's response.** The orchestrator above us decides whether retries dedupe; we don't keep state.
- **Logging the prompt or the model's raw text.** The `audit-log` plugin owns prompt-content logging if anyone does.

## Why this matters

This plugin sits on a `chat:turn-end` subscriber, and subscribers run after every turn. If we accumulate capabilities here, every conversation grows the attack surface. Keeping the budget tiny is how a compromise survives — a malicious or buggy `@ax/conversation-titles` should be unable to reach the network, the disk, the process table, or the environment without going through a peer plugin that already has that capability and has its own threat model.

We're a nervous crab here on purpose. The door is locked.
