// Guard: the kind tooling only ever acts on the `kind-ax-next-dev` kube context, no
// matter what the caller's DEFAULT context is (TASK-694).
//
// WHY THIS EXISTS. On at least one maintainer machine the default kubectl context is
// the live GKE cluster, not kind. The Makefile's kind targets and the acceptance
// skill's snippets called BARE `kubectl`/`helm`, so following the documented commands
// acted on whatever the default happened to be. Measured 2026-09-29 (TASK-689): a
// deploy script built from those snippets ran `rollout restart` on the GKE host
// (`strategy: Recreate`, so about ten seconds of outage). The bug was a CONVENTION —
// "remember to pass --context" — and a convention is exactly what nobody re-reads.
// This file makes it a check that cannot be forgotten, at three levels:
//
//   1. TEXT   — the Makefile mentions `kubectl` / `helm` only in comments and in the
//               four pinned definitions. A bare call cannot be added without failing
//               here, whatever target it lands in.
//   2. BEHAVIOUR — every cluster-touching target is actually RUN, through recording
//               stand-ins for kubectl/helm/docker/kind/pnpm, against a THROWAWAY
//               kubeconfig whose default context is a fake "prod". Every recorded
//               call must name the pinned context; with the kind context missing the
//               target must refuse before it does any work (no `docker build` first).
//               Nothing here can reach a real cluster: the stand-ins come first on
//               PATH, and the only server the throwaway kubeconfig knows is a dead
//               local port.
//   3. DOCS   — every kubectl/helm command in the kind-facing docs (fenced snippets
//               and inline command spans) carries the same pin, so a snippet can be
//               pasted as-is on a machine whose default is not kind.
//
// Each scanner has a self-test against synthetic input, because a guard that cannot
// fail wears the costume of a guard: the self-tests are what prove the scans see what
// they claim to.
//
// The prod-shaped names below are FAKE on purpose (`gke_example-project_…`): this repo
// is public, and `no-deployment-specifics-committed.test.js` exists to keep one
// deployment's real names out of it. Do not paste a real context name into this file.
//
// Runs under `pnpm test:scripts` with no network, no Docker and no cluster. It needs
// `make`, `bash`, `jq` and `git` on PATH — all of which the Makefile itself needs.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAKEFILE = join(REPO_ROOT, 'Makefile');

const KIND_CONTEXT = 'kind-ax-next-dev';
const FAKE_PROD_CONTEXT = 'gke_example-project_us-central1-a_example-prod';

// ─── 1. TEXT: the Makefile mentions the tools only in the pinned definitions ──────────

const PINNED_DEFINITIONS = [
  /^KUBE_CONTEXT\s*:=\s*kind-\$\(KIND_CLUSTER\)\s*$/,
  /^KUBECTL\s*:=\s*kubectl --context \$\(KUBE_CONTEXT\)\s*$/,
  /^HELM\s*:=\s*helm --kube-context \$\(KUBE_CONTEXT\)\s*$/,
  /^GKE_KUBECTL\s*=\s*kubectl --context \$\(GKE_CONTEXT\)\s*$/,
  /^GKE_HELM\s*=\s*helm --kube-context \$\(GKE_CONTEXT\)\s*$/,
];

/** Lines of a Makefile that name kubectl/helm outside a comment and outside the pinned definitions. */
function bareToolLines(makefileText) {
  const out = [];
  makefileText.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return; // a comment, including a tab-indented one inside a recipe
    if (!/\b(kubectl|helm)\b/.test(line)) return;
    if (PINNED_DEFINITIONS.some((re) => re.test(line))) return;
    out.push(`Makefile:${i + 1}: ${line.trim()}`);
  });
  return out;
}

describe('Makefile text: kubectl/helm appear only in the pinned definitions', () => {
  it('has no call that bypasses the pinned variables', () => {
    expect(bareToolLines(readFileSync(MAKEFILE, 'utf8'))).toEqual([]);
  });

  it('defines every pinned variable, and KUBE_CONTEXT can only ever be a kind context', () => {
    const lines = readFileSync(MAKEFILE, 'utf8').split('\n');
    for (const re of PINNED_DEFINITIONS) {
      expect(
        lines.some((l) => re.test(l)),
        `Makefile lost the definition matching ${re}`,
      ).toBe(true);
    }
  });

  it('self-test: the scan flags a bare call, ignores comments, and accepts the pinned definitions', () => {
    const synthetic = [
      '# kubectl in a comment is fine, so is helm',
      'KUBECTL := kubectl --context $(KUBE_CONTEXT)',
      'a:',
      '\t# kubectl in an indented recipe comment is fine',
      '\t$(KUBECTL) get pods',
      '\tkubectl get pods',
      '\t@if helm list; then true; fi',
      'KUBECTL := kubectl',
    ].join('\n');
    expect(bareToolLines(synthetic)).toEqual([
      'Makefile:6: kubectl get pods',
      'Makefile:7: @if helm list; then true; fi',
      'Makefile:8: KUBECTL := kubectl',
    ]);
  });
});

// ─── 2. BEHAVIOUR: run the targets against recording stand-ins + a throwaway kubeconfig ──

let sandbox;
let shimDir;
let kubeconfigWithKind;
let kubeconfigWithoutKind;

// A stand-in for the CLI the Makefile shells out to. It records its own name and argv
// (tab-separated, one line per call) and pretends to succeed. `kubectl config
// get-contexts` answers from FAKE_KUBE_CONTEXTS; `kubectl get` answers `{}` so the
// Makefile's `jq -e` probes read "no dev mount present".
const SHIM = `#!/usr/bin/env bash
name=$(basename "$0")
{ printf '%s' "$name"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$SHIM_LOG"
case "$name:$*" in
  kubectl:*"config get-contexts"*) printf '%s\\n' "$FAKE_KUBE_CONTEXTS" ;;
  kubectl:*" get "*) echo '{}' ;;
esac
exit 0
`;

function kubeconfig(contexts, current) {
  // Only server anywhere in it is a dead local port: a stand-in that failed to intercept
  // a call would still not reach a real cluster.
  return [
    'apiVersion: v1',
    'kind: Config',
    `current-context: ${current}`,
    'clusters:',
    '- name: dead-local-port',
    '  cluster: {server: "https://127.0.0.1:1"}',
    'users:',
    '- name: nobody',
    '  user: {token: not-a-real-token}',
    'contexts:',
    ...contexts.flatMap((c) => [`- name: ${c}`, '  context: {cluster: dead-local-port, user: nobody}']),
    '',
  ].join('\n');
}

beforeAll(() => {
  const jq = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  if (jq.status !== 0) throw new Error('jq is required on PATH: the Makefile itself uses it.');

  sandbox = mkdtempSync(join(tmpdir(), 'kind-pin-'));
  shimDir = join(sandbox, 'bin');
  spawnSync('mkdir', ['-p', shimDir]);
  for (const tool of ['kubectl', 'helm', 'docker', 'kind', 'pnpm']) {
    const p = join(shimDir, tool);
    writeFileSync(p, SHIM);
    chmodSync(p, 0o755);
  }
  // The DEFAULT context in both files is the fake prod one: that is the whole scenario.
  kubeconfigWithKind = join(sandbox, 'with-kind.kubeconfig');
  writeFileSync(kubeconfigWithKind, kubeconfig([FAKE_PROD_CONTEXT, KIND_CONTEXT], FAKE_PROD_CONTEXT));
  kubeconfigWithoutKind = join(sandbox, 'without-kind.kubeconfig');
  writeFileSync(kubeconfigWithoutKind, kubeconfig([FAKE_PROD_CONTEXT], FAKE_PROD_CONTEXT));
  writeFileSync(join(sandbox, 'gke-values.local.yaml'), 'image:\n  repository: example.invalid/ax-next/agent\n');
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/** Run `make <args>` in the repo root; returns the exit status, the output, and every recorded CLI call. */
function runMake(args, { withKind }) {
  const log = join(sandbox, `calls-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, '');
  const env = {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH}`,
    KUBECONFIG: withKind ? kubeconfigWithKind : kubeconfigWithoutKind,
    HOME: sandbox, // never read ~/.kube/config
    SHIM_LOG: log,
    FAKE_KUBE_CONTEXTS: withKind ? `${FAKE_PROD_CONTEXT}\n${KIND_CONTEXT}` : FAKE_PROD_CONTEXT,
  };
  delete env.GKE_CONTEXT; // a caller's exported value must not leak into a case that sets none
  const r = spawnSync('make', ['--no-print-directory', ...args], { cwd: REPO_ROOT, env, encoding: 'utf8' });
  const calls = readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [tool, ...argv] = l.split('\t');
      return { tool, argv };
    });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, calls };
}

const pinFlag = { kubectl: '--context', helm: '--kube-context' };
const isCluster = (c) => c.tool === 'kubectl' || c.tool === 'helm';
const isPinnedTo = (c, ctx) => c.argv[0] === pinFlag[c.tool] && c.argv[1] === ctx;
const unpinned = (calls, ctx) => calls.filter(isCluster).filter((c) => !isPinnedTo(c, ctx));
const describeCall = (c) => `${c.tool} ${c.argv.join(' ')}`;

// Each kind target and a kubectl verb it must reach — so a target that quietly stopped
// touching the cluster cannot pass this by making zero calls.
const KIND_TARGETS = [
  ['dev-fast', ['patch', 'rollout']],
  ['image', ['rollout']],
  ['dev-mount-up', ['patch']],
  ['dev-mount-down', ['get']],
  ['rollout', ['rollout']],
  ['reset-bootstrap', ['exec']],
  ['dev-kind-memory-nfs', ['apply', 'rollout']],
];

describe('kind targets act on kind even when the default context is something else', () => {
  it.each(KIND_TARGETS)('make %s: every kubectl/helm call names %s', (target, verbs) => {
    const { status, output, calls } = runMake([target], { withKind: true });
    expect(status, output).toBe(0);
    expect(unpinned(calls, KIND_CONTEXT).map(describeCall)).toEqual([]);
    const seen = calls.filter(isCluster).flatMap((c) => c.argv);
    for (const v of verbs) expect(seen, `${target} never ran a kubectl "${v}"`).toContain(v);
  });

  it.each(KIND_TARGETS)('make %s: refuses, doing no work, when the kind context is missing', (target) => {
    const { status, output, calls } = runMake([target], { withKind: false });
    expect(status).not.toBe(0);
    expect(output).toContain('REFUSING');
    // The only thing allowed to run is the guard's own read of the context list: no
    // `docker build`, no `kind load`, no rollout — the refusal comes BEFORE the slow work.
    expect(calls.filter((c) => !(c.tool === 'kubectl' && c.argv.includes('get-contexts'))).map(describeCall)).toEqual([]);
  });
});

describe('gke-deploy names its cluster explicitly and never follows the default context', () => {
  const gkeArgs = (ctx) => [
    'gke-deploy',
    `GKE_LOCAL_VALUES=${join(sandbox, 'gke-values.local.yaml')}`,
    'GKE_IMAGE_REPO=example.invalid/ax-next/agent',
    'GKE_TAG=test',
    ...(ctx ? [`GKE_CONTEXT=${ctx}`] : []),
  ];

  it('refuses when no GKE_CONTEXT is given, without running anything', () => {
    const { status, output, calls } = runMake(gkeArgs(null), { withKind: true });
    expect(status).not.toBe(0);
    expect(output).toContain('REFUSING');
    expect(calls.map(describeCall)).toEqual([]);
  });

  it('refuses a kind context, without building or deploying', () => {
    const { status, output, calls } = runMake(gkeArgs(KIND_CONTEXT), { withKind: true });
    expect(status).not.toBe(0);
    expect(output).toContain('REFUSING');
    expect(calls.filter((c) => c.tool !== 'kubectl').map(describeCall)).toEqual([]);
  });

  it('refuses a context the kubeconfig does not have, without building or deploying', () => {
    const { status, output, calls } = runMake(gkeArgs('gke_example-project_us-central1-a_not-in-kubeconfig'), {
      withKind: true,
    });
    expect(status).not.toBe(0);
    expect(output).toContain('REFUSING');
    expect(calls.filter((c) => c.tool !== 'kubectl').map(describeCall)).toEqual([]);
  });

  it('with a context given, every kubectl/helm call names exactly that context', () => {
    const { status, output, calls } = runMake(gkeArgs(FAKE_PROD_CONTEXT), { withKind: true });
    expect(status, output).toBe(0);
    expect(unpinned(calls, FAKE_PROD_CONTEXT).map(describeCall)).toEqual([]);
    const seen = calls.filter(isCluster).flatMap((c) => c.argv);
    expect(seen).toContain('upgrade');
    expect(seen).toContain('rollout');
    expect(calls.some((c) => c.tool === 'docker' && c.argv.includes('buildx'))).toBe(true);
  });
});

// ─── 3. DOCS: every snippet in the kind-facing docs is pasteable as-is ───────────────

// Files whose commands are meant for the local kind cluster. `deploy/GKE.md` and
// `deploy/README.md` are deliberately NOT here: they are for real clusters / any cluster,
// where the operator chooses the context and a fixed kind name would be wrong.
const DOC_ROOTS = [
  '.claude/skills/k8s-acceptance-loop',
  '.claude/skills/chat-qa-sweep',
  'deploy/kind',
  'deploy/MANUAL-ACCEPTANCE.md',
];

// Subcommands that talk to a cluster. `helm template` / `lint` / `dependency` /
// `repo` are offline and need no context.
const HELM_CLUSTER_VERBS = 'install|upgrade|uninstall|delete|list|ls|status|get|history|rollback|test';

const KUBECTL_BARE = new RegExp(`\\bkubectl\\b(?!\\s+--context\\s+${KIND_CONTEXT}\\b)`, 'g');
// A cluster-facing helm subcommand with no pin between `helm` and the verb. (A pinned
// command has the flag in that gap, so it does not match.)
const HELM_BARE = new RegExp(`\\bhelm\\s+(?:${HELM_CLUSTER_VERBS})\\b`, 'g');

/** Unpinned kubectl/helm commands in a markdown file: fenced snippets and inline command spans. */
function unpinnedInMarkdown(text, file) {
  const found = [];
  let fence = null;
  text.split('\n').forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[1] : fence === fenceMatch[1] ? null : fence;
      return;
    }
    if (fence !== null) {
      if (/^\s*#/.test(line)) return; // a shell comment inside a snippet
      if (line.match(KUBECTL_BARE) || line.match(HELM_BARE)) found.push(`${at}: ${line.trim()}`);
      return;
    }
    // Prose: only inline `code spans` count, and only the ones that are a command you could
    // paste. "`kubectl`" is a noun and "`kubectl logs`" names a verb; both need a resource or
    // flag after them (three or more words) before they are something to run.
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      const code = span[1];
      const runnable = (m) => code.slice(m.index).trim().split(/\s+/).length >= 3;
      if ([...code.matchAll(KUBECTL_BARE)].some(runnable) || [...code.matchAll(HELM_BARE)].some(runnable)) {
        found.push(`${at}: \`${code}\``);
      }
    }
  });
  return found;
}

function markdownFiles(root) {
  const abs = join(REPO_ROOT, root);
  if (statSync(abs).isFile()) return [root];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = join(root, e.name);
    if (e.isDirectory()) return markdownFiles(rel);
    return e.name.endsWith('.md') ? [rel] : [];
  });
}

describe('kind-facing docs: every kubectl/helm command carries the pin', () => {
  const files = DOC_ROOTS.flatMap(markdownFiles);

  it('covers the docs it claims to cover', () => {
    expect(files).toContain('.claude/skills/k8s-acceptance-loop/SKILL.md');
    expect(files).toContain('deploy/MANUAL-ACCEPTANCE.md');
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it.each(files)('%s has no unpinned command', (file) => {
    expect(unpinnedInMarkdown(readFileSync(join(REPO_ROOT, file), 'utf8'), file)).toEqual([]);
  });

  it('self-test: flags unpinned snippets and command spans; accepts pinned, offline and prose forms', () => {
    const md = [
      'Prose that mentions `kubectl` alone, `kubectl logs` as a verb, and `helm template x y` (offline) is fine.',
      '',
      '```bash',
      '# kubectl in a comment is fine',
      `kubectl --context ${KIND_CONTEXT} -n ax-next get pods`,
      `helm --kube-context ${KIND_CONTEXT} upgrade --install x y`,
      'helm template x y',
      'kubectl -n ax-next get pods',
      'helm upgrade --install x y',
      `kubectl --context some-other-cluster get pods`,
      'echo x | xargs kubectl delete pod',
      '```',
      '',
      'Then `kubectl exec` into the pod, or run `helm uninstall ax-next` or `kubectl get pods -n x`.',
      `Pinned: \`kubectl --context ${KIND_CONTEXT} get pods\`, \`helm --kube-context ${KIND_CONTEXT} list\`.`,
    ].join('\n');
    expect(unpinnedInMarkdown(md, 'x.md')).toEqual([
      'x.md:8: kubectl -n ax-next get pods',
      'x.md:9: helm upgrade --install x y',
      'x.md:10: kubectl --context some-other-cluster get pods',
      'x.md:11: echo x | xargs kubectl delete pod',
      'x.md:14: `helm uninstall ax-next`',
      'x.md:14: `kubectl get pods -n x`',
    ]);
  });
});
