// TASK-19 guard — the agent image's `.bashrc` must keep putting `$HOME/bin`
// on PATH so binaries the agent installs there are found in later sessions.
//
// This is a Dockerfile-CONTENT guard (it reads the Dockerfile text, it does
// NOT build the image — the `docker-build` CI lane does that). It lives in
// scripts/__tests__/ because the root `test` script runs `pnpm test:scripts`
// (`vitest run --root scripts`) UNCONDITIONALLY on every PR — outside CI's
// affected-package gate — so this guard runs even on a PR that touches ONLY
// `container/agent/Dockerfile`. (A test placed inside @ax/agent-claude-sdk-runner
// would be skipped by `pnpm --filter "...[BASE_SHA]"` on such a PR — see
// .claude/memory/patterns.md, the ARCH-11 path-reach/affected-selection note.)
//
// The LOAD-BEARING $HOME/bin PATH wiring is the runner's SDK-subprocess env
// (packages/agent-claude-sdk-runner/src/home-bin-env.ts, covered by its own
// unit tests + main.test.ts) — the SDK Bash tool is non-interactive and never
// sources .bashrc. This .bashrc is the convention/interactive-shell layer; the
// guard keeps it from silently vanishing.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Repo-root-relative (worktree-safe — resolves from THIS file, not cwd).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCKERFILE = join(REPO_ROOT, 'container', 'agent', 'Dockerfile');

describe('container/agent/Dockerfile $HOME/bin on PATH', () => {
  const text = readFileSync(DOCKERFILE, 'utf8');

  it('writes a .bashrc into the image home', () => {
    expect(text).toMatch(/>\s*\/home\/axagent\/\.bashrc/);
  });

  it('adds $HOME/bin to PATH in that .bashrc (appended, not prepended)', () => {
    // The exact line the runtime shell would execute. Matching the literal
    // `PATH="$PATH:$HOME/bin"` (single-quoted in the Dockerfile printf so
    // $HOME/$PATH stay un-expanded at build time and resolve at runtime).
    // APPEND, not prepend (I5): $HOME is model-writable + restored across
    // sessions; a leading entry would let an injected binary shadow trusted
    // image tools persistently. So $HOME/bin must NOT lead PATH.
    expect(text).toContain('PATH="$PATH:$HOME/bin"');
    expect(text).not.toContain('PATH="$HOME/bin:$PATH"');
    // And it's exported so child shells inherit it.
    expect(text).toMatch(/\bexport PATH\b/);
  });

  it('guards the prepend so it is idempotent (no unbounded PATH growth)', () => {
    // A `case ":$PATH:" in *":$HOME/bin:"*)` guard means re-sourcing the
    // .bashrc does not stack duplicate $HOME/bin entries.
    expect(text).toContain('case ":$PATH:" in');
    expect(text).toContain('*":$HOME/bin:"*)');
  });
});
