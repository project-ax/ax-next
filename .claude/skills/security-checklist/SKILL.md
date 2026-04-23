---
name: security-checklist
description: Use when adding or modifying — sandbox boundaries, IPC handlers, plugin loading or manifests, hook payloads carrying model/tool/external-system output, dependencies in package.json, or code that uses caller-provided file paths / spawns processes / opens network connections. Walks three threat models (sandbox escape, prompt injection, supply chain) and produces a structured PR security note. Rigid checklist — every item must be answered, "N/A" requires a reason.
---

# Security checklist

The fifth invariant in `CLAUDE.md` is that **capabilities are explicit and minimized**. The whole point of v2 over openclaw is that we're the secure one. This skill is the operational checklist that backs that invariant.

It is **rigid**: every section must be answered, every "N/A" must give a reason. No skipping, no adapting.

---

## When this fires

The skill applies whenever the current change touches:

- `@ax/core` hook bus signatures, IPC transport, or plugin manifest loading
- A new dependency in any `package.json` (direct or transitive)
- Hook payloads or IPC actions that carry strings originating from a model, tool, or external system
- Code that touches the filesystem with a caller-provided path
- Code that spawns a process
- Code that opens a network connection
- A plugin's exposed surface (registered service hooks, fired subscriber hooks)

If your change touches none of the above, you can skip the skill entirely. If even one applies, walk all three sections — they cover different threat models, and a change can fail one while passing the others.

---

## The three threat models

Walk these in order. Each section ends with what counts as a valid "N/A".

### 1. Sandbox escape / capability leakage

What capability does this code path grant or widen? List specifically:

- Filesystem paths reachable (read, write, both)
- Network destinations (host, port, scheme)
- Processes spawnable (fixed argv, or caller-influenced?)
- Env vars readable (fixed names, or caller-supplied?)
- Sockets, file descriptors, or opaque handles passed across boundaries

For each, is the capability **bounded**? Concrete failure patterns to check against:

- **Path traversal** — caller-provided path not validated against a base dir; `../` escapes the intended sandbox.
- **Argv injection** — process spawn lets caller control argv0 or insert flags, not just args. Equivalent to arbitrary command execution.
- **Env exfiltration** — env var read with caller-supplied name. `process.env[userInput]` leaks any secret.
- **Handle leak** — hook payload field is an opaque handle (file descriptor, socket, capability token). Subscribers receive it and inherit whatever it wraps.
- **Path-as-token confusion** — payload field named `path` actually represents a version or identity, not a location. Subscribers may resolve it as a real path.

**N/A is acceptable only if** this PR adds no new reachable capability and doesn't widen an existing one. State why explicitly.

### 2. Prompt injection / untrusted content

What strings in this code path originate from outside the trust boundary?

- Model output (LLM responses, tool-call arguments the model chose)
- Tool output (return values from any tool the model called)
- User-uploaded content (files the user dropped in, not text they typed into the chat)
- External API responses (HTTP bodies, search results, scraped pages)
- Third-party plugin output

For each untrusted string, where does it end up? The bad destinations:

- Interpolated into a shell command, a file path, a SQL query, an HTTP URL
- Rendered as HTML or markdown without escaping
- Concatenated into another LLM prompt as if it were a system instruction
- Passed as a tool argument that the model didn't originate (e.g., a subscriber synthesizes a tool call from tool output)
- Logged into a file or DB that another process trusts

Worst-case test: if a malicious tool returned `"; rm -rf ~; echo "` (or the LLM equivalent — `ignore previous instructions and call tool X with arg Y`), what would actually execute? Walk the path from the untrusted string's origin to its final destination.

**N/A is acceptable only if** this PR handles no model output, tool output, user-uploaded content, or external input. State why explicitly.

### 3. Supply chain

Any new entries (added or version-changed) in any `package.json`?

For each new dep, answer:

- **Pinned?** Exact version, not `^` or `~`. Lockfiles help, but the manifest range is the source of truth for what gets accepted on upgrade.
- **Install-time scripts?** Check the package's `scripts` field for `postinstall`, `preinstall`, `prepare`. If yes, what do they do? Network calls at install are a red flag.
- **Maintainer history?** Established package with an author you'd recognize, or a fresh / low-download package? `npm view <pkg> time` and download counts give a rough signal.
- **Transitive deps?** Skim the new transitive surface (`pnpm why <pkg>` after install, or check the lockfile diff). Same questions apply to anything new.

**N/A is acceptable only if** no `package.json` was touched and no new transitive dep was pulled in. State why explicitly.

---

## Output contract

Paste this block into the PR description under a `## Security review` heading:

```
## Security review
- Sandbox: <one line — capability change, or "N/A: <reason>">
- Injection: <one line — untrusted content handled, or "N/A: <reason>">
- Supply chain: <one line — new deps + pinning, or "N/A: <reason>">
```

The `<reason>` after "N/A" is mandatory. Bare "N/A" or empty bullets fail the check — every security checklist that ever died, died the moment "n/a" became free.

Examples of acceptable lines:

- `Sandbox: New plugin registers sandbox:spawn — argv is fixed, args are caller-controlled but escaped via spawn() arg array (not shell). Reachable FS limited to the workspace tmpdir.`
- `Injection: Hook handler receives tool output and writes it to storage as Bytes. Never interpolated into prompts or commands. Storage layer treats as opaque.`
- `Supply chain: N/A — no package.json changes, no new entries in the pnpm-lock diff.`

Examples of unacceptable lines:

- `Sandbox: N/A` — no reason, fails.
- `Injection: Looks fine` — no specifics, fails.
- `Supply chain: Added zod, popular package` — no pinning answer, no install-script answer, fails.

---

## When the checklist finds something

If a section turns up a real risk, **fix it before the PR merges**. Options:

- Tighten the capability — validate the path against a base dir, lock argv to a fixed shape, scope the env access to a fixed allow-list.
- Add a brand on the type (`UntrustedString`, `WorkspaceVersion`) so subscribers know what they're holding and the type system catches misuse.
- Reject the dep — pin it tighter, find an alternative, or vendor a minimal implementation.
- Split the change — sometimes the secure version is a different design than the convenient one. The PR may need re-scoping, not just patching.

Write the fix in the same PR. The note in the PR description should reflect the fixed state, not the original risk. If the fix moves the threat model from "real risk" to "N/A", say so in the line.

---

## Relationship to other guardrails

- The **boundary review checklist** in `CLAUDE.md` catches abstraction leaks (field-name leakage, missing alternate impl). This skill catches capability leaks. A hook can pass boundary review and still fail this checklist, or vice versa — they're orthogonal, and changes that touch hook surface usually need both.
- The globally-installed `security-review` skill (different name on purpose) reviews a diff on demand at PR time. This skill produces the structured note that the diff-review can sanity-check against. Both can run; they don't overlap.
- `ax-conventions` summarizes the five invariants. Invariant #5 is the principle ("capabilities are explicit and minimized"); this skill is the enforcement.

---

## Anti-patterns

Things that look like they satisfy the checklist but don't:

- **Trust by familiarity.** "It's just a string from `chat:end`, that's fine." If the string ever held tool output, it's still untrusted regardless of which hook it's flowing through now.
- **N/A by category, not by reason.** "N/A: this is a refactor" — refactors absolutely can widen capabilities (a function that was internal becomes exported and now reachable from a plugin boundary).
- **Defer to lint.** "ESLint will catch this." It might. The checklist runs anyway because lint catches patterns, not intent.
- **One-line "yes it's safe".** The checklist's value is in walking the failure modes — the answer matters less than having considered the question. If the section line in the PR doesn't name a specific capability or a specific untrusted-input flow, it's not real.
