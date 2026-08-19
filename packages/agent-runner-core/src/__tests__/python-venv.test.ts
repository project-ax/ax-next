import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildPythonVenvEnv,
  pythonVenvDir,
  scaffoldPythonVenv,
} from '../python-venv.js';

describe('pythonVenvDir', () => {
  it('locates the venv at `<ephemeralRoot>/py`', () => {
    expect(pythonVenvDir('/ephemeral')).toBe('/ephemeral/py');
  });
});

describe('buildPythonVenvEnv', () => {
  it('returns {} when no ephemeral root is wired', () => {
    expect(
      buildPythonVenvEnv({
        ephemeralRoot: undefined,
        currentPath: '/usr/bin',
        caCertFile: '/ca.crt',
      }),
    ).toEqual({});
    expect(
      buildPythonVenvEnv({
        ephemeralRoot: '',
        currentPath: '/usr/bin',
        caCertFile: '/ca.crt',
      }),
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

  it('copies the baked template when present (offline) and does NOT spawn uv', async () => {
    const root = path.join(tmp, 'ephemeral');
    await fs.mkdir(root, { recursive: true });

    // A minimal fake baked venv: pyvenv.cfg marker, a bin/pip "script", and a
    // symlink (representative of a real venv's internal symlinks) so we can
    // assert verbatimSymlinks preserved it as a link.
    const template = path.join(tmp, 'template');
    await fs.mkdir(path.join(template, 'bin'), { recursive: true });
    await fs.writeFile(path.join(template, 'pyvenv.cfg'), 'home = /usr/bin\n');
    await fs.writeFile(path.join(template, 'bin', 'pip'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    await fs.symlink('pip', path.join(template, 'bin', 'pip3'));

    // A uvBin that would FAIL the test if scaffold ever spawned it: it drops a
    // sentinel. We assert the sentinel was never written.
    const sentinel = path.join(tmp, 'uv-ran');
    const uvBin = await writeFakeUv(`: > "${sentinel}"; mkdir -p "$3"`);

    await expect(
      scaffoldPythonVenv(root, { uvBin, templateDir: template }),
    ).resolves.toBe(true);

    const venvDir = pythonVenvDir(root);
    await expect(
      fs.access(path.join(venvDir, 'pyvenv.cfg')),
    ).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(venvDir, 'bin', 'pip'), 'utf8'),
    ).resolves.toBe('#!/bin/sh\n');
    // verbatimSymlinks: the internal symlink was copied AS a symlink, not
    // dereferenced into a regular file.
    const st = await fs.lstat(path.join(venvDir, 'bin', 'pip3'));
    expect(st.isSymbolicLink()).toBe(true);
    await expect(fs.access(sentinel)).rejects.toThrow(); // uv NOT spawned
  });

  it('falls back to `uv venv --seed` when no template is present', async () => {
    const root = path.join(tmp, 'ephemeral');
    await fs.mkdir(root, { recursive: true });
    const uvBin = await writeFakeUv('mkdir -p "$3" && : > "$3/pyvenv.cfg"');
    await expect(
      scaffoldPythonVenv(root, {
        uvBin,
        templateDir: path.join(tmp, 'no-such-template'),
      }),
    ).resolves.toBe(true);
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

  it('returns false (kills the child) when uv exceeds the timeout', async () => {
    const root = path.join(tmp, 'ephemeral');
    await fs.mkdir(root, { recursive: true });
    // A uv stand-in that hangs well past the timeout. The timer must fire,
    // SIGKILL the child, and resolve(false) — modelling the real-world case
    // where `uv venv --seed` blocks on a denied pypi host for 5-23s.
    const uvBin = await writeFakeUv('sleep 30');
    const started = Date.now();
    await expect(
      scaffoldPythonVenv(root, { uvBin, timeoutMs: 200 }),
    ).resolves.toBe(false);
    // The timer (200ms) fired and killed the child; we are NOT waiting on the
    // 30s sleep. Give generous headroom for CI scheduling.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
