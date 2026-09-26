# TASK-513 — `hydrateAgentTier` on the blocking `chat:start` path: measured, then fixed

## Measurement (before any change)

Probe: a real in-process `@ax/workspace-git-server` storage server on
`127.0.0.1`, the production `createWorkspaceGitServerPlugin` client, and the
real memory-strata chat:start tier path (`hydrateAgentTier` →
`composeIdentityFromTier` → `bootstrapMemoryTree` → `flushAgentTier`). Median of
5 runs per row, macOS laptop, 2026-09-26. No kind cluster.

| scenario | memory files read | chat:start memory cost | hydrate alone |
| --- | ---: | ---: | ---: |
| cold (turn 1, 4 files created) | 0 | 570 ms | 69 ms |
| warm, fresh agent (4 seed files) | 4 | 573 ms | 420 ms |
| warm, +25 docs | 29 | 2.53 s | 2.38 s |
| warm, +100 docs | 104 | 8.63 s | 8.44 s |
| warm, +300 docs | 304 | 25.2 s | 25.0 s |

Every `workspace:read` costs **~80 ms** on loopback (one `git fetch` against the
storage server, plus `rev-parse` / `cat-file`), serialised by the engine's
per-workspace queue, and the chat:start path reads **the whole `memory/**`
subtree** every turn. Cost is linear in the agent's memory size.

**The premise that the steady state is "bounded and small" was wrong.** It
reasoned from *writes* (bootstrap writes nothing after turn 1 — true) to
*cost*, but the cost is in the *reads*, and those scale with every doc,
inbox observation and rollup the agent accumulates. Loopback is a floor: in
a cluster each fetch also crosses the network to the git-server pod.

The work is also pointless: bootstrap only needs to know whether its four
seed files exist. It reads nothing else.

## Fix (no hook-surface change)

1. **chat:start reads only the seed files.** `hydrateAgentTier` gains an
   optional `only` list of tier paths; with it, it skips `workspace:list` and
   reads just those. `handleChatStart` passes the bootstrap seed set, derived
   from one exported constant in `bootstrap.ts` so the two cannot drift, and
   reads the identity files only when `system/agent.md` is missing. A partial
   hydrate is safe for `flushAgentTier` because deletions are computed as
   baseline-minus-scratch, and bootstrap only creates. (Later: TASK-556 also
   has bootstrap repair a placeholder `agent.md`. That file is in the seed
   set, so the partial hydrate stays safe; see `HydrateOptions.only`.)
2. **All reads of one hydrate are pinned to one snapshot.** The first found
   read's `version` is passed as `version` on every later read. This also
   closes a torn-read window: today each unpinned read may land on a different
   head, and `baseVersion` is whichever was read last.
3. **`workspace-git-server` skips the fetch for a pinned version the mirror
   already holds.** A commit id names immutable content, so re-fetching buys
   nothing. `read` and `list` try the local object first; on a miss for a
   pinned version whose commit is absent, fetch and retry (unchanged path).

Invariant 1: no payload changes. `version` on `workspace:read`/`list` is
already part of the neutral surface.

## Tasks

- A — engine: pinned read/list skip fetch when the commit is local. Tests in
  `packages/workspace-git-server/src/client/__tests__/`.
- B — memory-strata: `only` + pinned reads in `hydrateAgentTier`; chat:start
  uses the seed set; identity read gated on `agent.md` absence. Tests in
  `packages/memory-strata/src/__tests__/`.
- C — re-run the probe and record the after numbers here.

## After (same probe, same machine, median of 5)

| scenario | chat:start memory cost, before | after | full hydrate (observer / consolidator), before | after |
| --- | ---: | ---: | ---: | ---: |
| cold (turn 1) | 570 ms | 840 ms | — | — |
| warm, 4 files | 573 ms | 168 ms | 420 ms | 239 ms |
| warm, +25 docs | 2.53 s | 170 ms | 2.38 s | 861 ms |
| warm, +100 docs | 8.63 s | 163 ms | 8.44 s | 2.69 s |
| warm, +300 docs | 25.2 s | 159 ms | 25.0 s | 8.52 s |

chat:start is now flat in memory size: 4 `workspace:read` calls, 0
`workspace:list`, and no identity reads once `system/agent.md` exists. Only the
first read fetches; the other three are pinned and served from the local mirror.
The full hydrate, still used off the blocking path by the observer,
consolidator and `memory_note`, is ~3x faster from the pinned-read fetch skip
alone. It is still O(N) and stays out of scope here. (Update: TASK-554 took
it off linear-serial, measured at 223 ms at 100 docs and 375 ms at 300. See
`2026-09-26-task-554-full-hydrate-batched-reads.md`.)

**Cold is ~270 ms slower, and we took that trade on purpose.** Turn 1 used to
make 1 list plus 2 identity reads. It now makes 4 seed reads plus 2 identity
reads, and every one of them fetches, because a not-found read has no version
to pin the next read to. This happens once per agent lifetime, and it buys a
flat cost on every turn after that.

The probe isn't committed. It stood up `createWorkspaceGitServer` on
`127.0.0.1:0`, loaded the production `createWorkspaceGitServerPlugin`, and ran
the chat:start sequence from `handleChatStart` directly against it.
