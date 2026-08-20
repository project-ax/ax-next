# Third-party notices

Things we didn't write, that we're using anyway — with credit, because that's the
deal. Each entry names what we took, where it came from, its license, and what we
changed.

(This file covers material adapted into our source. Dependencies we merely install
carry their own licenses in `node_modules`; this is for code and text we copied.)

ax-next itself is MIT — see `LICENSE`. That does **not** relicense anything listed
below: each entry stays under its own terms, and where those terms ask for more
than MIT does, the stricter obligation wins.

---

## Grok Build — system prompt (Apache-2.0)

**Upstream:** [`xai-org/grok-build`](https://github.com/xai-org/grok-build), file
`crates/codegen/xai-grok-agent/templates/prompt.md`, at commit
`19d42e35c07a9c9244f03f6df0c4c353f970d4f9`.

**License:** Apache License 2.0, `Copyright 2023-2026 SpaceXAI`. The upstream
`LICENSE` file — their copyright notice plus the full Apache-2.0 text — is
vendored here at [`licenses/grok-build-LICENSE.txt`](licenses/grok-build-LICENSE.txt),
so a copy travels with this repository rather than only a link
(Apache-2.0 §4(a)). Upstream ships no `NOTICE` file at the commit named above, so
§4(d) does not apply.

The adapted prose remains under Apache-2.0 notwithstanding this project's MIT
license. Anyone redistributing it carries the §4 obligations: this notice, the
license copy, and the statement of changes below.

**Where it lives here:** `packages/agent-runner-core/src/system-prompt.ts` —
the `workPolicyNote()` and `communicationNote()` functions.

**What we took:** the operating-policy prose from the upstream prompt's
`<work_policy>`, `<tool_calling>`, `<communication>` and `<formatting>` sections.

**What we changed** (this is the "state your modifications" part of the deal):

- Rewritten from the upstream MiniJinja template into two plain TypeScript
  functions. The template placeholders (`${{ tools.by_kind.read }}` and friends)
  are resolved to our fixed tool names — `Read`, `Edit`, `Glob`, `Grep`, `Bash`.
- Added a precedence sentence to each note naming `.ax/AGENTS.md` as the layer
  that can override it and the safety floor as the layer that cannot. Our prompt
  is composed from an agent's own identity files; upstream's is not, so upstream
  had nothing to say here.
- **Dropped** the `<communication>` clauses forbidding coined acronyms, metaphors
  and idioms, and requiring facts be stated literally. Our agents author their own
  `.ax/SOUL.md`; a rule flattening voice would fight the thing that gives them one.
  We kept the structural half — write for a reader who hasn't seen your tool calls,
  lead with the answer, make the final message stand alone.
- **Dropped** `<background_tasks>` and the subagent/delegation lines: we register
  no background-task, monitor, or `Task` tool for them to describe.
- **Dropped** `<browser_verification>` (no browser tools) and `<user_guide>` (it
  points readers at `~/.grok/docs`).
- **Dropped** the interactive/autonomous prompt variant. Upstream switches on
  `is_non_interactive`; we compose the prompt once per sandbox spawn and a warm
  sandbox serves both user-typed and routine-triggered turns, so there is no
  honest signal to switch on. Revisit if the host ever ships one.

**What we did not take:** the agent harness itself, the TUI, the tool
implementations, and the hook and permission systems. Those are Rust, and the
runner-side evaluation that led here is written up in
`docs/plans/2026-08-18-provider-agnostic-runner-design.md`.
