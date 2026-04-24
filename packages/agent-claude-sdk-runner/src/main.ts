#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Runner entry binary (claude-sdk variant).
//
// Scaffold only — real wiring (query(), canUseTool adapter, PostToolUse
// adapter, host-MCP bridge) lands in later Week 6.5d tasks. For now this
// exits with the fatal-bootstrap code so accidental invocation is loud.
//
// Exit codes (will match the native-runner convention once wired):
//   0 — turn loop completed normally.
//   1 — turn loop terminated.
//   2 — fatal during bootstrap (current placeholder behavior).
// ---------------------------------------------------------------------------

export async function main(): Promise<number> {
  return 2;
}

// ESM main-module guard. `require.main === module` doesn't work in ESM.
// Compare URLs to detect "was this file invoked directly".
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `runner: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    });
}
