# Security notes — @ax/agent-claude-sdk-runner-host

We're a pure-function library. We parse JSON Lines that a Claude SDK runner subprocess wrote to disk, and we hand back a `Turn[]`. That's it. No sockets, no spawns, no env reads — we're the boring kind of paranoid.

## Capability budget

Zero. Genuinely zero. If a future change to this package needs any of the below, that's a red flag worth a second look:

- **Filesystem reads:** none. The caller hands us bytes; we don't open files.
- **Filesystem writes:** none.
- **Network:** none.
- **Process spawn:** none.
- **Environment variables:** none.

The host plugin that wraps this parser is where the filesystem read happens, and the runner subprocess is where the bytes originate. Both live in other packages with their own capability budgets. Keeping the parser pure means we can fuzz it, replay it on captured fixtures, and never worry about it touching anything it shouldn't.

## Untrusted input

The bytes we parse come from a runner subprocess writing its own session jsonl. Even in the happy path that's untrusted content — the runner is talking to a model, the model output is in there, and "trust the model's output" is exactly the assumption v2 is built to avoid.

So the parser must be defensive. Concretely:

- Malformed JSON on a line: skip the line, keep going. Don't throw.
- Missing or wrong-typed fields: skip that line. Don't throw.
- Oversized lines (we'll cap at a sensible limit when implemented): skip. Don't throw.
- Deeply nested structures attempting to blow the stack: bounded depth, skip if exceeded. Don't throw.
- Duplicate or out-of-order entries: tolerate, return what we got.

The contract is: "give me whatever bytes you have, and I'll give you back the well-formed turns I could recover." A bad line never blocks a good one. A bad file never crashes the host.

## Why this matters

If the parser threw on the first malformed line, a single bad write from the runner — a partial flush mid-crash, a disk-full truncation, a model emitting something genuinely weird — would take out the whole transcript view. We'd rather show the user 19 of 20 turns than show them a stack trace. Defensive parsing is how we get there.

We'll add fuzz tests once the parser exists. Until then this file is the contract; the implementation is the homework.
