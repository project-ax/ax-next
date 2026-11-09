# Security: @ax/step-summaries

We turn the agent's private reasoning into one short line a person can read
("Working out the leg motion with a script."). The reasoning is the sensitive
part, so most of this file is about where it does and doesn't go.

## What it reads

- `thinking` chunks on `chat:stream-chunk`. Untrusted: reasoning can quote
  tool output, files and web pages.

## Where the reasoning goes

- **Only** into one `llm:call` to the configured fast model, inside a
  `<reasoning>` block the prompt says is material to describe, not
  instructions. The tail is capped at 6,000 characters.
- Never logged, stored or forwarded. Logs carry lengths and error names only.

## What it writes

- One `step-summary` chunk on `chat:stream-chunk` and one `step-summary`
  conversation display event, keyed by the tool call id.
- The text has passed `validateSummary`: the first line only, control and
  format characters stripped, at most 120 characters. The channel fences it
  again and draws it as plain text, never markdown or HTML.

## Bounds

- At most 30 summaries per request. Reasoning under 40 characters is skipped.
- A call id longer than 256 characters is ignored, because it becomes a stored
  key.
- Per-step state is keyed by the host-stamped session as well as the
  runner-supplied reqId. One session's reasoning can never be summarized onto
  another session's call.
- A runner cannot send a `step-summary` chunk itself, because the IPC schema
  has no such kind. Only this host plugin produces them.

## Residual risk

A summary is a model's paraphrase of reasoning the person can't see. The
prompt forbids quoting code, values, names, keys or URLs. A model that ignores
the prompt could still put a short fragment of the reasoning on screen. The
only person who sees it is the person in that conversation.
