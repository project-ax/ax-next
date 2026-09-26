# TASK-554: the full memory hydrate stops paying one round-trip per file

Follow-up to TASK-513 (#724). That card took `chat:start` off the whole-tree
hydrate. The observer, consolidator and `memory_note` still hydrate fully,
and they did it one `workspace:read` at a time. They run off the blocking
path, but the cost still grew with every agent's memory.

## Measurement (before any change)

Probe: a real in-process `@ax/workspace-git-server` storage server on
`127.0.0.1`, the production `createWorkspaceGitServerPlugin` client, and the
real `hydrateAgentTier` (full mode, no `only`). The mirror was warmed by one
hydrate, then we took the median of 5. Each doc is about 800 bytes. macOS
laptop, 2026-09-26, no kind cluster. It's the same shape as the TASK-513
probe.

| docs | full hydrate |
| ---: | ---: |
| 100 | 2.34 s |
| 300 | 7.05 s |

That works out to about **23 ms per file**, and it's linear. It matches
#724's after-row (2.69 s at 100). Here's where the time goes:

- `hydrateAgentTier` awaited each read before it started the next one.
- Each `workspace:read` was its own op in the engine's per-workspace queue.
  After #724 a pinned read skips the fetch, but it still spawns two git
  processes (`cat-file -e`, then `cat-file blob`).

TASK-513 rejected "parallelise the reads" because the queue serialises them
anyway. That's true for plain parallelism. It's also why the fix has two
halves.

## Fix (no hook-surface change)

1. **The engine coalesces concurrent pinned reads.** A pinned read joins the
   batch for its (workspace, version) if that batch hasn't started yet.
   A batch is **one** queued op, and it answers every path with **one**
   `git cat-file --batch`. Reads that arrive while a batch is running form
   the next batch. The queue invariant holds, because a batch is one op.
   A batch of one keeps the old single-read code. The paths go on stdin,
   never argv. A path with a line break skips the batch, because the batch
   protocol is one path per line.
2. **The hydrate issues reads concurrently after the pin.** Reads run
   serially only until the first *found* read. That read names the
   snapshot. Every read after it is pinned to that snapshot and runs
   concurrently, up to `HYDRATE_READ_CONCURRENCY` (64) at a time. If a read
   fails, no new reads start. The error is rethrown only after the in-flight
   reads settle, so `dispose` still removes the scratch dir (TASK-556).

We read the same paths at the same version and get the same bytes. The only
change is how long we wait. The `only` option is untouched, and it's still
safe only for create-only pipelines. Its seed reads benefit too. (Later,
TASK-560: more exactly, it is safe for pipelines that touch nothing outside
`only`. Since TASK-556 that includes bootstrap's placeholder `agent.md`
repair, which rewrites a file that is in `only`. See `HydrateOptions.only`.)

## After (same probe, same machine, median of 5)

| docs | before | after | speed-up |
| ---: | ---: | ---: | ---: |
| 100 | 2.34 s | 223 ms | 10.5x |
| 300 | 7.05 s | 375 ms | 18.8x |

The 200 extra docs now cost about 0.75 ms each, down from 23 ms. Most of what's
left is the two fetches every full hydrate makes: the unpinned
`workspace:list` and the first read, which is unpinned too.

The probe isn't committed. Its script is described above, and the counts
the fix relies on are pinned in
`packages/workspace-git-server/src/client/__tests__/pinned-read-batch.test.ts`:
39 concurrent pinned reads cost 2 `cat-file` spawns instead of 78.
