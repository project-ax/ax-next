# Python venv `pip install` Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pip install X` then `import X` Just Work inside the runner sandbox by activating a pre-seeded, session-scoped Python virtualenv on the SDK subprocess `PATH`.

**Architecture:** At session start (gated on `env.ephemeralRoot`), the runner runs `uv venv --seed <ephemeralRoot>/py` (best-effort). When the venv is ready, the SDK subprocess gets `PATH`/`VIRTUAL_ENV`/`PIP_CERT` env so `python`/`pip` resolve into the venv and pip trusts the credential-proxy's MITM CA. A one-line system-prompt note tells strong models the venv is active. Node is untouched (`npx` already suffices).

**Tech Stack:** TypeScript (ESM), Node `child_process`, `uv` (already in `container/agent/Dockerfile`), vitest. Package: `@ax/agent-claude-sdk-runner`.

**Design spec:** `docs/plans/2026-05-23-python-venv-pip-support-design.md`

---

## File Structure

- **Create** `packages/agent-claude-sdk-runner/src/python-venv.ts` — `pythonVenvDir`, `buildPythonVenvEnv` (pure), `scaffoldPythonVenv` (spawns `uv`). One feature, one focused module; kept separate from `tool-cache-env.ts` (npx/uvx cache concern) and `git-workspace.ts` (git concern).
- **Create** `packages/agent-claude-sdk-runner/src/__tests__/python-venv.test.ts` — unit tests for the above.
- **Modify** `packages/agent-claude-sdk-runner/src/system-prompt.ts` — add `pythonVenvNote()` and a third `pythonVenvActive` param to `buildSystemPrompt`. (Prompt notes live here, next to `ephemeralScratchNote`.)
- **Modify** `packages/agent-claude-sdk-runner/src/__tests__/system-prompt.test.ts` — assert the python note appears iff active.
- **Modify** `packages/agent-claude-sdk-runner/src/main.ts` — call `scaffoldPythonVenv` after materialize, thread a `pythonVenvReady` boolean, spread `buildPythonVenvEnv(...)` into the `query()` env, pass `pythonVenvReady` to `buildSystemPrompt`.
- **Modify** `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts` — mock `../python-venv.js` (`scaffoldPythonVenv` only; keep `buildPythonVenvEnv` real) and assert the env literal.
- **Modify** `deploy/MANUAL-ACCEPTANCE.md` — add the kind-cluster walk step.
- **Create** `docs/plans/2026-05-23-python-venv-pip-support-security-note.md` — security-checklist output.

---

## Task 0: Branch + land the design doc

**Files:** none (git only)

- [ ] **Step 1: Create a feature branch off `main`**

The current branch (`fix/memory-tools-call-input`) is unrelated. Branch from `main` so this work is isolated. Carry the already-written design doc along.

```bash
git stash push -u -- docs/plans/2026-05-23-python-venv-pip-support-design.md
git checkout main
git checkout -b feat/python-venv-pip
git stash pop
```

(If `git stash pop` reports the file is untracked-and-restored, that's fine — it lands on the new branch.)

- [ ] **Step 2: Commit the design doc**

```bash
git add docs/plans/2026-05-23-python-venv-pip-support-design.md
git commit -m "docs: python venv pip-support design spec"
```

---

## Task 1: `pythonVenvDir` + `buildPythonVenvEnv` (pure)

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/python-venv.ts`
- Test: `packages/agent-claude-sdk-runner/src/__tests__/python-venv.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-claude-sdk-runner/src/__tests__/python-venv.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPythonVenvEnv, pythonVenvDir } from '../python-venv.js';

describe('pythonVenvDir', () => {
  it('locates the venv at `<ephemeralRoot>/py`', () => {
    expect(pythonVenvDir('/ephemeral')).toBe('/ephemeral/py');
  });
});

describe('buildPythonVenvEnv', () => {
  it('returns {} when no ephemeral root is wired', () => {
    expect(
      buildPythonVenvEnv({ ephemeralRoot: undefined, currentPath: '/usr/bin', caCertFile: '/ca.crt' }),
    ).toEqual({});
    expect(
      buildPythonVenvEnv({ ephemeralRoot: '', currentPath: '/usr/bin', caCertFile: '/ca.crt' }),
    ).toEqual({});
  });

  it('prepends the venv bin dir to PATH and sets VIRTUAL_ENV', () => {
    const env = buildPythonVenvEnv({
      ephemeralRoot: '/ephemeral',
      currentPath: '/usr/local/bin:/usr/bin',
      caCertFile: undefined,
    });
    expect(env.PATH).toBe('/ephemeral/py/bin:/usr/local/bin:/usr/bin');
    expect(env.VIRTUAL_ENV).toBe('/ephemeral/py');
  });

  it('uses the bin dir alone when there is no existing PATH', () => {
    const env = buildPythonVenvEnv({
      ephemeralRoot: '/ephemeral',
      currentPath: undefined,
      caCertFile: undefined,
    });
    expect(env.PATH).toBe('/ephemeral/py/bin');
  });

  it('sets PIP_CERT + REQUESTS_CA_BUNDLE to the proxy CA when present', () => {
    const env = buildPythonVenvEnv({
      ephemeralRoot: '/ephemeral',
      currentPath: '/usr/bin',
      caCertFile: '/etc/ax/proxy-ca.crt',
    });
    expect(env.PIP_CERT).toBe('/etc/ax/proxy-ca.crt');
    expect(env.REQUESTS_CA_BUNDLE).toBe('/etc/ax/proxy-ca.crt');
  });

  it('omits the CA vars when no CA path is available', () => {
    const env = buildPythonVenvEnv({
      ephemeralRoot: '/ephemeral',
      currentPath: '/usr/bin',
      caCertFile: undefined,
    });
    expect('PIP_CERT' in env).toBe(false);
    expect('REQUESTS_CA_BUNDLE' in env).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ax/agent-claude-sdk-runner test python-venv`
Expected: FAIL — `Cannot find module '../python-venv.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/agent-claude-sdk-runner/src/python-venv.ts`:

```ts
// ---------------------------------------------------------------------------
// Session-scoped Python virtualenv for weak-LLM-friendly `pip install`.
//
// The agent image has `python3` + `uv` but NO `pip` (Dockerfile installs
// python3, not python3-pip). `uvx` covers run-a-CLI, but not the common
// "install a library so my script can `import` it" need — and a weak model
// reaches for `pip install`, not `uv run --with`. So we make the familiar
// path work: create a venv with `uv venv --seed` (seed => pip inside the
// venv) and put it on the SDK subprocess PATH. Then `pip install X` writes
// into the venv and `python script.py` imports it. The venv lives on the
// ephemeral tier (dies at session end, never round-trips to the host).
//
// CA-trust asymmetry: npm/npx trust the proxy MITM CA via NODE_EXTRA_CA_CERTS
// and uv via SSL_CERT_FILE (both already forwarded by proxy-startup). pip is
// special — it uses its vendored certifi bundle and ignores both, so it needs
// an explicit PIP_CERT pointing at the same CA PEM. See the design spec.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** The venv root for a given ephemeral tier: `<ephemeralRoot>/py`. */
export function pythonVenvDir(ephemeralRoot: string): string {
  return path.join(ephemeralRoot, 'py');
}

export interface PythonVenvEnvInput {
  /** Session ephemeral root; the venv lives at `<root>/py`. Undefined/'' => feature off. */
  ephemeralRoot: string | undefined;
  /** The PATH the SDK subprocess would otherwise get (from the proxy env allowlist). */
  currentPath: string | undefined;
  /** Proxy MITM CA PEM path so the venv's pip trusts the proxy. Undefined/'' => omit. */
  caCertFile: string | undefined;
}

/**
 * Env overrides that activate the venv for the SDK subprocess. Spread AFTER
 * `proxyStartup.anthropicEnv` in the `query()` env literal so PATH/VIRTUAL_ENV
 * win. Returns {} when no ephemeral root (or when the caller signals the venv
 * isn't ready by passing `ephemeralRoot: undefined`).
 */
export function buildPythonVenvEnv(input: PythonVenvEnvInput): Record<string, string> {
  const { ephemeralRoot, currentPath, caCertFile } = input;
  if (ephemeralRoot === undefined || ephemeralRoot === '') return {};
  const binDir = path.join(pythonVenvDir(ephemeralRoot), 'bin');
  const env: Record<string, string> = {
    PATH:
      currentPath !== undefined && currentPath !== ''
        ? `${binDir}:${currentPath}`
        : binDir,
    VIRTUAL_ENV: pythonVenvDir(ephemeralRoot),
  };
  if (caCertFile !== undefined && caCertFile !== '') {
    env.PIP_CERT = caCertFile; // pip uses vendored certifi; ignores SSL_CERT_FILE
    env.REQUESTS_CA_BUNDLE = caCertFile; // build-time `requests` calls during install
  }
  return env;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ax/agent-claude-sdk-runner test python-venv`
Expected: PASS (all `pythonVenvDir` + `buildPythonVenvEnv` cases).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/python-venv.ts \
        packages/agent-claude-sdk-runner/src/__tests__/python-venv.test.ts
git commit -m "feat(runner): buildPythonVenvEnv + pythonVenvDir for session venv activation"
```

---

## Task 2: `scaffoldPythonVenv` (spawns `uv venv --seed`)

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/python-venv.ts`
- Test: `packages/agent-claude-sdk-runner/src/__tests__/python-venv.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/agent-claude-sdk-runner/src/__tests__/python-venv.test.ts`:

```ts
import { beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scaffoldPythonVenv } from '../python-venv.js';

describe('scaffoldPythonVenv', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'venv-test-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // Stand-in for `uv`: a tiny shell script. scaffold invokes
  // `<uvBin> venv --seed <venvDir>`, so $3 is the venv dir.
  async function writeFakeUv(body: string): Promise<string> {
    const p = path.join(tmp, 'fake-uv.sh');
    await fs.writeFile(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  }

  it('creates the venv via `uv venv --seed` and returns true', async () => {
    const root = path.join(tmp, 'ephemeral');
    await fs.mkdir(root, { recursive: true });
    const uvBin = await writeFakeUv('mkdir -p "$3" && : > "$3/pyvenv.cfg"');
    await expect(scaffoldPythonVenv(root, { uvBin })).resolves.toBe(true);
    await expect(
      fs.access(path.join(pythonVenvDir(root), 'pyvenv.cfg')),
    ).resolves.toBeUndefined();
  });

  it('is idempotent: skips uv when a venv already exists', async () => {
    const root = path.join(tmp, 'ephemeral');
    const venvDir = pythonVenvDir(root);
    await fs.mkdir(venvDir, { recursive: true });
    await fs.writeFile(path.join(venvDir, 'pyvenv.cfg'), 'home = /usr\n');
    const sentinel = path.join(tmp, 'uv-ran');
    const uvBin = await writeFakeUv(`: > "${sentinel}"`);
    await expect(scaffoldPythonVenv(root, { uvBin })).resolves.toBe(true);
    await expect(fs.access(sentinel)).rejects.toThrow(); // uv NOT spawned
  });

  it('returns false (no throw) when uv exits non-zero', async () => {
    const root = path.join(tmp, 'ephemeral');
    await fs.mkdir(root, { recursive: true });
    const uvBin = await writeFakeUv('exit 3');
    await expect(scaffoldPythonVenv(root, { uvBin })).resolves.toBe(false);
  });

  it('returns false when uv cannot be spawned', async () => {
    const root = path.join(tmp, 'ephemeral');
    await fs.mkdir(root, { recursive: true });
    await expect(
      scaffoldPythonVenv(root, { uvBin: path.join(tmp, 'nope') }),
    ).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ax/agent-claude-sdk-runner test python-venv`
Expected: FAIL — `scaffoldPythonVenv` is not exported.

- [ ] **Step 3: Add the implementation**

Append to `packages/agent-claude-sdk-runner/src/python-venv.ts`:

```ts
/** True iff `<venvDir>/pyvenv.cfg` exists — the canonical venv marker. */
async function venvAlreadyPresent(venvDir: string): Promise<boolean> {
  return fs
    .access(path.join(venvDir, 'pyvenv.cfg'))
    .then(() => true)
    .catch(() => false);
}

/**
 * Create a session-scoped Python venv at `<ephemeralRoot>/py` via
 * `uv venv --seed` (seed => pip inside the venv; no python3-pip in the image).
 * Offline — uv ships the seed wheels.
 *
 * Best-effort: returns true when the venv is ready (created OR already
 * present), false when creation failed. On failure it logs to the runner's
 * stderr (the host's log sink) so the failure is visible, NOT silent — then
 * the caller skips the venv env wiring. Never throws: a venv failure must not
 * abort a session that never touches Python.
 *
 * Idempotent: a pre-existing venv short-circuits, so warm-runner re-entry
 * doesn't rebuild it.
 */
export async function scaffoldPythonVenv(
  ephemeralRoot: string,
  opts: { uvBin?: string } = {},
): Promise<boolean> {
  const venvDir = pythonVenvDir(ephemeralRoot);
  if (await venvAlreadyPresent(venvDir)) return true;
  const uvBin = opts.uvBin ?? 'uv';
  return new Promise<boolean>((resolve) => {
    const child = spawn(uvBin, ['venv', '--seed', venvDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const err: Buffer[] = [];
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.once('error', (e: Error) => {
      process.stderr.write(
        `runner: python venv scaffold could not spawn uv: ${e.message}\n`,
      );
      resolve(false);
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      process.stderr.write(
        `runner: python venv scaffold (uv venv --seed) exited ${code}: ${Buffer.concat(err).toString('utf8')}\n`,
      );
      resolve(false);
    });
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @ax/agent-claude-sdk-runner test python-venv`
Expected: PASS (all scaffold cases). The non-zero/spawn-error cases will print a `runner: python venv scaffold ...` line to stderr — expected.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/python-venv.ts \
        packages/agent-claude-sdk-runner/src/__tests__/python-venv.test.ts
git commit -m "feat(runner): scaffoldPythonVenv via uv venv --seed (best-effort, idempotent)"
```

---

## Task 3: `pythonVenvNote` + `buildSystemPrompt` third param

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/system-prompt.ts:36-74`
- Test: `packages/agent-claude-sdk-runner/src/__tests__/system-prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/agent-claude-sdk-runner/src/__tests__/system-prompt.test.ts` (inside the top-level `describe('buildSystemPrompt', ...)` or as a sibling describe — import `pythonVenvNote` alongside the existing imports):

```ts
// add `pythonVenvNote` to the existing import from '../system-prompt.js'

describe('python venv note', () => {
  it('omits the python note when the venv is not active', () => {
    const result = buildSystemPrompt('Custom prompt.', '/ephemeral', false);
    const text = typeof result === 'string' ? result : (result.append ?? '');
    expect(text).not.toContain(pythonVenvNote());
  });

  it('appends the python note onto a custom string prompt when active', () => {
    const result = buildSystemPrompt('Custom prompt.', '/ephemeral', true);
    expect(typeof result).toBe('string');
    const text = result as string;
    expect(text).toContain(pythonVenvNote());
    expect(text).toContain(ephemeralScratchNote('/ephemeral'));
  });

  it('uses the preset append for an empty prompt when active', () => {
    const result = buildSystemPrompt('', '/ephemeral', true);
    expect(typeof result).toBe('object');
    const append = (result as { append?: string }).append ?? '';
    expect(append).toContain(pythonVenvNote());
  });

  it('can emit the python note even without an ephemeral scratch note', () => {
    // venv active but (hypothetically) no scratch root → only the python note.
    const result = buildSystemPrompt('Custom.', undefined, true);
    const text = result as string;
    expect(text).toContain(pythonVenvNote());
  });

  it('defaults pythonVenvActive to false (back-compat 2-arg call)', () => {
    const result = buildSystemPrompt('Custom.', '/ephemeral');
    const text = result as string;
    expect(text).not.toContain(pythonVenvNote());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ax/agent-claude-sdk-runner test system-prompt`
Expected: FAIL — `pythonVenvNote` not exported / `buildSystemPrompt` takes 2 args.

- [ ] **Step 3: Implement — add the note and refactor note assembly**

In `packages/agent-claude-sdk-runner/src/system-prompt.ts`, add after `ephemeralScratchNote` (after line 46):

```ts
/**
 * Operational note telling the agent a session-scoped Python virtualenv is
 * active so `pip install` + `import` work. Fixed runner-authored prose for
 * the LLM — no untrusted input. Paired with the venv created by
 * scaffoldPythonVenv (python-venv.ts) and the PATH/VIRTUAL_ENV env it sets.
 */
export function pythonVenvNote(): string {
  return [
    `Python: a session-scoped virtual environment is already active.`,
    `Use \`pip install <pkg>\` to add Python dependencies and \`python <script>.py\` to run them —`,
    `installed packages are importable immediately.`,
    `The environment is discarded when the session ends, and installs are limited to the`,
    `package registries your agent is permitted to reach.`,
  ].join(' ');
}
```

Then replace `buildSystemPrompt` (lines 58-74) with:

```ts
export function buildSystemPrompt(
  agentSystemPrompt: string,
  ephemeralRoot: string | undefined,
  pythonVenvActive = false,
): SdkSystemPrompt {
  const notes: string[] = [];
  if (ephemeralRoot !== undefined) notes.push(ephemeralScratchNote(ephemeralRoot));
  if (pythonVenvActive) notes.push(pythonVenvNote());
  const note = notes.join('\n\n');

  if (agentSystemPrompt.length > 0) {
    return note.length > 0
      ? `${agentSystemPrompt}\n\n${note}`
      : agentSystemPrompt;
  }

  return note.length > 0
    ? { type: 'preset', preset: 'claude_code', append: note }
    : { type: 'preset', preset: 'claude_code' };
}
```

Also update the doc comment above `buildSystemPrompt` to mention the third arg (replace the bullet list at lines 53-56 with one that notes "and the python-venv note when `pythonVenvActive`").

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @ax/agent-claude-sdk-runner test system-prompt`
Expected: PASS (new python-note cases AND the pre-existing ephemeral-scratch cases — back-compat preserved).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/system-prompt.ts \
        packages/agent-claude-sdk-runner/src/__tests__/system-prompt.test.ts
git commit -m "feat(runner): pythonVenvNote + buildSystemPrompt pythonVenvActive flag"
```

---

## Task 4: Wire into `main.ts`

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts` (imports ~39, decl ~207, scaffold ~247, env literal ~606, buildSystemPrompt ~685)
- Test: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`, add a mock for `../python-venv.js` next to the existing `vi.mock('../git-workspace.js', ...)` block (after line 105). This mocks ONLY the spawn (`scaffoldPythonVenv`); `buildPythonVenvEnv` + `pythonVenvDir` stay real via `...actual` so the env-literal assertions exercise the real builder:

```ts
const scaffoldPythonVenvMock = vi.fn().mockResolvedValue(true);
vi.mock('../python-venv.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../python-venv.js')>();
  return { ...actual, scaffoldPythonVenv: scaffoldPythonVenvMock };
});
```

Add a `beforeEach` reset for the mock near the other mock resets (search for where `materializeMock`/`queryMock` get `mockClear`/`mockReset` in `beforeEach`, and add `scaffoldPythonVenvMock.mockClear(); scaffoldPythonVenvMock.mockResolvedValue(true);`).

Then add a new `describe` block (e.g. after the `Phase C: HOME redirect` describe, ~line 2333):

```ts
describe('Python venv activation', () => {
  // Same scaffolding as the HOME-redirect happy path, but with an ephemeral
  // root + a forwarded proxy CA so buildPythonVenvEnv produces the full set.
  function venvEnv() {
    return {
      ...COMPLETE_ENV,
      AX_EPHEMERAL_ROOT: '/ephemeral',
      SSL_CERT_FILE: '/etc/ax/proxy-ca.crt',
    };
  }
  function wireClient() {
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: { systemPrompt: '', allowedTools: [], mcpConfigIds: [], model: 'claude-sonnet-4-7' },
          conversationId: null,
          runnerSessionId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
      return (async function* () {
        const it = prompt[Symbol.asyncIterator]();
        await it.next();
        yield assistantText('ok');
        yield resultSuccess();
        await it.next();
      })();
    });
  }

  it('activates the venv in the SDK env when scaffold succeeds', async () => {
    setEnv(venvEnv());
    scaffoldPythonVenvMock.mockResolvedValue(true);
    wireClient();

    const { main } = await import('../main.js');
    expect(await main()).toBe(0);

    expect(scaffoldPythonVenvMock).toHaveBeenCalledWith('/ephemeral');
    const queryArg = queryMock.mock.calls[0]?.[0] as {
      options: { env: Record<string, string> };
    };
    expect(queryArg.options.env.VIRTUAL_ENV).toBe('/ephemeral/py');
    expect(queryArg.options.env.PATH.startsWith('/ephemeral/py/bin:')).toBe(true);
    expect(queryArg.options.env.PIP_CERT).toBe('/etc/ax/proxy-ca.crt');
    expect(queryArg.options.env.REQUESTS_CA_BUNDLE).toBe('/etc/ax/proxy-ca.crt');
  });

  it('does NOT activate the venv when scaffold fails', async () => {
    setEnv(venvEnv());
    scaffoldPythonVenvMock.mockResolvedValue(false);
    wireClient();

    const { main } = await import('../main.js');
    expect(await main()).toBe(0);

    const queryArg = queryMock.mock.calls[0]?.[0] as {
      options: { env: Record<string, string> };
    };
    expect(queryArg.options.env.VIRTUAL_ENV).toBeUndefined();
    expect(queryArg.options.env.PATH.startsWith('/ephemeral/py/bin')).toBe(false);
  });

  it('does not scaffold or activate when no ephemeral root is wired', async () => {
    setEnv(COMPLETE_ENV); // no AX_EPHEMERAL_ROOT
    scaffoldPythonVenvMock.mockResolvedValue(true);
    wireClient();

    const { main } = await import('../main.js');
    expect(await main()).toBe(0);

    expect(scaffoldPythonVenvMock).not.toHaveBeenCalled();
    const queryArg = queryMock.mock.calls[0]?.[0] as {
      options: { env: Record<string, string> };
    };
    expect(queryArg.options.env.VIRTUAL_ENV).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ax/agent-claude-sdk-runner test main`
Expected: FAIL — `scaffoldPythonVenvMock` never called / `VIRTUAL_ENV` undefined (main.ts not wired yet).

- [ ] **Step 3: Wire main.ts — imports**

Add after line 39 (`import { buildToolCacheEnv } from './tool-cache-env.js';`):

```ts
import { buildPythonVenvEnv, scaffoldPythonVenv } from './python-venv.js';
```

- [ ] **Step 4: Wire main.ts — readiness declaration**

After line 207 (`let initialBaselineCommit: string;`) add:

```ts
  // Set true once the session Python venv exists (created or pre-present).
  // Gates the venv env wiring + system-prompt note below.
  let pythonVenvReady = false;
```

- [ ] **Step 5: Wire main.ts — scaffold call after materialize**

After the `if (claudeConfigDir) { … }` block (line 247) and BEFORE the `} catch` (line 248), add:

```ts
    // Create a session-scoped Python venv on the ephemeral tier so the agent's
    // `pip install` + `import` Just Work (uv seeds pip; the image has no
    // python3-pip). Best-effort + gated on the ephemeral tier — a venv failure
    // must not abort the session. See python-venv.ts.
    if (env.ephemeralRoot) {
      pythonVenvReady = await scaffoldPythonVenv(env.ephemeralRoot);
    }
```

- [ ] **Step 6: Wire main.ts — env literal**

After line 606 (`...buildToolCacheEnv(env.ephemeralRoot),`) add:

```ts
          // Activate the session Python venv (PATH + VIRTUAL_ENV + pip CA
          // trust) so `pip install` reaches the venv and trusts the proxy
          // MITM CA. Gated on the scaffold actually succeeding (pythonVenvReady).
          // Spread AFTER anthropicEnv so PATH/VIRTUAL_ENV win. caCertFile is the
          // same proxy CA PEM the Node/uv tools already trust (SSL_CERT_FILE /
          // NODE_EXTRA_CA_CERTS, forwarded by proxy-startup). See python-venv.ts.
          ...buildPythonVenvEnv({
            ephemeralRoot: pythonVenvReady ? env.ephemeralRoot : undefined,
            currentPath: proxyStartup.anthropicEnv.PATH,
            caCertFile:
              proxyStartup.anthropicEnv.SSL_CERT_FILE ??
              proxyStartup.anthropicEnv.NODE_EXTRA_CA_CERTS,
          }),
```

- [ ] **Step 7: Wire main.ts — buildSystemPrompt arg**

Replace the `buildSystemPrompt(...)` call at lines 685-688:

```ts
        systemPrompt: buildSystemPrompt(
          agentConfig.systemPrompt,
          env.ephemeralRoot,
        ),
```

with:

```ts
        systemPrompt: buildSystemPrompt(
          agentConfig.systemPrompt,
          env.ephemeralRoot,
          pythonVenvReady,
        ),
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm --filter @ax/agent-claude-sdk-runner test main`
Expected: PASS — all three new venv-activation cases plus the pre-existing main.test.ts suite.

- [ ] **Step 9: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/main.ts \
        packages/agent-claude-sdk-runner/src/__tests__/main.test.ts
git commit -m "feat(runner): wire session Python venv into SDK subprocess (scaffold + env + prompt note)"
```

---

## Task 5: Full build + test + lint gate

**Files:** none (verification)

- [ ] **Step 1: Typecheck + build the whole workspace**

Run: `pnpm build`
Expected: clean exit 0. (`vitest` tolerates undeclared deps; `tsc` does not — this catches import/type drift the unit runs miss.)

- [ ] **Step 2: Run the package test suite**

Run: `pnpm test --filter @ax/agent-claude-sdk-runner`
Expected: PASS, no regressions.

- [ ] **Step 3: Lint the changed files only**

Repo-wide `pnpm lint` exits 1 on stale `.worktrees/` copies (known noise). Scope to this branch's files:

Run: `pnpm exec eslint packages/agent-claude-sdk-runner/src/python-venv.ts packages/agent-claude-sdk-runner/src/system-prompt.ts packages/agent-claude-sdk-runner/src/main.ts packages/agent-claude-sdk-runner/src/__tests__/python-venv.test.ts packages/agent-claude-sdk-runner/src/__tests__/system-prompt.test.ts packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`
Expected: clean exit 0.

- [ ] **Step 4: Commit any lint/build fixups (if needed)**

```bash
git add -A
git commit -m "chore(runner): build/lint fixups for python venv support"
```

(Skip if Steps 1-3 were already clean.)

---

## Task 6: Security note + run the security-checklist skill

**Files:**
- Create: `docs/plans/2026-05-23-python-venv-pip-support-security-note.md`

- [ ] **Step 1: Invoke the security-checklist skill**

This change spawns a process at session start (`uv venv`), adds env vars to the SDK subprocess, and manipulates `PATH` — it touches the sandbox boundary. Invoke the `security-checklist` skill and walk all three threat models. Capture answers for at least:

- **Sandbox escape:** new env vars (`VIRTUAL_ENV`, `PIP_CERT`, `REQUESTS_CA_BUNDLE`, modified `PATH`) carry no secrets — `caCertFile` is a public CA cert path already in the subprocess env; no `AX_*`/bearer exposure. The venv dir is inside the already-granted `additionalDirectories: [ephemeralRoot]` — no new filesystem capability. `uv venv` runs offline (no network).
- **Prompt injection:** `pythonVenvNote()` is fixed runner-authored prose; no model/user/tool input flows into it. The venv path is host-derived (`ephemeralRoot`), never agent-supplied.
- **Supply chain / egress:** `pip`/`python` egress remains gated by the same credential-proxy + per-session allowlist as `npx`/`uvx`; the venv grants no new network reach. Installs only succeed for allowlisted registries (`capabilities.packages.pypi`).
- **Warm-reuse tenant isolation (verify, don't assume):** confirm idle-keepalive (PR #124, see `docs/plans/2026-05-22-sandbox-idle-keepalive-design.md`) reuses a warm runner only within the same session/tenant, so the venv's installed packages aren't a cross-tenant leak. If reuse could cross tenants, `/ephemeral` itself would already leak — so document the finding either way.

- [ ] **Step 2: Write the security note**

Save the skill's structured output to `docs/plans/2026-05-23-python-venv-pip-support-security-note.md`.

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-05-23-python-venv-pip-support-security-note.md
git commit -m "docs: security note for python venv pip support"
```

---

## Task 7: MANUAL-ACCEPTANCE walk step

**Files:**
- Modify: `deploy/MANUAL-ACCEPTANCE.md`

- [ ] **Step 1: Add the walk step**

Append a step under the appropriate section of `deploy/MANUAL-ACCEPTANCE.md` (match the existing heading/format — read the file first). Content:

```markdown
### Python `pip install` in the sandbox

On `ax-next-dev` (kind), in a chat against an agent whose manifest allows a pypi
package (e.g. `requests` via `capabilities.packages.pypi`), ask the agent to:

1. Run `pip install requests` in a Bash tool.
2. Run a one-line script: `python -c "import requests; print(requests.__version__)"`.

**Expected:** the install completes through the credential-proxy (no TLS error —
this proves `PIP_CERT` trusts the MITM CA) and the import prints a version.
A blocked install for a NON-allowlisted package proves the egress gate still holds.

**Why manual:** the live MITM-CA TLS path can't be exercised by the unit tests —
this is the ground-truth check.
```

- [ ] **Step 2: Commit**

```bash
git add deploy/MANUAL-ACCEPTANCE.md
git commit -m "docs: MANUAL-ACCEPTANCE step for python pip install in sandbox"
```

---

## Task 8: Open the PR

**Files:** none

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/python-venv-pip
gh pr create --title "feat(runner): session-scoped Python venv for pip install" \
  --body "$(cat <<'EOF'
Makes `pip install X` + `import X` work inside the runner sandbox via a
pre-seeded, session-scoped uv venv on the SDK subprocess PATH. Node untouched
(npx already covers it). Design + security notes under docs/plans/2026-05-23-*.

## Boundary review
- **Alternate impl:** N/A — no new hook surface (runner-internal env wiring + one process spawn).
- **Payload field names that might leak:** none (no hook payload changed).
- **Subscriber risk:** none.
- **Capabilities:** new SDK-subprocess env vars (PATH/VIRTUAL_ENV/PIP_CERT/REQUESTS_CA_BUNDLE) carry no secrets; venv lives in the already-granted ephemeral additionalDirectory; egress unchanged (same proxy + allowlist). See security note.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Note the manual-acceptance dependency**

The kind walk (Task 7) is the real proof and can't run in CI. Flag in the PR description (or a follow-up comment) that MANUAL-ACCEPTANCE must be walked before merge.

---

## Self-Review (completed during planning)

- **Spec coverage:** scaffold (Task 2), env builder incl. `PIP_CERT` (Task 1), system-prompt note (Task 3), eager-every-session gating + readiness threading (Task 4), egress/CA verification + warm-reuse check (Task 6 security note), kind walk (Task 7), node-out-of-scope (no node tasks — by design). All spec sections map to a task.
- **Placeholder scan:** none — every code/test step has complete code and exact commands.
- **Type consistency:** `pythonVenvDir`, `buildPythonVenvEnv(PythonVenvEnvInput)`, `scaffoldPythonVenv(root, { uvBin })`, `pythonVenvNote()`, `buildSystemPrompt(prompt, ephemeralRoot, pythonVenvActive=false)`, `pythonVenvReady` — names are consistent across Tasks 1-4.
