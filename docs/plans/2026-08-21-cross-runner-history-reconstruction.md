# Cross-runner history reconstruction — design

**Status:** proposed, 2026-08-21.
**Problem owner:** the runner sequence (`docs/plans/2026-08-18-provider-agnostic-runner-design.md` §5).
**Depends on:** the `runner_type` correction (PR #419) for its trigger signal.

## The problem, measured

Switching an agent's runner is allowed at any time — `PATCH /admin/agents/:id
{"runner":"aisdk"}`, no guard, no confirmation. Measured on kind against a
conversation with real history (2026-08-21):

| | |
|---|---|
| Next turn's memory | **gone** — the agent answered `NO-HISTORY` |
| Stored transcript | **replaced**, aisdk ndjson → Claude SDK jsonl |
| User-visible history | **intact** — every turn still renders |
| Turns after that | normal; resume works on the new runner |

So the loss is a one-time amnesia at the switch, and it is **silent**: nothing
warns the user before or after. The user is looking at a conversation the agent
cannot remember.

This is documented non-parity ("cross-runner resume demotes to fresh"), and the
demotion itself is correct — the two transcript formats are genuinely
incompatible and translating between them would be lossy in both directions.
What is *not* forced is that the new runner has to start **blank**.

## The idea

The display log is already runner-neutral and already survives the switch. Seed
the new runner's transcript from it, so the agent keeps the conversational
thread even though it lost the runner-native transcript.

## Why this is cheaper than it sounds

The vocabulary exists on both sides already:

- The display log stores each turn as `ContentBlock[]` — the union in
  `@ax/ipc-protocol/src/content-blocks.ts` (`text`, `tool_use`, `tool_result`,
  `image`, `attachment`, `thinking`, `redacted_thinking`). One source of truth,
  already storage-agnostic.
- `AgentMessage` (`@ax/ipc-protocol/src/actions.ts`) is already
  `{ role: 'user' | 'assistant', content: string, contentBlocks?: ContentBlock[] }`
  — exactly the shape a reconstructed history needs, and exactly what the inbox
  already hands the runner for the *current* user message.
- The aisdk runner already translates that union inbound
  (`user-message.ts`: text / image / document) and outbound
  (`turn-blocks.ts`). The missing direction is only "prior ASSISTANT turn →
  `ModelMessage`", which is the easy half.

So the host keeps speaking blocks, the runner keeps owning its own format, and
invariant 1 holds without any new vocabulary.

## Scope for v1: text only

**Keep:** user text, assistant text, in order.
**Drop:** `tool_use`, `tool_result`, `thinking`, `redacted_thinking`, attachments.

Dropping tools is not laziness, it is what makes v1 safe:

- **Pairing.** A `tool_use` without its matching `tool_result` is a 400 from
  Anthropic, not a degraded answer. The display log splits the two across
  separate turns, so any reconstruction that keeps them has to re-pair by
  `tool_use_id` and drop orphans — real work, and the main correctness risk in
  the whole feature. v1 sidesteps it entirely.
- **Signed thinking.** Anthropic's thinking blocks carry a signature over the
  block. A reconstructed one cannot be re-signed, so it must never be replayed.
- **Attachments** reference `.ax/uploads/...` paths that DO survive (the
  workspace is git-backed and materializes independently), so they are a
  candidate for v2 rather than a hazard.

What the agent loses: "what I actually ran." It may say it does not recall
running something it ran. That is worth stating in the note the reconstruction
injects, rather than letting the model discover it by contradiction.

## Shape

**New IPC action** `session.get-display-history` → `{ messages: AgentMessage[] }`.

- Session-scoped: the IPC server already knows the session → conversation
  binding, so the request carries no ids and a runner cannot ask about someone
  else's conversation. This is the security-relevant property; it is why the
  action takes no arguments.
- The host filters to user/assistant text before it answers. The runner never
  sees the blocks v1 drops, so "drop the tool blocks" is enforced host-side
  rather than trusted to each runner.
- Bounded: newest N turns / M characters, so a very long conversation cannot
  produce a request that blows the window on its first send. Compaction handles
  the rest.

**Trigger:** the existing `'unusable'` branch. `restoreTranscript`
(`transcript-delta.ts`) already funnels a foreign transcript into demote-to-fresh;
v1 adds "…and then seed from display history" to that one path. No new decision
point, no new state machine.

**Seam:** `TranscriptSource` gains an optional
`seedFromHistory(messages: AgentMessage[]): Promise<void>`. Optional because of
the asymmetry below.

## The honest asymmetry

The aisdk runner can implement this cleanly — it owns its message array in
memory. The claude-sdk runner **cannot**, or not cheaply: its transcript is an
SDK-owned jsonl file whose shape the SDK controls, and hand-writing SDK jsonl to
fake a prior session is exactly the kind of coupling `runner-core` exists to
avoid.

So v1 improves one direction only:

| Switch | v1 behaviour |
|---|---|
| claude-sdk → aisdk | history reconstructed |
| aisdk → claude-sdk | still demotes to blank |

That is a real parity gap and it should be written into the runner README next
to the others, not glossed. It is also the right trade: it is strictly better
than today in one direction and no worse in the other, and the alternative —
block the whole feature until the SDK side is solvable — keeps a silent
amnesia bug that we have now measured.

`seedFromHistory` being optional on the interface is what keeps this from being
half-wired: a source that cannot seed says so by not implementing it, and the
shell takes the existing demote path.

## Alternatives considered

- **Reconstruct with tool calls intact.** Better fidelity, but the pairing
  problem is the entire risk of the feature and it buys the model detail it
  rarely needs about turns it did not run. Candidate for v2 once v1 is walked.
- **Translate transcript → transcript directly.** Rejected by §5 already: lossy
  in both directions, and it couples every runner to every other runner's
  format. Reconstruction from the neutral log has no N² problem.
- **Refuse the switch when conversations exist.** Honest, and much smaller —
  but it makes a reversible setting irreversible, and the walk showed the switch
  itself is otherwise harmless.
- **Warn the user before switching.** Not an alternative — a complement, and
  cheap. Worth doing regardless, especially once a runner picker exists in the
  UI (today the switch is API-only).

## Acceptance

- Switch an agent claude-sdk → aisdk mid-conversation; the next turn answers a
  question that can only be answered from turns written by the *other* runner.
- The reconstruction carries no `tool_use` / `tool_result` / `thinking` blocks
  (asserted on what is actually sent, not on what was requested).
- A tool result cannot arrive as a `user` message — the roles round-trip
  faithfully, so replayed tool output can never impersonate the user.
- Bounds hold on a long conversation.
- The aisdk → claude-sdk direction still demotes to blank, and says so.
