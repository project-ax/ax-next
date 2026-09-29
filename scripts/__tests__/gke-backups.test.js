// Guard: deploy/gke/backups.sh does what the runbook says, and only that.
//
// WHY THIS EXISTS. The script writes to production: it creates a snapshot
// schedule, attaches it to the disks that hold users' files and memory, turns on
// Cloud SQL deletion protection, and (for the drill) creates and deletes disks.
// Nobody can rehearse that against production before it merges, so these tests
// run the REAL script against stub `gcloud` and `kubectl` executables
// (scripts/__tests__/fixtures/gke-backups/) that record every call and answer
// from files. What they pin down, in order of how much it would hurt to get wrong:
//
//   - --dry-run makes ZERO writes (asserted on the recorded calls, not on prose).
//   - A second run makes zero writes too (idempotent), and a half-done state is
//     finished, not restarted.
//   - It never writes to a project other than the one the disks are in, and
//     refuses when --project disagrees, when the PV is not a GKE disk (a kind
//     cluster) or is a regional disk.
//   - The drill never attaches the PRODUCTION disk to anything; it restores to
//     scratch disks and cleans up after a pass, a fail and a timeout.
//   - drill-cleanup only deletes things that are labelled AND named as drill
//     scratch, even when other disks carry a look-alike label.
//
// Nothing here can reach Google Cloud or a cluster: PATH puts the stubs first,
// KUBECONFIG points nowhere and CLOUDSDK_CONFIG is an empty directory, so even a
// call that dodged the stubs would fail rather than land.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(repoRoot, 'deploy/gke/backups.sh');
const FIXTURES = join(repoRoot, 'scripts/__tests__/fixtures/gke-backups');
const yaml = createRequire(join(repoRoot, 'deploy/charts/ax-next/package.json'))('js-yaml');

const PROJECT = 'example-proj-1';
const CTX = `gke_${PROJECT}_us-central1-a_example-cluster`;
const WS_DISK = 'pvc-ws-1111';
const FACTS_DISK = 'pvc-facts-2222';

// macOS ships bash 3.2 as /bin/bash and Homebrew's bash comes first on PATH, so
// run the suite under both when they differ: the script promises to work on the
// old one.
const SHELLS = [
  ...new Set(
    ['bash', '/bin/bash']
      .map((b) => {
        const r = spawnSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf-8' });
        return r.status === 0 ? realpathSync(r.stdout.trim()) : null;
      })
      .filter(Boolean),
  ),
];

let binDir;
let sandbox;
let stateDir;
let logFile;
let podLogs;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'gke-backups-bin-'));
  for (const f of ['gcloud', 'kubectl']) {
    copyFileSync(join(FIXTURES, f), join(binDir, f));
    chmodSync(join(binDir, f), 0o755);
  }
});
afterAll(() => rmSync(binDir, { recursive: true, force: true }));

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'gke-backups-'));
  stateDir = join(sandbox, 'state');
  mkdirSync(stateDir);
  mkdirSync(join(sandbox, 'gcloud-config'));
  logFile = join(sandbox, 'calls.log');
  writeFileSync(logFile, '');
  podLogs = join(sandbox, 'pod.log');
  writeFileSync(podLogs, 'DRILL-RESULT: PASS\n');
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

// ── seeding the pretend cloud ────────────────────────────────────────────────
const seed = {
  policy: (region = 'us-central1', body = '14\t09:00\n') =>
    writeFileSync(join(stateDir, `policy-${region}`), body),
  attach: (disk, value) =>
    writeFileSync(
      join(stateDir, `attached-${disk}`),
      value ??
        `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/us-central1/resourcePolicies/ax-next-daily`,
    ),
  sqlProtected: () => writeFileSync(join(stateDir, 'sql-dp'), ''),
  fresh: () => writeFileSync(join(stateDir, 'fresh'), ''),
  snapshots: (lines) => writeFileSync(join(stateDir, 'snapshots'), `${lines.join('\n')}\n`),
  users: (disk, v) => writeFileSync(join(stateDir, `users-${disk}`), v),
  scratch: (name, zone, runId) => writeFileSync(join(stateDir, `scratch-${name}`), `${zone}\t${runId}\n`),
  decoy: (line) => writeFileSync(join(stateDir, 'decoy-disk'), `${line}\n`),
};

/** Two disks' worth of snapshots, plus a look-alike whose name CONTAINS the workspace disk's. */
function seedSnapshots() {
  seed.snapshots([
    `snap-decoy-newest\t2026-09-29T09:00:03Z\t${WS_DISK}-old`,
    `snap-ws-latest\t2026-09-29T09:00:09Z\t${WS_DISK}`,
    `snap-facts-latest\t2026-09-29T09:00:11Z\t${FACTS_DISK}`,
    `snap-ws-older\t2026-09-28T09:00:08Z\t${WS_DISK}`,
  ]);
}

function run(shell, args, env = {}) {
  const r = spawnSync(shell, [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: {
      PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: sandbox,
      KUBECONFIG: join(sandbox, 'no-such-kubeconfig'),
      CLOUDSDK_CONFIG: join(sandbox, 'gcloud-config'),
      STUB_LOG: logFile,
      STUB_STATE: stateDir,
      STUB_POD_LOGS: podLogs,
      AX_BACKUPS_POLL_SECONDS: '0',
      ...env,
    },
  });
  const log = readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    out: `${r.stdout}${r.stderr}`,
    log,
    writes: log.filter((l) => WRITE_RE.test(l)),
    applied: readdirSync(stateDir)
      .filter((f) => f.startsWith('applied-'))
      .sort()
      .map((f) => yaml.load(readFileSync(join(stateDir, f), 'utf-8'))),
  };
}

// A call that changes something. `kubectl apply|delete`, and the gcloud
// subcommands that create, attach, snapshot, patch or delete.
const WRITE_RE =
  /^(gcloud .*(resource-policies create|add-resource-policies|disks create|disks delete|disks snapshot|sql instances patch)|kubectl .* (apply|delete) )/;

function stateFiles() {
  return readdirSync(stateDir).sort();
}

function expectNoUnhandled(r) {
  expect(r.log.filter((l) => /UNHANDLED|MISSING/.test(l))).toEqual([]);
}

/** Every gcloud call names the disks' project; every kubectl call names the context. */
function expectPinned(r) {
  for (const l of r.log) {
    if (l.startsWith('gcloud ') && !l.startsWith('gcloud config ')) {
      expect(l, l).toContain(`--project ${PROJECT}`);
    }
    if (l.startsWith('kubectl ') && !l.startsWith('kubectl config current-context')) {
      expect(l, l).toContain(`--context ${CTX}`);
    }
  }
}

describe.each(SHELLS)('deploy/gke/backups.sh under %s', (shell) => {
  // ── enable ─────────────────────────────────────────────────────────────────
  describe('enable', () => {
    it('--dry-run changes nothing: no write is made, and the plan names every one', () => {
      const r = run(shell, ['enable', '--dry-run']);
      expect(r.status).toBe(0);
      expect(r.writes).toEqual([]);
      expect(stateFiles()).toEqual([]);
      expectNoUnhandled(r);
      expectPinned(r);
      expect(r.out).toContain('DRY RUN');
      expect(r.out).toContain('resource-policies create snapshot-schedule ax-next-daily');
      expect(r.out).toContain(`add-resource-policies ${WS_DISK}`);
      expect(r.out).toContain(`add-resource-policies ${FACTS_DISK}`);
      expect(r.out).toContain('sql instances patch ax-next-db --deletion-protection');
      expect(r.out).toContain('Dry run finished: nothing was changed');
    });

    it('creates the schedule once, attaches it to BOTH disks, and protects Cloud SQL', () => {
      const r = run(shell, ['enable']);
      expect(r.status).toBe(0);
      expectNoUnhandled(r);
      expectPinned(r);
      expect(r.writes).toHaveLength(4);
      const [create, attachWs, attachFacts, patch] = r.writes;
      expect(create).toContain('resource-policies create snapshot-schedule ax-next-daily');
      expect(create).toContain('--region us-central1');
      expect(create).toContain('--daily-schedule');
      expect(create).toContain('--start-time 09:00');
      expect(create).toContain('--max-retention-days 14');
      // The safety net has to outlive the disk it protects.
      expect(create).toContain('--on-source-disk-delete keep-auto-snapshots');
      expect(attachWs).toContain(`add-resource-policies ${WS_DISK} --zone us-central1-a --resource-policies ax-next-daily`);
      expect(attachFacts).toContain(`add-resource-policies ${FACTS_DISK} --zone us-central1-a --resource-policies ax-next-daily`);
      expect(patch).toContain('sql instances patch ax-next-db --deletion-protection');
      expect(r.out).toContain('deletion protection : now ON');
    });

    it('finds the project, zone and disks from the PVCs: nothing about a deployment is in the script', () => {
      const r = run(shell, ['enable', '--dry-run'], { STUB_PROJECT: 'some-other-proj-9', STUB_ZONE: 'europe-west4-b' });
      expect(r.status).toBe(0);
      expect(r.out).toContain('gcloud project  : some-other-proj-9');
      expect(r.out).toContain('--region europe-west4');
      expect(r.out).toContain('--zone europe-west4-b');
      expect(r.log.filter((l) => l.startsWith('gcloud ') && !l.startsWith('gcloud config'))).not.toHaveLength(0);
      for (const l of r.log.filter((x) => x.startsWith('gcloud ') && !x.startsWith('gcloud config'))) {
        expect(l).toContain('--project some-other-proj-9');
      }
    });

    it('is idempotent: a second run makes no writes at all', () => {
      const first = run(shell, ['enable']);
      expect(first.status).toBe(0);
      writeFileSync(logFile, '');
      const second = run(shell, ['enable']);
      expect(second.status).toBe(0);
      expect(second.writes).toEqual([]);
      expectNoUnhandled(second);
      expect(second.out).toContain('already exists');
      expect(second.out).toContain(`workspace disk ${WS_DISK}: ax-next-daily already attached`);
      expect(second.out).toContain(`facts disk ${FACTS_DISK}: ax-next-daily already attached`);
      expect(second.out).toContain('deletion protection : ON');
    });

    it('finishes a half-done state instead of starting over', () => {
      seed.policy();
      seed.attach(WS_DISK);
      const r = run(shell, ['enable']);
      expect(r.status).toBe(0);
      expect(r.writes.map((w) => w.replace(/^gcloud --project \S+ /, ''))).toEqual([
        `compute disks add-resource-policies ${FACTS_DISK} --zone us-central1-a --resource-policies ax-next-daily --quiet`,
        'sql instances patch ax-next-db --deletion-protection --quiet',
      ]);
    });

    it('does not replace a snapshot schedule somebody else attached, and says so', () => {
      seed.policy();
      seed.attach(FACTS_DISK, 'https://www.googleapis.com/compute/v1/projects/p/regions/us-central1/resourcePolicies/their-own');
      const r = run(shell, ['enable']);
      expect(r.status).toBe(0);
      expect(r.writes.filter((w) => w.includes(`add-resource-policies ${FACTS_DISK}`))).toEqual([]);
      expect(r.out).toContain('already has a different resource policy');
      expect(r.out).toContain('their-own');
    });

    it('leaves an existing schedule alone and warns when its settings differ', () => {
      seed.policy('us-central1', '7\t03:00\n');
      const r = run(shell, ['enable']);
      expect(r.status).toBe(0);
      expect(r.writes.filter((w) => w.includes('resource-policies create'))).toEqual([]);
      expect(r.out).toContain('leaving it alone');
      expect(r.out).toContain('differs from what was asked for');
    });

    it('is not confused by the update notices gcloud prints on stderr, even on success', () => {
      const first = run(shell, ['enable'], { STUB_NOTICE: '1' });
      expect(first.status).toBe(0);
      writeFileSync(logFile, '');
      const second = run(shell, ['enable'], { STUB_NOTICE: '1' });
      expect(second.status).toBe(0);
      expect(second.writes).toEqual([]);
      expect(second.out).not.toContain('differs from what was asked for');
    });

    it('honours --schedule-name, --retention-days and --start-time', () => {
      const r = run(shell, ['enable', '--schedule-name', 'nightly', '--retention-days', '30', '--start-time', '03:00']);
      expect(r.status).toBe(0);
      const create = r.writes[0];
      expect(create).toContain('snapshot-schedule nightly');
      expect(create).toContain('--max-retention-days 30');
      expect(create).toContain('--start-time 03:00');
    });

    it('--snapshot-now takes one on-demand snapshot per disk, and warns they do not expire', () => {
      const r = run(shell, ['enable', '--snapshot-now']);
      expect(r.status).toBe(0);
      const snaps = r.writes.filter((w) => w.includes('disks snapshot'));
      expect(snaps).toHaveLength(2);
      expect(snaps[0]).toMatch(new RegExp(`disks snapshot ${WS_DISK} --zone us-central1-a --snapshot-names ax-next-workspace-manual-\\d{8}-\\d{6}`));
      expect(snaps[1]).toMatch(new RegExp(`disks snapshot ${FACTS_DISK} .*ax-next-facts-manual-`));
      expect(r.out).toContain('will not expire on their own');
    });

    it('fails, and says so honestly, when it cannot read the setting back after the patch', () => {
      // A blip on the read-back is not "still off": the write may well have worked.
      const r = run(shell, ['enable'], { STUB_SQL_DP_READ_FAILS_AFTER_PATCH: '1' });
      expect(r.status).toBe(1);
      expect(r.out).toContain('could not read the setting back to check');
      expect(r.out).not.toContain('still reads back as off');
    });

    it('fails loudly if Cloud SQL still reads as unprotected after the patch', () => {
      const r = run(shell, ['enable'], { STUB_SQL_PATCH_IS_NOOP: '1' });
      expect(r.status).toBe(1);
      expect(r.out).toContain('still reads back as off');
    });

    it('exits 1 and says how to fix it when Cloud SQL backups or point-in-time recovery are off', () => {
      seed.sqlProtected();
      const r = run(shell, ['enable'], { STUB_SQL_BACKUPS: 'False', STUB_SQL_PITR: '' });
      expect(r.status).toBe(1);
      expect(r.out).toContain('automated backups are OFF');
      expect(r.out).toContain('point-in-time recovery is OFF');
      // Reporting is all it does: it never edits backup settings itself.
      expect(r.writes.filter((w) => w.includes('sql instances patch'))).toEqual([]);
    });

    it('uses --context when given, and never asks kubectl for the current one', () => {
      const r = run(shell, ['enable', '--dry-run', '--context', 'my-explicit-ctx']);
      expect(r.status).toBe(0);
      expect(r.log.some((l) => l.startsWith('kubectl config current-context'))).toBe(false);
      for (const l of r.log.filter((x) => x.startsWith('kubectl '))) expect(l).toContain('--context my-explicit-ctx');
    });

    describe('refuses, before writing anything, when the target is not what it expects', () => {
      it('--project disagrees with where the disks live', () => {
        const r = run(shell, ['enable', '--project', 'not-the-right-project']);
        expect(r.status).toBe(2);
        expect(r.writes).toEqual([]);
        expect(r.out).toContain('--project not-the-right-project');
        expect(r.out).toContain(`project ${PROJECT}`);
      });

      it('--project agrees: proceeds', () => {
        const r = run(shell, ['enable', '--dry-run', '--project', PROJECT]);
        expect(r.status).toBe(0);
      });

      it('the volume is not a GKE disk (a kind cluster): touches gcloud not at all', () => {
        const r = run(shell, ['enable'], { STUB_DRIVER: 'rancher.io/local-path' });
        expect(r.status).toBe(2);
        expect(r.out).toContain('is not a GKE persistent disk');
        expect(r.log.filter((l) => l.startsWith('gcloud '))).toEqual([]);
        expect(r.writes).toEqual([]);
      });

      it('the disk is regional', () => {
        const r = run(shell, ['enable'], { STUB_REGIONAL: '1' });
        expect(r.status).toBe(2);
        expect(r.out).toContain('REGIONAL disk');
        expect(r.writes).toEqual([]);
      });

      it('the PVC does not exist, and the message points at --context', () => {
        const r = run(shell, ['enable'], { STUB_PVC_MISSING: '1' });
        expect(r.status).toBe(2);
        expect(r.out).toContain('cannot read PVC ax-next/ax-next-workspace');
        expect(r.out).toContain('--context');
        expect(r.writes).toEqual([]);
      });

      it.each([
        [['enable', '--retention-days', '0'], '--retention-days'],
        [['enable', '--retention-days', 'soon'], '--retention-days'],
        [['enable', '--start-time', '09:30'], 'on the hour'],
        [['enable', '--start-time', '9am'], 'on the hour'],
        [['enable', '--schedule-name', 'Bad Name'], 'valid Google Cloud resource name'],
        [['enable', '--namespace', 'a;b'], 'valid Kubernetes name'],
        [['enable', '--context'], 'needs a value'],
        [['enable', '--bogus'], 'unknown option'],
        [['frobnicate'], 'unknown command'],
        [[], 'Usage'],
      ])('bad arguments %j', (args, message) => {
        const r = run(shell, args);
        expect(r.status).toBe(2);
        expect(r.out).toContain(message);
        // Bad input is refused before anything is asked of the cluster or GCP.
        expect(r.log).toEqual([]);
      });
    });
  });

  // ── status ─────────────────────────────────────────────────────────────────
  describe('status', () => {
    function healthy() {
      seed.policy();
      seed.attach(WS_DISK);
      seed.attach(FACTS_DISK);
      seed.sqlProtected();
      seedSnapshots();
      seed.fresh();
    }

    it('reports healthy, and never writes', () => {
      healthy();
      const r = run(shell, ['status']);
      expect(r.status).toBe(0);
      expect(r.writes).toEqual([]);
      expectNoUnhandled(r);
      expectPinned(r);
      expect(r.out).toContain('Healthy');
      // The newest snapshot of THIS disk, not the look-alike's.
      expect(r.out).toContain('snap-ws-latest');
      expect(r.out).not.toContain('snap-decoy-newest');
    });

    it('fails when a disk has no schedule attached', () => {
      healthy();
      rmSync(join(stateDir, `attached-${FACTS_DISK}`));
      const r = run(shell, ['status']);
      expect(r.status).toBe(1);
      expect(r.out).toContain(`facts disk ${FACTS_DISK} has NO snapshot schedule attached`);
    });

    it('fails when the newest snapshot is older than 36 hours', () => {
      healthy();
      rmSync(join(stateDir, 'fresh'));
      const r = run(shell, ['status']);
      expect(r.status).toBe(1);
      expect(r.out).toContain('older than 36 hours');
    });

    it('waits patiently for the first snapshot of a schedule made in the last day', () => {
      healthy();
      rmSync(join(stateDir, 'snapshots'));
      rmSync(join(stateDir, 'fresh'));
      const r = run(shell, ['status'], { STUB_POLICY_RECENT: '1' });
      expect(r.status).toBe(0);
      expect(r.out).toContain('the first one is still due');
    });

    it('does not wait forever: an old schedule with no snapshot at all is a failure', () => {
      healthy();
      rmSync(join(stateDir, 'snapshots'));
      rmSync(join(stateDir, 'fresh'));
      const r = run(shell, ['status']);
      expect(r.status).toBe(1);
      expect(r.out).toContain('no snapshot at all');
    });

    it('fails when Cloud SQL deletion protection is off', () => {
      healthy();
      rmSync(join(stateDir, 'sql-dp'));
      const r = run(shell, ['status']);
      expect(r.status).toBe(1);
      expect(r.out).toContain('deletion protection is OFF');
    });
  });

  // ── drill ──────────────────────────────────────────────────────────────────
  describe('drill', () => {
    function readyToDrill() {
      seedSnapshots();
    }

    it('--dry-run changes nothing, and shows the exact objects it would create', () => {
      readyToDrill();
      const r = run(shell, ['drill', '--dry-run']);
      expect(r.status).toBe(0);
      expect(r.writes).toEqual([]);
      expect(stateFiles()).toEqual(['snapshots']);
      expectNoUnhandled(r);
      expectPinned(r);
      expect(r.out).toContain('workspace: snap-ws-latest');
      expect(r.out).toContain('facts: snap-facts-latest');
      expect(r.out).not.toContain('workspace: snap-decoy-newest');
      expect(r.out).toContain('[dry-run] would apply the checking pod');
      expect(r.out).toContain('checks run with : example.invalid/ax-next/agent:v1');
      expect(r.out).toMatch(/would run: .*disks create ax-restore-drill-workspace-\d{8}-\d{6} .*--source-snapshot snap-ws-latest/);
    });

    it('a passing drill: restores to SCRATCH disks, checks, reports timings, and leaves nothing behind', () => {
      readyToDrill();
      const r = run(shell, ['drill']);
      expect(r.status).toBe(0);
      expectNoUnhandled(r);
      expectPinned(r);
      expect(r.out).toContain('Restore drill: PASS');
      expect(r.out).toContain('restore snapshots to disks');
      expect(r.out).toMatch(/total\s+\d+m\d\ds/);

      // Order of writes: scratch disks, then the k8s objects, then teardown.
      const kinds = r.writes.map((w) => {
        if (w.includes('disks create')) return 'disk-create';
        if (w.includes('disks delete')) return 'disk-delete';
        if (w.includes(' apply ')) return 'apply';
        if (w.includes(' delete ')) return 'kdelete';
        return w;
      });
      expect(kinds).toEqual([
        'disk-create',
        'disk-create',
        'apply', // namespace
        'apply', // configmap
        'apply', // pv (workspace)
        'apply', // pvc (workspace)
        'apply', // pv (facts)
        'apply', // pvc (facts)
        'apply', // deny-all network policy
        'apply', // pod
        'kdelete', // pod,pvc,configmap,networkpolicy
        'kdelete', // pv (workspace)
        'kdelete', // pv (facts)
        'disk-delete',
        'disk-delete',
      ]);
      const creates = r.writes.filter((w) => w.includes('disks create'));
      expect(creates[0]).toMatch(/--source-snapshot snap-ws-latest .*--type pd-balanced/);
      expect(creates[1]).toContain('--source-snapshot snap-facts-latest');
      expect(creates[0]).toMatch(/--labels ax_restore_drill=\d{8}-\d{6}/);

      // No scratch disk left in the pretend cloud.
      expect(stateFiles().filter((f) => f.startsWith('scratch-'))).toEqual([]);
      // The cleanup names its own run, never a bare "delete everything".
      expect(r.writes.find((w) => w.includes(' delete pod,pvc,configmap,networkpolicy'))).toMatch(/-l ax-restore-drill=\d{8}-\d{6}/);
      // PersistentVolumes are deleted one by one, by the names the drill created.
      const pvDeletes = r.writes.filter((w) => / delete persistentvolume\//.test(w));
      expect(pvDeletes).toHaveLength(2);
      for (const d of pvDeletes) expect(d).toMatch(/delete persistentvolume\/ax-restore-drill-(workspace|facts)-\d{8}-\d{6} /);
    });

    it('NEVER attaches a production disk: no volume, claim or command names one', () => {
      readyToDrill();
      const r = run(shell, ['drill']);
      expect(r.status).toBe(0);
      const handles = r.applied
        .filter((m) => m.kind === 'PersistentVolume')
        .map((m) => m.spec.csi.volumeHandle);
      expect(handles).toHaveLength(2);
      for (const h of handles) {
        expect(h).toMatch(new RegExp(`^projects/${PROJECT}/zones/us-central1-a/disks/ax-restore-drill-(workspace|facts)-\\d{8}-\\d{6}$`));
        expect(h).not.toContain(WS_DISK);
        expect(h).not.toContain(FACTS_DISK);
      }
      // ...and the only disk deletions are of scratch disks.
      for (const w of r.writes.filter((x) => x.includes('disks delete'))) {
        expect(w).toMatch(/disks delete ax-restore-drill-/);
      }
      // The claims in the drill namespace are pre-bound to the scratch volumes.
      const pvcs = r.applied.filter((m) => m.kind === 'PersistentVolumeClaim');
      expect(pvcs.map((p) => p.spec.volumeName)).toEqual(handles.map((h) => h.split('/').pop()));
    });

    it('builds a pod that is locked down and mounts only the scratch claims', () => {
      readyToDrill();
      const r = run(shell, ['drill']);
      const pod = r.applied.find((m) => m.kind === 'Pod');
      expect(pod.metadata.namespace).toBe('ax-restore-drill');
      expect(pod.spec.containers[0].image).toBe('example.invalid/ax-next/agent:v1');
      expect(pod.spec.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 });
      expect(pod.spec.containers[0].securityContext).toMatchObject({
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      });
      expect(pod.spec.automountServiceAccountToken).toBe(false);
      expect(pod.spec.restartPolicy).toBe('Never');
      expect(pod.spec.activeDeadlineSeconds).toBeGreaterThan(0);
      const claims = pod.spec.volumes.filter((v) => v.persistentVolumeClaim).map((v) => v.persistentVolumeClaim.claimName);
      expect(claims.sort()).toEqual(['ax-restore-drill-facts', 'ax-restore-drill-workspace']);
      // Every PV is pinned to the disk's zone, or the pod could not be scheduled next to it.
      for (const pv of r.applied.filter((m) => m.kind === 'PersistentVolume')) {
        expect(pv.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0]).toEqual({
          key: 'topology.gke.io/zone',
          operator: 'In',
          values: ['us-central1-a'],
        });
        expect(pv.spec.persistentVolumeReclaimPolicy).toBe('Retain');
      }
      // The check script that runs in the pod is the one in the repo, byte for byte.
      const cm = r.applied.find((m) => m.kind === 'ConfigMap');
      expect(cm.data['verify.sh'].trim()).toBe(
        readFileSync(join(repoRoot, 'deploy/gke/restore-drill-verify.sh'), 'utf-8').trim(),
      );
    });

    it('gives the checking pod no network and a restricted namespace: restored repos are untrusted', () => {
      readyToDrill();
      const r = run(shell, ['drill']);
      const ns = r.applied.find((m) => m.kind === 'Namespace');
      expect(ns.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
      const np = r.applied.find((m) => m.kind === 'NetworkPolicy');
      expect(np.spec.policyTypes.sort()).toEqual(['Egress', 'Ingress']);
      // No rules at all => deny everything...
      expect(np.spec.ingress).toBeUndefined();
      expect(np.spec.egress).toBeUndefined();
      // ...and it selects ONLY our pod, so it is safe in any namespace, including the live one.
      const pod = r.applied.find((m) => m.kind === 'Pod');
      expect(np.spec.podSelector).toEqual({ matchLabels: { 'ax-restore-drill': pod.metadata.labels['ax-restore-drill'] } });
      expect(Object.keys(np.spec.podSelector.matchLabels)).toEqual(['ax-restore-drill']);
      // The policy exists before the pod does.
      expect(r.applied.map((m) => m.kind).indexOf('NetworkPolicy')).toBeLessThan(r.applied.map((m) => m.kind).indexOf('Pod'));
    });

    it('a FAILING drill exits 1, shows why, and still cleans up', () => {
      readyToDrill();
      writeFileSync(podLogs, 'FAIL: ws-x.git fsck failed: missing blob\nDRILL-RESULT: FAIL 1 check(s) failed\n');
      const r = run(shell, ['drill'], { STUB_POD_PHASE: 'Failed' });
      expect(r.status).toBe(1);
      expect(r.out).toContain('Restore drill: FAIL');
      expect(r.out).toContain('missing blob');
      expect(r.writes.filter((w) => w.includes('disks delete'))).toHaveLength(2);
      expect(stateFiles().filter((f) => f.startsWith('scratch-'))).toEqual([]);
    });

    it('a pod that says PASS but did not actually succeed is not a pass', () => {
      readyToDrill();
      const r = run(shell, ['drill'], { STUB_POD_PHASE: 'Failed' });
      expect(r.status).toBe(1);
      expect(r.out).toContain('Restore drill: FAIL');
    });

    it('a pod that never finishes times out as a failure, shows what Kubernetes says, and cleans up', () => {
      readyToDrill();
      const r = run(shell, ['drill', '--timeout', '1'], { STUB_POD_PHASE: 'Pending' });
      expect(r.status).toBe(1);
      expect(r.out).toContain('did not finish within 1s');
      expect(r.out).toContain('volume node affinity conflict');
      expect(r.writes.filter((w) => w.includes('disks delete'))).toHaveLength(2);
    });

    it('a drill that dies half way (a refused apply, after the disks exist) still deletes its scratch disks', () => {
      readyToDrill();
      // The 4th apply is the first claim: the disks and the first volume exist by then.
      const r = run(shell, ['drill'], { STUB_APPLY_FAILS: '4' });
      expect(r.status).toBe(1);
      expect(r.out).toContain('kubectl apply failed');
      expect(r.writes.filter((w) => w.includes('disks create'))).toHaveLength(2);
      expect(r.writes.filter((w) => w.includes('disks delete'))).toHaveLength(2);
      expect(stateFiles().filter((f) => f.startsWith('scratch-'))).toEqual([]);
    });

    it('waits for a scratch disk to detach before deleting it', () => {
      readyToDrill();
      const r = run(shell, ['drill']);
      const describes = r.log.filter((l) => l.includes('disks describe') && l.includes('value(users)'));
      // One check per scratch disk before its delete.
      expect(describes.length).toBeGreaterThanOrEqual(2);
    });

    it('refuses cleanly when there is no snapshot to restore, before creating anything', () => {
      const r = run(shell, ['drill']);
      expect(r.status).toBe(2);
      expect(r.out).toContain('no READY snapshot of the workspace disk');
      expect(r.writes).toEqual([]);
    });

    it('--keep leaves everything in place and says how to remove it, namespace included', () => {
      readyToDrill();
      const r = run(shell, ['drill', '--keep', '--drill-namespace', 'ax-next']);
      expect(r.status).toBe(0);
      expect(r.writes.filter((w) => w.includes('disks delete') || w.includes(' delete '))).toEqual([]);
      expect(stateFiles().filter((f) => f.startsWith('scratch-'))).toHaveLength(2);
      expect(r.out).toContain(`drill-cleanup --context ${CTX} --drill-namespace ax-next`);
    });

    it('reports a cleanup that could not finish, and how to finish it, without hiding a PASS', () => {
      readyToDrill();
      const r = run(shell, ['drill'], { STUB_DISK_DELETE_FAILS: '1' });
      expect(r.out).toContain('Restore drill: PASS');
      expect(r.out).toContain('cleanup did not finish');
      expect(r.out).toContain('drill-cleanup');
      // A PASS with orphaned scratch disks is not a clean exit.
      expect(r.status).toBe(1);
    });

    it('restores the snapshots you name instead of the newest, and looks each one up first', () => {
      readyToDrill();
      const r = run(shell, ['drill', '--dry-run', '--workspace-snapshot', 'snap-ws-older', '--facts-snapshot', 'snap-facts-latest']);
      expect(r.status).toBe(0);
      expect(r.out).toContain('workspace: snap-ws-older  (taken 2026-09-28T09:00:08Z)');
      expect(r.out).toMatch(/would run: .*disks create ax-restore-drill-workspace-\d{8}-\d{6} .*--source-snapshot snap-ws-older/);
      expect(r.out).not.toContain('snap-ws-latest');
      expect(r.log.some((l) => l.includes('snapshots describe snap-ws-older'))).toBe(true);
      expect(r.writes).toEqual([]);
    });

    it('warns, but goes ahead, when a named snapshot was taken of some other disk (a re-created claim)', () => {
      readyToDrill();
      const r = run(shell, ['drill', '--dry-run', '--workspace-snapshot', 'snap-decoy-newest']);
      expect(r.status).toBe(0);
      expect(r.out).toContain(`was taken of disk '${WS_DISK}-old', not of the current workspace disk '${WS_DISK}'`);
    });

    it('refuses a named snapshot that is not READY, or does not exist', () => {
      readyToDrill();
      const notReady = run(shell, ['drill', '--workspace-snapshot', 'snap-ws-older'], { STUB_SNAPSHOT_STATUS: 'CREATING' });
      expect(notReady.status).toBe(2);
      expect(notReady.out).toContain('is CREATING, not READY');
      expect(notReady.writes).toEqual([]);
      const missing = run(shell, ['drill', '--facts-snapshot', 'no-such-snapshot']);
      expect(missing.status).toBe(2);
      expect(missing.out).toContain("cannot find snapshot 'no-such-snapshot'");
      expect(missing.writes).toEqual([]);
    });

    it('uses a namespace that already exists as it is, instead of re-applying it', () => {
      readyToDrill();
      const r = run(shell, ['drill', '--drill-namespace', 'ax-next']);
      expect(r.status).toBe(0);
      expect(r.out).toContain('namespace ax-next already exists: using it as it is');
      expect(r.applied.map((m) => m.kind)).toEqual([
        'ConfigMap',
        'PersistentVolume',
        'PersistentVolumeClaim',
        'PersistentVolume',
        'PersistentVolumeClaim',
        'NetworkPolicy',
        'Pod',
      ]);
      // The claims land next to the live ones (a pod can only mount its own namespace's claims).
      for (const m of r.applied.filter((x) => x.kind === 'PersistentVolume')) {
        expect(m.spec.claimRef.namespace).toBe('ax-next');
      }
      // ...and the cleanup is scoped to this run's label even there, never the whole namespace.
      const del = r.writes.find((w) => w.includes(' delete pod,pvc,configmap'));
      expect(del).toContain('-n ax-next delete pod,pvc,configmap,networkpolicy -l ax-restore-drill=');
    });

    it('uses --image instead of reading the host deployment', () => {
      readyToDrill();
      const r = run(shell, ['drill', '--dry-run', '--image', 'example.invalid/other:tag']);
      expect(r.status).toBe(0);
      expect(r.out).toContain('checks run with : example.invalid/other:tag');
      expect(r.log.some((l) => l.includes('get deployment'))).toBe(false);
    });
  });

  // ── drill-cleanup ──────────────────────────────────────────────────────────
  describe('drill-cleanup', () => {
    it('deletes leftover scratch disks, and only those named and labelled as drill scratch', () => {
      seed.scratch('ax-restore-drill-workspace-20260929-101500', 'us-central1-a', '20260929-101500');
      seed.scratch('ax-restore-drill-facts-20260929-101500', 'us-central1-a', '20260929-101500');
      // Carries the label but not the name: not ours to delete.
      seed.decoy('someones-data-disk\tus-central1-a\t20260929-101500');
      const r = run(shell, ['drill-cleanup']);
      expect(r.status).toBe(0);
      expectNoUnhandled(r);
      expectPinned(r);
      const deletes = r.writes.filter((w) => w.includes('disks delete'));
      expect(deletes).toHaveLength(2);
      for (const d of deletes) expect(d).toMatch(/disks delete ax-restore-drill-/);
      expect(r.writes.some((w) => w.includes('someones-data-disk'))).toBe(false);
      // Kubernetes side: by label existence, in the drill namespace and for PVs.
      expect(r.writes.some((w) => / -n ax-restore-drill delete pod,pvc,configmap,networkpolicy -l ax-restore-drill /.test(w))).toBe(true);
    });

    it('deletes leftover PersistentVolumes one by one, and only those with the drill name prefix', () => {
      // Carries our label (the stub ignores selectors) but not our name: hands off.
      writeFileSync(join(stateDir, 'pvs'), 'persistentvolume/somebodys-volume\npersistentvolume/ax-restore-drill-workspace-20260929-101500\n');
      const r = run(shell, ['drill-cleanup']);
      expect(r.status).toBe(0);
      const pvDeletes = r.writes.filter((w) => / delete persistentvolume\//.test(w));
      expect(pvDeletes).toHaveLength(1);
      expect(pvDeletes[0]).toContain('persistentvolume/ax-restore-drill-workspace-20260929-101500');
      expect(r.writes.some((w) => w.includes('somebodys-volume'))).toBe(false);
      expect(r.out).toContain('not deleting persistentvolume/somebodys-volume');
    });

    it('reports, and exits 1, when it cannot list the volumes to clean', () => {
      const r = run(shell, ['drill-cleanup'], { STUB_GET_PV_FAILS: '1' });
      expect(r.status).toBe(1);
      expect(r.out).toContain("could not list the drill's PersistentVolumes");
    });

    it('with --project it works after the deployment is gone: no PVC lookup at all', () => {
      seed.scratch('ax-restore-drill-workspace-20260929-101500', 'us-central1-a', '20260929-101500');
      // The claims are gone (a deleted deployment is exactly when scratch disks get forgotten).
      const r = run(shell, ['drill-cleanup', '--project', PROJECT], { STUB_PVC_MISSING: '1' });
      expect(r.status).toBe(0);
      expect(r.log.some((l) => l.includes('get pvc'))).toBe(false);
      expect(r.out).toContain('not looked up (the project came from --project)');
      expectPinned(r);
      const deletes = r.writes.filter((w) => w.includes('disks delete'));
      expect(deletes).toHaveLength(1);
      expect(deletes[0]).toContain(`--project ${PROJECT} compute disks delete ax-restore-drill-workspace-20260929-101500`);
    });

    it('without --project it still needs the PVCs, and says why it stopped', () => {
      const r = run(shell, ['drill-cleanup'], { STUB_PVC_MISSING: '1' });
      expect(r.status).toBe(2);
      expect(r.out).toContain('cannot read PVC');
      expect(r.writes).toEqual([]);
    });

    it('is not confused by a notice on stderr while listing disks', () => {
      seed.scratch('ax-restore-drill-workspace-20260929-101500', 'us-central1-a', '20260929-101500');
      const r = run(shell, ['drill-cleanup'], { STUB_NOTICE: '1' });
      expect(r.status).toBe(0);
      const deletes = r.writes.filter((w) => w.includes('disks delete'));
      expect(deletes).toHaveLength(1);
      expect(deletes[0]).toContain('ax-restore-drill-workspace-20260929-101500');
    });

    it('--dry-run lists what it would remove and removes nothing', () => {
      seed.scratch('ax-restore-drill-workspace-20260929-101500', 'us-central1-a', '20260929-101500');
      const r = run(shell, ['drill-cleanup', '--dry-run']);
      expect(r.status).toBe(0);
      expect(r.writes).toEqual([]);
      expect(r.out).toContain('would run: gcloud --project example-proj-1 compute disks delete ax-restore-drill-workspace-20260929-101500');
      expect(stateFiles()).toEqual(['scratch-ax-restore-drill-workspace-20260929-101500']);
    });

    it('does not fail when there is nothing to clean', () => {
      const r = run(shell, ['drill-cleanup']);
      expect(r.status).toBe(0);
      expect(r.writes.filter((w) => w.includes('disks delete'))).toEqual([]);
    });
  });

  // ── the guards themselves ──────────────────────────────────────────────────
  describe('the stubs cannot be bypassed', () => {
    it('a call the stub does not recognise fails the run instead of passing silently', () => {
      // Sanity check on the harness: the stub really does refuse unknown calls.
      const r = spawnSync(join(binDir, 'gcloud'), ['definitely', 'not', 'a', 'command', '--project', 'x'], {
        encoding: 'utf-8',
        env: { PATH: '/usr/bin:/bin', STUB_LOG: logFile, STUB_STATE: stateDir },
      });
      expect(r.status).toBe(99);
      expect(existsSync(logFile)).toBe(true);
    });
  });
});
