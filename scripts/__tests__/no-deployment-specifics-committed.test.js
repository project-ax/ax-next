// Guard: one deployment's infrastructure must not land in this public repo.
//
// WHY THIS EXISTS. `ax-next` is a PUBLIC, MIT-licensed repo, and
// `deploy/charts/ax-next/gke-values.yaml` is a TEMPLATE for anyone installing
// the chart -- not a record of ours. The file says so itself, in its own
// conventions: `image.repository` ships as
// `us-central1-docker.pkg.dev/PROJECT_ID/ax-next/agent   # >>> EDIT`, and the
// DB secret name carries the same marker. Every value that IS specific to one
// deployment -- the real image repository, `ingress.host`,
// `http.allowedOrigins`, `onboarding.publicBaseUrl` -- already lives in
// `gke-values.local.yaml`, which `.gitignore` excludes via `*.local.yaml`.
//
// The convention held until a session writing a handoff plan put a live
// Filestore IP and a cluster CIDR into `docs/plans/`, and recommended putting
// the same IP into the committed overlay. Neither is a credential -- an
// RFC1918 address is unreachable from outside the VPC -- so `gitleaks`, which
// hunts for secrets, was never going to catch it, and did not. That is the gap
// this fills: gitleaks answers "is this a credential", and this answers "is
// this OUR deployment, in a file we hand to strangers".
//
// THE ANTI-PATTERN THIS AVOIDS. The obvious guard is a denylist of the real
// project id and the real IP. That guard would publish the very strings it
// exists to keep out, in a file anyone can read -- the check becomes the leak.
// So this file contains an ALLOWLIST of harmless examples and no denylist at
// all. If you are ever tempted to add a real value here to "make the check
// stricter", you are about to publish it: the fix belongs in the file that
// holds it, not in this one.
//
//   Gate 1 -- every RFC1918 literal under `deploy/**` and `docs/**` must be a
//   known EXAMPLE address. The allowlist is by VALUE, not by file, and that is
//   what makes it both small and strict: the repo's private-IP literals are a
//   closed set of textbook addresses (`10.0.0.1`, `192.168.1.1`, the SSRF
//   blocklist CIDRs, and two NFS-server test fixtures), while a real VPC
//   address is by definition not one of them, so it fails on sight. (The
//   address that prompted this guard is deliberately not repeated here -- see
//   THE ANTI-PATTERN above. It is not in the repo any more and this file is
//   not the place to put it back.)
//
//   A first draft banned RFC1918 outright and scoped around the false
//   positives instead. That was wrong twice over: it would have failed ~14
//   legitimate historical lines across seven older plans, and the scope needed
//   to dodge them (chart values only) would have EXCLUDED docs/plans -- which
//   is precisely where the real leak was. An allowlist keeps the coverage where
//   the bug happened.
//
//   Gate 2 -- the committed overlay keeps its placeholders. A `>>> EDIT` marker
//   is a promise that the value beside it is not real. Gate 1 cannot see a
//   project id or a hostname, so this checks the specific fields where a real
//   value is most tempting to paste.
//
// IF THIS FIRES, the fix is almost never to edit this file. Move the value to
// `gke-values.local.yaml` (gitignored, `-f`'d second by `make gke-deploy`, so
// it wins), and leave a placeholder plus a `>>> EDIT` marker behind so the
// option stays discoverable. For prose, cite the `gcloud ... describe` command
// that PRODUCES the value instead of the value -- a reader with cluster access
// gets the right answer, and a reader without it learns nothing about us. See
// `docs/plans/2026-09-10-userfiles-tier-enablement-handoff.md` for that shape.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Tracked files under the given pathspecs. Tracked only: an operator's own
 *  gitignored `*.local.yaml` is exactly where these values are SUPPOSED to be. */
function trackedFiles(pathspecs) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p.length > 0);
}

function read(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8');
}

/**
 * RFC1918: 10/8, 172.16/12, 192.168/16. Four octets required, so a version
 * string like `10.10.0` is not mistaken for an address.
 *
 * Deliberately NOT matching every private range. Link-local (169.254) is
 * meaningful in cloud-metadata docs and CGNAT (100.64/10) shows up in
 * legitimate cluster-CIDR discussion. Those are documentation, not identity.
 * The three ranges here are the ones a real VPC address actually lands in.
 */
const RFC1918 =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

/**
 * Private addresses that are allowed to appear, because they identify nothing.
 *
 * Two classes, and both are safe for the same reason -- they are the same in
 * every copy of this repo and describe no real machine:
 *
 *   - RFC5737/textbook example addresses used in prose and tests
 *     (`10.0.0.1`, `192.168.1.1`, `10.0.0.5`, `10.42.0.5`), plus the two
 *     NFS-server fixtures the sandbox and chart-render suites are built on.
 *   - The bounds of the private ranges themselves, which appear in the
 *     credential-proxy's SSRF blocklist documentation. A doc explaining that we
 *     BLOCK `10.0.0.0/8` has to be able to write `10.0.0.0`.
 *
 * Adding to this list is a judgement call with one question: would this string
 * be identical in a fork owned by a stranger? If not, it does not belong here.
 */
const EXAMPLE_ADDRESSES = new Set([
  '10.0.0.0',
  '10.0.0.1',
  '10.0.0.2',
  '10.0.0.5',
  '10.42.0.5',
  '10.9.8.7',
  '172.16.0.0',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.0.0',
  '192.168.1.1',
]);

describe('no deployment-specific infrastructure in the public tree', () => {
  it('has no unrecognised RFC1918 address in deploy/ or docs/', () => {
    const offenders = [];
    for (const file of trackedFiles(['deploy', 'docs'])) {
      const text = read(file);
      for (const [i, line] of text.split('\n').entries()) {
        const hits = (line.match(RFC1918) ?? []).filter(
          (ip) => !EXAMPLE_ADDRESSES.has(ip),
        );
        if (hits.length > 0) offenders.push(`${file}:${i + 1}  ${hits.join(', ')}`);
      }
    }
    expect(
      offenders,
      'A private (RFC1918) address is committed under deploy/ or docs/.\n' +
        'This repo is PUBLIC: that is one deployment\'s internal address, useless to\n' +
        'anyone else installing the chart, and gitleaks will not catch it because it\n' +
        'is not a credential.\n\n' +
        'For chart values: move it to deploy/charts/ax-next/gke-values.local.yaml\n' +
        '(gitignored) and leave `""` plus a `>>> EDIT` marker in gke-values.yaml.\n' +
        'For prose: cite the `gcloud ... describe` command that produces the value\n' +
        'rather than the value itself.\n' +
        'If it is genuinely a documentation example, add it to EXAMPLE_ADDRESSES\n' +
        'above — but only if the same string would appear in a stranger\'s fork.',
    ).toEqual([]);
  });

  it('keeps gke-values.yaml a template — its >>> EDIT fields stay placeholders', () => {
    const values = read('deploy/charts/ax-next/gke-values.yaml');
    const problems = [];

    // The image repository is the field most likely to be "fixed" by pasting a
    // real one, and it is the field that carries the GCP project id.
    const repo = /^\s*repository:\s*(\S+)/m.exec(values);
    if (repo !== null && !repo[1].includes('PROJECT_ID')) {
      problems.push(
        `image.repository is "${repo[1]}" — expected the PROJECT_ID placeholder`,
      );
    }

    // Fields that name a specific piece of infrastructure. Each must be empty
    // in the committed overlay; the real value belongs in the local file. Only
    // checked when present, so adding a key does not require editing this test
    // -- but adding a key with a real VALUE does fail, which is the point.
    for (const key of ['server', 'hostReadPath']) {
      const m = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(values);
      if (m === null) continue;
      const raw = m[1].split('#')[0].trim();
      if (raw !== '""' && raw !== "''" && raw.length > 0) {
        problems.push(`sandbox.filestore.${key} is ${raw} — expected "" in the template`);
      }
    }

    expect(
      problems,
      'deploy/charts/ax-next/gke-values.yaml is the overlay we hand to anyone\n' +
        'installing this chart, and it advertises itself as a template with\n' +
        '`>>> EDIT` markers. A real value here ships one deployment\'s\n' +
        'infrastructure to every reader of a public repo.\n' +
        'Put it in gke-values.local.yaml instead — make gke-deploy passes that\n' +
        'file second, so it wins.',
    ).toEqual([]);
  });

});
