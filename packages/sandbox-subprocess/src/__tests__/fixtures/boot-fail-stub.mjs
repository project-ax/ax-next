#!/usr/bin/env node
// Mimics a runner that fails at boot (TASK-784): it writes a fatal line to
// stderr — echoing its proxy token, as a careless runner might — and exits 2,
// the runner shell's fatal exit code.
process.stderr.write(`runner: proxy token was ${process.env.AX_PROXY_TOKEN ?? '<unset>'}\n`);
process.stderr.write('runner: invalid env: AX_PROXY_TOKEN (expected 32 lowercase hex characters)\n');
process.exit(2);
