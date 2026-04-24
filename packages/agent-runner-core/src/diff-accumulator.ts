// ---------------------------------------------------------------------------
// Per-turn workspace-diff accumulator (Task 7c).
//
// Both runners (native + claude-sdk) accumulate file changes during a turn
// and flush them as one `workspace.commit-notify` request at turn end.
// Workspace commits are turn-end, NOT per-tool-call (MVP direction memo,
// week-7-9 plan handoff line 38). One commit per turn even if 5 tools
// wrote files.
//
// Semantics:
//
//   - Last-write-wins per path within a turn. If the model writes A,
//     deletes A, writes A again — the host sees one `put` for A.
//   - The accumulator owns no concept of "parent version"; the runner
//     tracks that separately and feeds it on flush.
//   - Bytes are stored as `Uint8Array`; the runner base64-encodes on the
//     wire when it materializes the request body.
//   - Mirrors `@ax/core.FileChange` shape but redeclared here because
//     sandbox-side packages must not import the kernel.
// ---------------------------------------------------------------------------

export type AccumulatedFileChange =
  | { path: string; kind: 'put'; content: Uint8Array }
  | { path: string; kind: 'delete' };

export interface DiffAccumulator {
  /** Record a put or delete. Last-write-wins per path within the turn. */
  record(change: AccumulatedFileChange): void;
  /** Drain everything accumulated so far and reset to empty. */
  drain(): AccumulatedFileChange[];
  /** True if no changes have been recorded since the last drain. */
  isEmpty(): boolean;
}

export function createDiffAccumulator(): DiffAccumulator {
  let map = new Map<string, AccumulatedFileChange>();
  return {
    record(change) {
      map.set(change.path, change);
    },
    drain() {
      const out = Array.from(map.values());
      map = new Map();
      return out;
    },
    isEmpty() {
      return map.size === 0;
    },
  };
}

/**
 * Materialize an accumulated change list into the wire shape expected by
 * `workspace.commit-notify`: `put.content` is base64-encoded since JSON
 * can't carry Uint8Array. The host's Zod transform decodes it back.
 */
export function toWireChanges(
  changes: AccumulatedFileChange[],
): Array<
  | { path: string; kind: 'put'; content: string }
  | { path: string; kind: 'delete' }
> {
  return changes.map((c) => {
    if (c.kind === 'delete') return { path: c.path, kind: 'delete' };
    return {
      path: c.path,
      kind: 'put',
      content: Buffer.from(c.content).toString('base64'),
    };
  });
}
