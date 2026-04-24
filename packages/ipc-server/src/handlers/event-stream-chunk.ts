import type { HandlerErr } from './types.js';

// ---------------------------------------------------------------------------
// POST /event.stream-chunk
//
// 6.5a has SCHEMA ONLY for stream-chunk — the runtime plumbing (streaming
// incremental tokens from the runner to the host) lands in 6.5b. A caller
// posting here today has mistaken 6.5a for 6.5b; fail loudly so the bug
// surfaces in development, not in silent-data-loss production territory.
// ---------------------------------------------------------------------------

export function streamChunkNotWired(): HandlerErr {
  return {
    status: 501,
    body: {
      error: {
        code: 'INTERNAL',
        message: 'event.stream-chunk is a 6.5b feature',
      },
    },
  };
}
