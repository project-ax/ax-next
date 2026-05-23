// ---------------------------------------------------------------------------
// Session-scoped Python virtualenv for weak-LLM-friendly `pip install`.
//
// The agent image has `python3` + `uv` but NO `pip` (Dockerfile installs
// python3, not python3-pip). `uvx` covers run-a-CLI, but not the common
// "install a library so my script can `import` it" need — and a weak model
// reaches for `pip install`, not `uv run --with`. So we make the familiar
// path work: provision a seeded venv (seed => pip inside the venv) and put it
// on the SDK subprocess PATH. Then `pip install X` writes into the venv and
// `python script.py` imports it. The venv lives on the ephemeral tier (dies at
// session end, never round-trips to the host).
//
// Provisioning is OFFLINE on the happy path: we copy a relocatable, pre-seeded
// venv template baked into the image at build time (see scaffoldPythonVenv +
// the Dockerfile bake of /opt/ax-python-venv-template). `uv venv --seed` is NOT
// offline — it fetches the seed wheels from pypi — so it's only a fallback for
// local dev / pre-bake images, and is timeout-bounded.
//
// CA-trust asymmetry: npm/npx trust the proxy MITM CA via NODE_EXTRA_CA_CERTS
// and uv via SSL_CERT_FILE (both already forwarded by proxy-startup). pip is
// special — it uses its vendored certifi bundle and ignores both, so it needs
// an explicit PIP_CERT pointing at the same CA PEM. See the design spec
// (docs/plans/2026-05-23-python-venv-pip-support-design.md).
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
export function buildPythonVenvEnv(
  input: PythonVenvEnvInput,
): Record<string, string> {
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

/** True iff `<venvDir>/pyvenv.cfg` exists — the canonical venv marker. */
async function venvAlreadyPresent(venvDir: string): Promise<boolean> {
  return fs
    .access(path.join(venvDir, 'pyvenv.cfg'))
    .then(() => true)
    .catch(() => false);
}

/** Default upper bound on the `uv venv --seed` child before we SIGKILL it. */
const DEFAULT_VENV_TIMEOUT_MS = 30_000;

/**
 * Location of the relocatable, pre-seeded venv template baked into the agent
 * image at build time. COUPLED to the Dockerfile bake (`container/agent/
 * Dockerfile`): `RUN uv venv --seed --relocatable /opt/ax-python-venv-template`.
 * If you move/rename it in one place, change the other.
 */
const DEFAULT_VENV_TEMPLATE_DIR = '/opt/ax-python-venv-template';

/** True iff `<templateDir>/pyvenv.cfg` is accessible — the baked template marker. */
async function templatePresent(templateDir: string): Promise<boolean> {
  return fs
    .access(path.join(templateDir, 'pyvenv.cfg'))
    .then(() => true)
    .catch(() => false);
}

/**
 * Provision a session-scoped Python venv at `<ephemeralRoot>/py` (seed => pip
 * inside the venv; no python3-pip in the image), then put it on the SDK
 * subprocess PATH.
 *
 * Happy path is an OFFLINE copy of the relocatable template baked into the
 * agent image (see `DEFAULT_VENV_TEMPLATE_DIR` + the Dockerfile bake). The
 * template was seeded at BUILD time when pypi was reachable, so the runtime
 * copy needs no network and works for egress-locked agents.
 *
 * Fallback (no template — e.g. local dev / pre-bake images) is the online
 * `uv venv --seed` spawn. NOT offline: `--seed` FETCHES pip/setuptools/wheel
 * from pypi.org, so when pypi egress is denied `uv` retries the blocked host
 * for ~5-23s before giving up — that fallback is bounded by `opts.timeoutMs`.
 *
 * This call is fired NON-BLOCKING from the startup path (see main.ts); it must
 * never sit on the cold-start critical path.
 *
 * Best-effort: returns true when the venv is ready (created OR already
 * present), false when provisioning failed OR timed out. On failure it logs to
 * the runner's stderr (the host's log sink) so the failure is visible, NOT
 * silent — then the caller skips the venv env wiring. Never throws: a venv
 * failure must not abort a session that never touches Python.
 *
 * Idempotent: a pre-existing venv short-circuits, so warm-runner re-entry
 * doesn't rebuild it.
 */
export async function scaffoldPythonVenv(
  ephemeralRoot: string,
  opts: { uvBin?: string; timeoutMs?: number; templateDir?: string } = {},
): Promise<boolean> {
  const venvDir = pythonVenvDir(ephemeralRoot);
  if (await venvAlreadyPresent(venvDir)) return true;

  // Happy path: copy the baked, relocatable template (offline). preserve the
  // venv's internal symlinks verbatim (verbatimSymlinks) so the copy stays a
  // valid venv. On any copy error, log and fall through to the uv fallback.
  const templateDir = opts.templateDir ?? DEFAULT_VENV_TEMPLATE_DIR;
  if (await templatePresent(templateDir)) {
    try {
      await fs.cp(templateDir, venvDir, {
        recursive: true,
        verbatimSymlinks: true,
      });
      return true;
    } catch (e) {
      process.stderr.write(
        `runner: python venv scaffold could not copy baked template ${templateDir}: ${(e as Error).message}; falling back to uv venv --seed\n`,
      );
      // fall through to the uv fallback
    }
  }

  const uvBin = opts.uvBin ?? 'uv';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VENV_TIMEOUT_MS;
  return new Promise<boolean>((resolve) => {
    const child = spawn(uvBin, ['venv', '--seed', venvDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const err: Buffer[] = [];
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    // Bound the child so the backgrounded scaffold can't leak/hang forever
    // (e.g. `uv` retrying a denied pypi host). On expiry: SIGKILL, log,
    // resolve(false). Cleared on close/error so a fast exit doesn't fire it.
    const timer = setTimeout(() => {
      process.stderr.write(
        `runner: python venv scaffold (uv venv --seed) timed out after ${timeoutMs}ms; killing child\n`,
      );
      child.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);
    // Don't keep the event loop alive on the timer alone.
    timer.unref?.();
    child.once('error', (e: Error) => {
      clearTimeout(timer);
      process.stderr.write(
        `runner: python venv scaffold could not spawn uv: ${e.message}\n`,
      );
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
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
