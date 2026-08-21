# Prompt: acceptance walks for `@ax/agent-aisdk-runner` (§8)

Run this in a fresh session. Everything needed is below — do not assume prior context.

---

Run the two acceptance walks that §8 of the provider-agnostic runner design still owes
for **`@ax/agent-aisdk-runner`**, the second agent runner (merged in PR #400,
`d07c6186`): a **`chat-qa-sweep`** run and a **`k8s-acceptance-loop`** walk, both against
an agent pinned to the `aisdk` runner on the local kind cluster.

Read `docs/plans/2026-08-18-provider-agnostic-runner-design.md` §8 first — it is the bar
you are measuring against. `packages/agent-aisdk-runner/README.md` is the runner's own
summary, including its documented non-parity.

## Why this is the remaining work

The runner is proven **in-process**: 220+ unit/e2e tests, plus a parity suite that drives
the real `runRunner` shell and the real loop against a scripted `MockLanguageModelV4`. The
acceptance canary in `@ax/cli` runs on both runner ids.

None of that touches a real pod, a real model, or the real spawn path. §8 asks for both
walks precisely because **the pod path is where runner-spawn differences surface**. That
is the entire gap you are closing.

## The two walks

1. **`chat-qa-sweep`** — invoke the `chat-qa-sweep` skill. It runs a fixed battery
   (new chat, npx, skills, attachments, artifacts, reload old sessions, title generation,
   parallel sessions) plus fault injection (sandbox killed mid-turn, host killed, provider
   error, network blip) against the chat UI and reports what broke or glitched.
2. **`k8s-acceptance-loop`** — invoke the `k8s-acceptance-loop` skill. Drive the chat UI in
   a real browser via Playwright MCP against kind cluster `ax-next-dev`, and iterate until
   the §8 parity behaviours actually hold.

Run them **against an agent pinned to `aisdk`**, and — where cheap — spot-check the same
scenario on a `claude-sdk` agent, since the whole claim is that the two are
host-indistinguishable.

## Operational unlocks (these will otherwise cost you hours)

**Pinning an agent to the aisdk runner.** The admin UI has **no runner picker** — the
`AgentForm` component does not render one. The admin **API** does accept it, on create and
update:

```
POST  /admin/agents            { ..., "runner": "aisdk" }
PATCH /admin/agents/:id        { "runner": "aisdk" }
GET   /admin/agents/:id        -> includes "runner"
```

Both require the `X-Requested-With: ax-admin` CSRF header (the admin routes reject without
it — this has caused a 403 before). `'aisdk'` is on the `SUPPORTED_RUNNERS` allow-list in
`packages/agents/src/store.ts`, so it validates. **Confirm the pin took** by reading the
agent back before you conclude anything about "the aisdk runner" — a silently-rejected
PATCH means you spent the walk testing `claude-sdk`.

**A runner change needs a FULL image rebuild.** `make dev-fast` syncs **only** the SPA
bundle (`dist-web`) into the node; the full-host fast loop is blocked by pnpm-deploy
symlinks. For anything runner-side use:

```
make image      # docker build -> kind load -> rollout -> prune. Cluster: ax-next-dev
```

**Docker build cache can hide runner changes.** This has bitten the project before: a
runner fix appeared applied but the image still carried the old compiled `main.js`. Before
trusting a walk result, verify the binary actually shipped:

```
docker run --rm --entrypoint sh ax-next/agent:dev -c \
  'ls -l /opt/ax-next/host/node_modules/@ax/agent-aisdk-runner/dist/main.js'
# and grep the compiled output for a string you expect, e.g. the runner-id self-check
```

If in doubt, rebuild with `--no-cache`. `make image` also prunes dangling layers — the kind
node fills up after ~15 rebuild cycles and starts failing with "no space left on device".

**Headless authed chat** (useful for scripted checks): mint an `ax_auth_session` cookie
with `signCookieValue` and `POST /api/chat/messages`. See the project memory note
`reference_headless_authed_chat_kind`.

**Model credentials.** The runner holds only an `ax-cred:<32-hex>` placeholder; the
host-side credential-proxy substitutes the real key mid-flight. If model calls fail with an
auth error, the problem is the proxy wiring or a missing credential in the store — not the
runner. This runner ships **Anthropic only**; an `openrouter/…` model ref fails loudly at
boot by design (that is PR 4).

## What to actually verify (§8 parity checklist)

Walk these end-to-end. Marked ✅ are already covered by automated tests **in-process** —
re-verify them in the cluster only as far as is cheap; spend your attention on the rest,
which no test can reach:

| Row | Automated? |
|---|---|
| workspace materialize → commit → bundle across turns | shared shell, not pod-verified |
| uploads + attachment translation | ✅ in-process |
| installed-skill discovery and invocation | ✅ in-process |
| authored-skill proposal via `skill.propose` | dispatch only |
| artifact publish | dispatch only |
| resume across turns **and after a warm rebind** | resume ✅; **warm rebind not covered** |
| **sandbox death mid-turn → `chat:turn-error` + retryable UI** | only provider-failure ✅ |
| egress-block remediation notes | ✅ in-process |
| **routine-triggered invocation** | host-side, **not covered** |
| host tools + connector MCP tools from the catalog | ✅ in-process |

The **bolded** rows are the genuinely unproven ones. Prioritise them.

## Do NOT file these as bugs — they are documented non-parity

The runner deliberately differs from `@ax/agent-claude-sdk-runner` here. Treat any of these
as expected, not as findings:

- `TodoWrite` is absent.
- Switching an agent's runner mid-conversation **demotes the next turn to a fresh session**
  (the transcript formats differ; cross-runner translation is explicitly out of scope). The
  user still sees full history — display history is runner-neutral.
- SDK-specific setting sources do not exist.
- A skill declaring `mcpServers` still loads, but its MCP servers do not run, and the
  `Skill` response says so explicitly. **Connector-backed MCP is unaffected** — that is
  host-side and arrives as ordinary host tools.
- **No compaction yet** (that is PRs 6–7), so a long session can exhaust the context
  window and degrade. Expected today.

## What to do with findings

- A real bug in the runner: fix it if it is small and in scope, with a test that would have
  caught it (repo Bug Fix Policy — no exceptions). Otherwise file a card on the "TO DO"
  board (org `project-ax`, project #1) or a GitHub issue with a concrete repro.
- **Distinguish a flaky test from a real race before dismissing either.** House rule,
  learned the hard way this month: a failure with a real **assertion** is a product race
  until proven otherwise; only a failure with **zero assertions** (worker crash, timeout)
  is infrastructure. Two separate incidents this month were misread in both directions.
- Update `.claude/memory/` as you go and **commit it** (it is git-tracked, not ignored).
  Work in a **git worktree**, never the shared main checkout — other sessions use it, and
  it is currently sitting on someone else's feature branch.

## Definition of done

Both walks executed against an `aisdk`-pinned agent on `ax-next-dev`, with:

- a written report of PASS / GLITCH / FAIL per scenario (the `chat-qa-sweep` skill defines
  the format),
- the bolded unproven rows above explicitly exercised and their outcome stated,
- every finding either fixed (with a test) or tracked,
- and an honest statement of anything you could **not** verify and why. Under-claiming is
  fine; "walked it" without saying what was actually driven is not.

## State going in

- PR #400 (`d07c6186`) — the runner. PR #402 (`e81d3b5f`) — an admin Model-picker race.
  PR #404 (`38f08cca`) — root-caused the CI fork-pool flake (a test was running a
  71-project workspace build inside a vitest worker; it was never a vitest bug).
- Next in the runner sequence after these walks: **PR 4 — OpenRouter** (credential path +
  multi-provider `models:list-supported`). `packages/agent-aisdk-runner/src/provider.ts`
  was deliberately shaped so that is a config change, not a refactor.
