# AX

A plugin-based personal AI agent. Greenfield, work-in-progress.

AX is built as a tiny kernel plus a lot of plugins. The kernel, a real LLM provider, real tools, and a subprocess sandbox have all shipped — you can actually send a message to Anthropic, have it call `bash` or read/write a file, and get a real answer back.

## Status

**What works today:**

- `@ax/core` — the kernel. Hook bus (service + subscriber hooks), per-request `ChatContext`, structured `PluginError`, plugin manifest + `bootstrap`, the `chat:run` orchestration loop, and length-prefixed IPC primitives (`encodeFrame` / `FrameDecoder`, Zod wire schemas) for the sandbox.
- `@ax/test-harness` — `createTestHarness` + `MockServices.basics` for writing plugin tests in isolation.
- `@ax/llm-mock` — registers `llm:call`, always returns a canned `"hello"`.
- `@ax/llm-anthropic` — registers `llm:call` against `@anthropic-ai/sdk`, forwards tool descriptors, reads `ANTHROPIC_API_KEY` from env.
- `@ax/sandbox-subprocess` — registers `sandbox:spawn`; every tool call runs in a short-lived Node child with argv-array spawn (no shell-true), env allow-list, timeout + stdout/stderr caps.
- `@ax/tool-dispatcher` — registers `tool:execute` and fans out to `tool:execute:<name>` sub-services.
- `@ax/tool-bash` — registers `tool:execute:bash`, runs `/bin/bash -c <command>` via `sandbox:spawn`.
- `@ax/tool-file-io` — registers `tool:execute:read_file` / `tool:execute:write_file`, path-sandboxed via a ported `safePath`.
- `@ax/storage-sqlite` — Kysely + `better-sqlite3`, registers `storage:get` / `storage:set`.
- `@ax/audit-log` — subscribes to `chat:end`, persists outcomes via `storage:set`.
- `@ax/credentials` — AES-256-GCM at-rest encryption for opaque secret blobs. Registers `credentials:get` / `:set` / `:delete` service hooks. Key sourced from `AX_CREDENTIALS_KEY` (MVP stopgap; KMS-backed in Week 13+).
- `@ax/mcp-client` — host-side [Model Context Protocol](https://modelcontextprotocol.io) server hosting. Stdio + streamable-http + SSE transports. Configure servers via `ax-next mcp add`, store their credentials via `ax-next credentials set`. Tools surface to the model under a `mcp.<server>.<tool>` namespace and fire `tool:pre-call` / `tool:post-call` on the same path as built-ins.
- `@ax/cli` — binary `ax-next`, loads `ax.config.ts` (or defaults), wires the above together, runs a chat turn.

All passing. (The repo actually ships a few more plugins — `@ax/agent-claude-sdk-runner`, `@ax/llm-proxy-anthropic-format`, runner cores, impl splits — but the list above is the ones most readers come looking for.)

**What doesn't work yet:**

- Channels (web chat UI, Slack), k8s deployment shape, observability beyond the audit log + structured logger. All planned.
- Turn-tree correlation (`turnId` / `parentTurnId`) and the single canonical terminal event per turn — designed, not yet wired (see `docs/plans/2026-04-23-observability-design-note.md`).

## Running it (today)

```bash
pnpm install
pnpm build
./packages/cli/dist/main.js "hello there"
```

With no `ax.config.ts` present, the CLI falls back to defaults (`llm: 'mock'`), so that invocation replies `hello`. To run against the real Anthropic API, drop an `ax.config.ts` in the cwd and set `ANTHROPIC_API_KEY`:

```ts
// ax.config.ts
export default {
  llm: 'anthropic',
  tools: ['bash', 'file-io'],
  anthropic: { model: 'claude-sonnet-4-6' },
};
```

```bash
export ANTHROPIC_API_KEY=sk-...
./packages/cli/dist/main.js "list the files in this directory"
```

The CLI bootstraps the configured plugins, fires `chat:start`, routes through `llm:pre-call` → `llm:call` → `llm:post-call`, dispatches any requested tool calls through `tool:execute` → `tool:execute:<name>` → `sandbox:spawn`, loops until the model stops asking for tools, fires `chat:end`, and the audit-log plugin persists the outcome to SQLite.

Database path can be overridden via `AX_DB=/tmp/ax.sqlite` or `storageSqlite.databasePath` in the config.

Exit codes: `0` on complete, `1` on terminated (missing service, rejection), `2` on fatal error.

### Using the kernel programmatically

If you want to embed the loop rather than shell out, import `@ax/core`:

```ts
import { HookBus, registerChatLoop, makeChatContext } from '@ax/core';
import type { LlmRequest, LlmResponse, ChatOutcome } from '@ax/core';

const bus = new HookBus();
registerChatLoop(bus);

bus.registerService<LlmRequest, LlmResponse>('llm:call', 'my-llm', async () => ({
  assistantMessage: { role: 'assistant', content: 'hello from my LLM' },
  toolCalls: [],
}));

const ctx = makeChatContext({ sessionId: 's', agentId: 'a', userId: 'u' });
const outcome = await bus.call<{ message: { role: 'user'; content: string } }, ChatOutcome>(
  'chat:run',
  ctx,
  { message: { role: 'user', content: 'hi' } },
);
```

Or, in a test, skip the boilerplate with `@ax/test-harness`:

```ts
import { createTestHarness } from '@ax/test-harness';

const h = await createTestHarness();
const outcome = await h.bus.call('chat:run', h.ctx(), {
  message: { role: 'user', content: 'hi' },
});
// outcome.kind === 'terminated', reason === 'llm:call:no-service' (no LLM registered)
```

## Why this shape?

Two reasons, in order.

**Component robustness in isolation.** Every piece should be developable, testable, and debuggable without booting the whole system. Making each concern a plugin that talks to the rest through the hook bus means you can test it with mocks in milliseconds.

**Security posture.** We're taking the position that if a hook surface, IPC action, or plugin grants more reach than it strictly requires, that's the bug. The plugin model makes that enforceable, because the boundaries are real. We're still cautious; the kernel has barely touched untrusted content yet. But the shape is there.

Full design: `docs/plans/2026-04-22-plugin-architecture-design.md` (long, thorough). Shorter version: `CLAUDE.md` → "The five invariants."

## Prerequisites

- Node.js ≥ 24
- pnpm ≥ 10

Both are pinned in `package.json` under `engines`. If your versions are off, pnpm will complain early instead of failing mysteriously later.

## Dev setup

```bash
pnpm install
pnpm build    # tsc --build across the workspace
pnpm test     # run every package's tests (64 today, instant)
pnpm lint     # eslint, including the cross-plugin import check
```

To work on a single package:

```bash
pnpm --filter @ax/core test
pnpm --filter @ax/cli build
```

If filtering a downstream package complains about not finding `@ax/core`, build core first — downstream packages import through the workspace dep:

```bash
pnpm --filter @ax/core build && pnpm --filter @ax/cli test
```

Running `pnpm build` at the root handles ordering automatically via TypeScript project references.

## Repo layout

```
ax-next/
├── packages/
│   ├── core/                    # @ax/core — the kernel (hook bus, chat loop, IPC primitives)
│   ├── test-harness/            # @ax/test-harness — createTestHarness + mocks
│   ├── llm-mock/                # @ax/llm-mock — canned 'hello' LLM
│   ├── llm-anthropic/           # @ax/llm-anthropic — real Anthropic provider
│   ├── sandbox-subprocess/      # @ax/sandbox-subprocess — sandbox:spawn via Node child_process
│   ├── tool-dispatcher/         # @ax/tool-dispatcher — tool:execute fan-out
│   ├── tool-bash/               # @ax/tool-bash — tool:execute:bash
│   ├── tool-file-io/            # @ax/tool-file-io — tool:execute:read_file / write_file
│   ├── storage-sqlite/          # @ax/storage-sqlite — Kysely KV store
│   ├── audit-log/               # @ax/audit-log — chat:end → storage:set subscriber
│   ├── credentials/             # @ax/credentials — AES-256-GCM at-rest secrets
│   ├── mcp-client/              # @ax/mcp-client — host-side MCP server hosting
│   └── cli/                     # @ax/cli — the ax-next binary (loads ax.config.ts)
├── docs/plans/                  # architecture doc + per-slice implementation plans
├── .claude/                     # project memory, skills
├── .changeset/                  # per-package version bumps (changesets)
├── eslint.config.mjs            # enforces "no cross-plugin imports"
├── pnpm-workspace.yaml
└── tsconfig.base.json           # strict — exactOptionalPropertyTypes, noUncheckedIndexedAccess, verbatimModuleSyntax
```

## The five invariants

We take these seriously enough to list them here and enforce the ones we can via lint:

1. **Hook payloads are transport- and storage-agnostic.** No `sha`, `bucket`, `pod_name`, `socket_path`. If a field name only makes sense for one backend, it leaks.
2. **No cross-plugin imports.** Plugins talk through the hook bus. Enforced by `eslint.config.mjs`.
3. **No half-wired plugins.** A plugin is either fully registered, tested, and reachable from the acceptance test, or it doesn't merge.
4. **One source of truth per concept.** If two plugins both store state about the same thing, one of them is wrong.
5. **Capabilities explicit and minimized.** Every plugin, hook, and boundary grants the smallest set of capabilities it needs. Untrusted content (model output, tool output, user input crossing a trust boundary) is treated as untrusted at every hop.

Before touching a hook signature, read the boundary-review checklist in `CLAUDE.md`. It's four questions and takes two minutes. Cheap now, expensive once subscribers depend on a leaked field name.

Before adding a plugin, a new dependency, or anything that touches a sandbox / IPC boundary, invoke the `security-checklist` skill. It walks three threat models (sandbox escape, prompt injection, supply chain) and produces a structured PR note.

## Roadmap

Section 10 of the architecture doc has the full build order. One-glance version:

| Slice | Goal | Status | Handoff brief |
|---|---|---|---|
| Week 1–2 | Kernel | ✅ Shipped | `docs/plans/2026-04-23-kernel-hook-bus-and-chat-loop.md` |
| Week 3 | Smallest viable end-to-end (mock LLM, SQLite, CLI) | ✅ Shipped | `docs/plans/2026-04-23-week-3-handoff.md` |
| Week 4–6 | Real LLM + tools + sandbox | ✅ Shipped | `docs/plans/2026-04-23-week-4-6-real-llm-and-tools.md` |
| Week 7–9 | k8s deployment shape | Planned | `docs/plans/2026-04-23-week-7-9-handoff.md` |
| Week 10–12 | Channels + observability | Planned | `docs/plans/2026-04-23-week-10-12-handoff.md` |
| Week 13+ | Cleanups + additive plugins | Ongoing | `docs/plans/2026-04-23-week-13-plus-handoff.md` |

Timelines are honest estimates, not commitments — part-time work, things slip.

## License

MIT.
