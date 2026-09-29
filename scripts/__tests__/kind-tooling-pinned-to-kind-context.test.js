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
  existsSync,
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
  // The GKE pair names the context through the ENVIRONMENT ("$$GKE_CONTEXT" is a shell variable
  // once make has unescaped it), never by pasting the value into shell text, so an odd value
  // cannot be re-parsed; and it HARD-STOPS at expansion when no context was given, so a new
  // target that forgets `gke-guard` cannot fall through to `--context ''` (= the default).
  /^GKE_REQUIRE\s*=\s*\$\(if \$\(GKE_CONTEXT\),,\$\(error REFUSING: [^()]*\)\)\s*$/,
  /^GKE_KUBECTL\s*=\s*\$\(GKE_REQUIRE\) kubectl --context "\$\$GKE_CONTEXT"\s*$/,
  /^GKE_HELM\s*=\s*\$\(GKE_REQUIRE\) helm --kube-context "\$\$GKE_CONTEXT"\s*$/,
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

/**
 * Every target whose recipe uses the pinned variables, with the prerequisites it declares.
 * A rule line is `name: prereqs` at column 0 (an assignment is `name := …`, excluded by the
 * `(?!=)`); a recipe line starts with a tab.
 */
function clusterTargets(makefileText) {
  const found = new Map();
  let current = null;
  for (const line of makefileText.split('\n')) {
    const rule = /^([A-Za-z0-9_.-]+)\s*:(?!=)\s*(.*)$/.exec(line);
    if (rule && !line.startsWith('\t')) {
      current = rule[1];
      const prereqs = rule[2].split('#')[0].trim().split(/\s+/).filter(Boolean);
      found.set(current, { kind: false, gke: false, prereqs });
      continue;
    }
    if (current === null || !line.startsWith('\t') || /^\s*#/.test(line)) continue;
    const t = found.get(current);
    if (/\$\((KUBECTL|HELM)\)/.test(line)) t.kind = true;
    if (/\$\((GKE_KUBECTL|GKE_HELM)\)/.test(line)) t.gke = true;
  }
  return found;
}

/** Cluster-touching targets (other than the guards themselves) that do not list their guard. */
function unguardedClusterTargets(makefileText) {
  return [...clusterTargets(makefileText)]
    .filter(([name, t]) => (t.kind || t.gke) && name !== 'kube-guard' && name !== 'gke-guard')
    .filter(([, t]) => !t.prereqs.includes(t.gke ? 'gke-guard' : 'kube-guard'))
    .map(([name]) => name);
}

describe('Makefile: every cluster-touching target lists its guard, and the behavioural tests cover it', () => {
  it('has no cluster-touching target without kube-guard / gke-guard as a prerequisite', () => {
    const text = readFileSync(MAKEFILE, 'utf8');
    expect(unguardedClusterTargets(text)).toEqual([]);
    // `image` and `dev-fast` reach the cluster only through `$(MAKE)` sub-calls, so the scan above
    // cannot see them; but they do slow work (docker build, kind load) FIRST, which is exactly what
    // the guard exists to precede.
    const targets = clusterTargets(text);
    for (const name of ['image', 'dev-fast']) {
      expect(targets.get(name)?.prereqs, `${name} lost its kube-guard prerequisite`).toContain('kube-guard');
    }
  });

  it('exercises exactly the targets the Makefile has (a new one must be added to the lists below)', () => {
    const real = [...clusterTargets(readFileSync(MAKEFILE, 'utf8'))]
      .filter(([name, t]) => (t.kind || t.gke) && name !== 'kube-guard' && name !== 'gke-guard')
      .map(([name]) => name)
      .sort();
    // dev-fast / image reach the cluster only through their `$(MAKE)` sub-calls, so they do not
    // use the variables themselves; they are in KIND_TARGETS anyway and each names kube-guard.
    const exercised = [...KIND_TARGETS.map(([name]) => name), 'gke-deploy']
      .filter((name) => !['dev-fast', 'image'].includes(name))
      .sort();
    expect(real).toEqual(exercised);
  });

  it('self-test: flags a target that uses a pinned variable without its guard', () => {
    const synthetic = [
      'KUBECTL := kubectl --context x',
      'a: kube-guard',
      '\t$(KUBECTL) get pods',
      'nuke:',
      '\t$(GKE_KUBECTL) delete deploy y',
      'b: gke-guard   # trailing comment',
      '\t$(GKE_HELM) list',
      'c: gke-guard',
      '\t$(KUBECTL) get pods',
      'PATCH_ADD := [{"a":"b"}]',
    ].join('\n');
    expect(unguardedClusterTargets(synthetic)).toEqual(['nuke', 'c']);
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
function runMake(args, { withKind, contexts }) {
  const log = join(sandbox, `calls-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, '');
  const env = {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH}`,
    KUBECONFIG: withKind ? kubeconfigWithKind : kubeconfigWithoutKind,
    HOME: sandbox, // never read ~/.kube/config
    SHIM_LOG: log,
    // What the stand-in kubectl answers to `config get-contexts`: the default is "the fake prod
    // one, plus kind when `withKind`"; `contexts` overrides it for a case that needs an odd list.
    FAKE_KUBE_CONTEXTS: contexts
      ? contexts.join('\n')
      : withKind
        ? `${FAKE_PROD_CONTEXT}\n${KIND_CONTEXT}`
        : FAKE_PROD_CONTEXT,
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

  it('refuses when the kubeconfig has only a LOOK-ALIKE context: the match is exact, not a substring', () => {
    // A guard loosened from `grep -Fx` to `grep -q` would pass on `kind-ax-next-dev-old`.
    const { status, output, calls } = runMake(['rollout'], {
      withKind: true,
      contexts: [FAKE_PROD_CONTEXT, `${KIND_CONTEXT}-old`, `my-${KIND_CONTEXT}`],
    });
    expect(status).not.toBe(0);
    expect(output).toContain('REFUSING');
    expect(calls.filter((c) => !(c.tool === 'kubectl' && c.argv.includes('get-contexts'))).map(describeCall)).toEqual([]);
  });

  it('under make -j, dev-fast still refuses before it builds anything', () => {
    // `dev-fast: kube-guard build-spa` would otherwise start the (slow, needless) SPA build
    // beside the guard; `.NOTPARALLEL` makes "the guard goes first" a guarantee, not a habit.
    const { status, output, calls } = runMake(['-j4', 'dev-fast'], { withKind: false });
    expect(status).not.toBe(0);
    expect(output).toContain('REFUSING');
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

  it('refuses when the kubeconfig has only a LOOK-ALIKE of the requested context (exact match, not substring)', () => {
    const { status, output, calls } = runMake(gkeArgs(FAKE_PROD_CONTEXT), {
      withKind: true,
      contexts: [`${FAKE_PROD_CONTEXT}-old`, `my-${FAKE_PROD_CONTEXT}`],
    });
    expect(status).not.toBe(0);
    expect(output).toContain('REFUSING');
    expect(calls.filter((c) => c.tool !== 'kubectl').map(describeCall)).toEqual([]);
  });

  it('a HOSTILE context value is never re-parsed by a shell', () => {
    // The value reaches the guard through the environment ("$GKE_CONTEXT"), not pasted into shell
    // text, so a quote in it cannot break out of a string and run a command.
    const marker = join(sandbox, 'pwned');
    const { status, output } = runMake(gkeArgs(`x'; touch ${marker}; '`), { withKind: true });
    expect(status).not.toBe(0);
    expect(output).toContain('REFUSING');
    expect(existsSync(marker), 'the hostile value ran a command').toBe(false);
  });

  it('an odd but LEGAL context name (a space, a quote) reaches kubectl and helm as ONE argument', () => {
    const odd = "my cluster's context";
    const { status, output, calls } = runMake(gkeArgs(odd), { withKind: true, contexts: [FAKE_PROD_CONTEXT, odd] });
    expect(status, output).toBe(0);
    expect(unpinned(calls, odd).map(describeCall)).toEqual([]);
  });

  it('a NEW target that uses $(GKE_KUBECTL) and forgot gke-guard hard-stops with no context, instead of falling back to the default', () => {
    // `--context ''` (or a swallowed next word) would quietly mean "the default context": the
    // exact failure this card removes. The variable itself refuses when nothing was named.
    const wrapper = join(sandbox, 'wrapper.mk');
    writeFileSync(wrapper, `include ${MAKEFILE}\nnuke:\n\t$(GKE_KUBECTL) -n x delete deploy y\n`);
    const { status, output, calls } = runMake(['-f', wrapper, 'nuke'], { withKind: true });
    expect(status).not.toBe(0);
    expect(output).toContain('REFUSING');
    expect(calls.map(describeCall)).toEqual([]);
  });
});

// ─── 3. DOCS: every snippet in the kind-facing docs is pasteable as-is ───────────────

// Files whose commands are meant for the local kind cluster. A string is a file, or a directory
// scanned whole. `deploy/GKE.md` is NOT here: it is a real-cluster runbook whose own Step 0 sets
// the context. `deploy/README.md` is here for its "Deploy to a local kind cluster" SECTION only
// (that is where the incident's `rollout restart` was sitting bare); the rest of that file
// interleaves kind and real-cluster runbooks, where a fixed kind name would be wrong, so the
// destructive ones tell the reader to check their context first instead.
const DOC_ROOTS = [
  '.claude/skills/k8s-acceptance-loop',
  '.claude/skills/chat-qa-sweep',
  'deploy/kind',
  'deploy/MANUAL-ACCEPTANCE.md',
  { file: 'deploy/README.md', section: '## Deploy to a local kind cluster' },
];

// Subcommands that talk to a cluster. `helm template` / `lint` / `dependency` /
// `repo` are offline and need no context.
const HELM_CLUSTER_VERBS = 'install|upgrade|uninstall|delete|list|ls|status|get|history|rollback|test';
const KUBECTL_VERBS =
  'get|describe|logs|exec|delete|apply|patch|rollout|scale|port-forward|create|wait|run|edit|top|label|annotate|cp|config|set|expose|drain|cordon|uncordon|taint|auth|explain|diff|replace|attach|proxy|debug|events';

// helm flags that take a value as the NEXT word, so `helm -n ax-next uninstall x` is read as
// verb `uninstall` and not verb `ax-next`.
const HELM_VALUE_FLAGS = new Set([
  '-n', '--namespace', '--kubeconfig', '--kube-apiserver', '--kube-as-user', '--kube-as-group',
  '--kube-token', '--kube-ca-file', '-f', '--values', '--set', '--set-string', '--set-file',
  '--version', '--repo', '--timeout',
]);

const KUBECTL_BARE = new RegExp(`\\bkubectl\\b(?!\\s+--context\\s+${KIND_CONTEXT}\\b)`, 'g');

/**
 * Every `helm` in `text` whose subcommand talks to a cluster, and whether it names the kind
 * context. The subcommand is the first word that is not a flag (or a flag's value), so a pin or
 * any other flag may sit between `helm` and the verb, in any order.
 */
function helmClusterCommands(text) {
  const verbs = new RegExp(`^(?:${HELM_CLUSTER_VERBS})$`);
  const found = [];
  for (const m of text.matchAll(/\bhelm\b/g)) {
    const toks = text.slice(m.index + 4).split(/\s+/).filter(Boolean);
    let pinned = null;
    let i = 0;
    for (; i < toks.length && toks[i].startsWith('-'); i++) {
      if (toks[i] === '--kube-context') pinned = toks[++i] ?? null;
      else if (toks[i].startsWith('--kube-context=')) pinned = toks[i].slice('--kube-context='.length);
      else if (HELM_VALUE_FLAGS.has(toks[i])) i++;
    }
    const verb = (toks[i] ?? '').replace(/[;|&)`'".,]+$/, '');
    if (verbs.test(verb)) found.push({ index: m.index, pinned: pinned === KIND_CONTEXT });
  }
  return found;
}

// A `#` line inside a snippet is usually prose. But `#   kubectl -n ax-next get secret …` is a
// COMMAND the reader is told to run, parked behind a comment marker; it must carry the pin too.
const COMMENTED_OUT_COMMAND = new RegExp(
  `^\\s*#+\\s*(?:kubectl|helm)\\s+(?:-|(?:${KUBECTL_VERBS}|${HELM_CLUSTER_VERBS})\\b)`,
);

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
      const comment = /^\s*#/.test(line);
      if (comment && !COMMENTED_OUT_COMMAND.test(line)) return; // prose, not a command
      const code = comment ? line.replace(/^\s*#+\s*/, '') : line;
      if (code.match(KUBECTL_BARE) || helmClusterCommands(code).some((c) => !c.pinned)) {
        found.push(`${at}: ${line.trim()}`);
      }
      return;
    }
    // Prose: only inline `code spans` count, and only the ones that are a command you could
    // paste. "`kubectl`" is a noun and "`kubectl logs`" names a verb; both need a resource or
    // flag after them (three or more words) before they are something to run.
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      const code = span[1];
      const runnable = (index) => code.slice(index).trim().split(/\s+/).length >= 3;
      const kubectl = [...code.matchAll(KUBECTL_BARE)].some((m) => runnable(m.index));
      const helm = helmClusterCommands(code).some((c) => !c.pinned && runnable(c.index));
      if (kubectl || helm) found.push(`${at}: \`${code}\``);
    }
  });
  return found;
}

/** Blank every line outside `heading` … the next `## ` heading, keeping the line numbers. */
function onlySection(text, heading) {
  let inside = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^## /.test(line)) inside = line.trim() === heading;
      return inside ? line : '';
    })
    .join('\n');
}

function docEntries(root) {
  if (typeof root !== 'string') return [{ label: `${root.file} (${root.section})`, ...root }];
  const abs = join(REPO_ROOT, root);
  if (statSync(abs).isFile()) return [{ label: root, file: root }];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = join(root, e.name);
    if (e.isDirectory()) return docEntries(rel);
    return e.name.endsWith('.md') ? [{ label: rel, file: rel }] : [];
  });
}

describe('kind-facing docs: every kubectl/helm command carries the pin', () => {
  const entries = DOC_ROOTS.flatMap(docEntries);

  it('covers the docs it claims to cover', () => {
    const labels = entries.map((e) => e.label);
    expect(labels).toContain('.claude/skills/k8s-acceptance-loop/SKILL.md');
    expect(labels).toContain('deploy/MANUAL-ACCEPTANCE.md');
    expect(labels).toContain('deploy/README.md (## Deploy to a local kind cluster)');
    expect(entries.length).toBeGreaterThanOrEqual(5);
  });

  it.each(entries.map((e) => [e.label, e]))('%s has no unpinned command', (_label, entry) => {
    const whole = readFileSync(join(REPO_ROOT, entry.file), 'utf8');
    const text = entry.section ? onlySection(whole, entry.section) : whole;
    // A section that was renamed would blank to nothing and pass; insist the scan saw commands.
    if (entry.section) expect(text, `${entry.file} has no "${entry.section}" section any more`).toMatch(/\bkubectl\b/);
    expect(unpinnedInMarkdown(text, entry.file)).toEqual([]);
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
      '',
      '```bash',
      '#   kubectl -n ax-next get secret -o yaml | grep -i anthropic',
      `#   kubectl --context ${KIND_CONTEXT} -n ax-next get secret`,
      '# helm upgrade y',
      'helm -n ax-next uninstall ax-next',
      `helm --debug --kube-context ${KIND_CONTEXT} upgrade x`,
      `helm --kube-context=${KIND_CONTEXT} -n ax-next status x`,
      'helm --namespace x list',
      'helm --kube-context some-other-cluster upgrade x',
      'helm -f values.yaml template x .',
      '```',
    ].join('\n');
    expect(unpinnedInMarkdown(md, 'x.md')).toEqual([
      'x.md:8: kubectl -n ax-next get pods',
      'x.md:9: helm upgrade --install x y',
      'x.md:10: kubectl --context some-other-cluster get pods',
      'x.md:11: echo x | xargs kubectl delete pod',
      'x.md:14: `helm uninstall ax-next`',
      'x.md:14: `kubectl get pods -n x`',
      'x.md:18: #   kubectl -n ax-next get secret -o yaml | grep -i anthropic',
      'x.md:20: # helm upgrade y',
      'x.md:21: helm -n ax-next uninstall ax-next',
      'x.md:24: helm --namespace x list',
      'x.md:25: helm --kube-context some-other-cluster upgrade x',
    ]);
  });

  it('self-test: onlySection keeps line numbers and drops everything outside the section', () => {
    const md = ['# top', 'kubectl a', '## Keep', 'kubectl b', '### sub', 'kubectl c', '## Other', 'kubectl d'].join('\n');
    expect(onlySection(md, '## Keep').split('\n')).toEqual(['', '', '## Keep', 'kubectl b', '### sub', 'kubectl c', '', '']);
  });
});

// ─── 4. delete_user.sh: the most destructive kind helper pins its context too ─────────

/** Lines of a shell script that run kubectl/helm without the script's own `--context "$ctx"` pin. */
function bareShellTool(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    if (/\b(kubectl|helm)\b(?!\s+(?:--context|--kube-context)\s+"\$ctx")/.test(line)) {
      out.push(`${i + 1}: ${line.trim()}`);
    }
  });
  return out;
}

describe('delete_user.sh', () => {
  const text = readFileSync(join(REPO_ROOT, 'delete_user.sh'), 'utf8');

  it('sets its context to kind and gives every kubectl the pin', () => {
    expect(text).toMatch(/\bctx=kind-ax-next-dev\b/);
    expect(bareShellTool(text)).toEqual([]);
  });

  it('self-test: flags a bare call, accepts the pinned forms, ignores comments', () => {
    const sh = [
      '# kubectl in a comment is fine',
      'local ctx=kind-ax-next-dev',
      'kubectl --context "$ctx" -n x get pods',
      'local psql=(kubectl --context "$ctx" exec -i p -- psql)',
      'kubectl -n x delete pod p',
      'x=$(kubectl --context other get pods)',
    ].join('\n');
    expect(bareShellTool(sh)).toEqual(['5: kubectl -n x delete pod p', '6: x=$(kubectl --context other get pods)']);
  });
});
