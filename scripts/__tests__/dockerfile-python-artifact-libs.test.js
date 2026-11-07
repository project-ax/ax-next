// Agent artifacts guard — the agent image's pre-seeded Python venv ships
// hash-pinned reportlab, python-docx, openpyxl and matplotlib so an agent can
// write PDFs, Word documents, spreadsheets and charts without reaching pypi.
//
// Dockerfile-CONTENT + lockfile guard (reads text, does NOT build the image —
// the `docker-build` CI lane does that). It lives in scripts/__tests__/ so it
// runs on every PR via `pnpm test:scripts`, including one that touches only
// container/agent/ (see dockerfile-home-bin-path.test.js for why).
//
// Supply chain: every requirement must be an exact `name==version` pin with at
// least one sha256 hash, and the install must refuse anything else
// (`--require-hashes`), resolve nothing on its own (`--no-deps`) and never build
// an sdist (`--only-binary :all:` — no compiler in the image, no setup.py runs).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT_DIR = join(REPO_ROOT, 'container', 'agent');
const DOCKERFILE = join(AGENT_DIR, 'Dockerfile');
const LOCK = join(AGENT_DIR, 'python-artifact-libs.txt');
const INPUT = join(AGENT_DIR, 'python-artifact-libs.in');

const LIBRARIES = ['reportlab', 'python-docx', 'openpyxl', 'matplotlib'];

/** Join `\`-continued lines, drop comments/blank lines → one string per requirement. */
function requirements(text) {
  return text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter((line) => line.length > 0);
}

/** PEP 503 normalized name. */
function normalize(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

describe('container/agent/python-artifact-libs.txt', () => {
  it('every requirement is name==version with at least one sha256 hash, and the four libraries are pinned', () => {
    const reqs = requirements(readFileSync(LOCK, 'utf8'));
    expect(reqs.length).toBeGreaterThanOrEqual(LIBRARIES.length);
    const names = [];
    for (const req of reqs) {
      // `name==version ; optional marker --hash=sha256:<64 hex> ...` and nothing else.
      const m = req.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9.+!_-]+)(\s*;[^-]*)?((\s+--hash=sha256:[0-9a-f]{64})+)$/);
      expect(m, `not an exact hash-pinned requirement: ${req}`).not.toBeNull();
      names.push(normalize(m[1]));
    }
    for (const lib of LIBRARIES) expect(names).toContain(lib);

    // The human-edited input pins exactly the four top-level libraries, exactly.
    const top = requirements(readFileSync(INPUT, 'utf8'));
    expect(top.map((r) => normalize(r.split('==')[0])).sort()).toEqual([...LIBRARIES].sort());
    for (const r of top) expect(r).toMatch(/^[A-Za-z0-9._-]+==[0-9][A-Za-z0-9.]*$/);
  });

  it('the Dockerfile installs that file with --require-hashes --no-deps --only-binary :all: into the venv template before USER 1000:1000', () => {
    const text = readFileSync(DOCKERFILE, 'utf8');
    const copyAt = text.indexOf('COPY container/agent/python-artifact-libs.txt /tmp/python-artifact-libs.txt');
    expect(copyAt).toBeGreaterThan(-1);

    const install = text.match(/^RUN uv pip install [^\n]*-r \/tmp\/python-artifact-libs\.txt[^\n]*$/m);
    expect(install).not.toBeNull();
    const line = install[0];
    expect(line).toContain('--python /opt/ax-python-venv-template/bin/python');
    expect(line).toContain('--require-hashes');
    expect(line).toContain('--no-deps');
    expect(line).toContain('--only-binary :all:');
    expect(line).toContain('rm /tmp/python-artifact-libs.txt');
    expect(line).toContain('chown -R 1000:1000 /opt/ax-python-venv-template');

    const venvAt = text.indexOf('RUN uv venv --seed --relocatable /opt/ax-python-venv-template');
    const userAt = text.indexOf('\nUSER 1000:1000');
    expect(venvAt).toBeGreaterThan(-1);
    expect(venvAt).toBeLessThan(copyAt);
    expect(copyAt).toBeLessThan(install.index);
    expect(install.index).toBeLessThan(userAt);
  });

  it('the build imports all four right after the install, leaving no cache or bytecode in the image', () => {
    const text = readFileSync(DOCKERFILE, 'utf8');
    const install = text.match(/^RUN uv pip install [^\n]*-r \/tmp\/python-artifact-libs\.txt[^\n]*$/m);
    expect(install).not.toBeNull();
    const smoke = text.match(/^RUN [^\n]*\/opt\/ax-python-venv-template\/bin\/python -c "import reportlab, docx, openpyxl, matplotlib\.pyplot"[^\n]*$/m);
    expect(smoke, 'import smoke RUN missing').not.toBeNull();
    const line = smoke[0];
    // A wheel that installs but won't import (wrong arch, missing .so) fails the BUILD, not a session.
    expect(install.index).toBeLessThan(smoke.index);
    expect(smoke.index).toBeLessThan(text.indexOf('\nUSER 1000:1000'));
    // matplotlib's font cache goes to a throwaway dir that is removed in the same RUN,
    // and no root-owned __pycache__ lands in the 1000-owned venv.
    expect(line).toMatch(/MPLCONFIGDIR="?\$\(mktemp -d\)"?/);
    expect(line).toContain('PYTHONDONTWRITEBYTECODE=1');
    expect(line).toMatch(/rm -rf "?\$MPLCONFIGDIR"?/);
  });
});
