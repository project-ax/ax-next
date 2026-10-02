import { constants, openSync, closeSync, fchownSync, fchmodSync, writeFileSync, fsyncSync,
  renameSync, unlinkSync, readFileSync, readdirSync, fstatSync, statfsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { BOOTSTRAP_ACK, BOOTSTRAP_FILE, BOOTSTRAP_MAX_BYTES } from '@ax/sandbox-protocol';
import { openDirectory } from './confined-directory.js';
import { sourceParts } from './sources.js';
import { LATE_VOLUME, StorageAssignmentSchema, StorageRecordSchema,
  type StorageAssignment, type StorageIdentity, type StorageRecord } from './protocol.js';

export interface StorageAuthority {
  authorize(input: StorageAssignment): Promise<void>;
  protect(input: StorageIdentity): Promise<void>;
  stop(input: StorageIdentity): Promise<void>;
  finish(input: StorageIdentity): Promise<void>;
  abandoned(input: StorageRecord): Promise<boolean>;
}
export interface StorageNodeConfig {
  backingProfile: string;
  kubeletPodsRoot: string; ledgerRoot: string; userFilesRoot: string; memoryRoot?: string;
}
const targetName = (role: 'user-files' | 'memory') => role === 'user-files' ? 'files' : 'memory';

export class StorageNodeEngine {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly config: StorageNodeConfig, private readonly authority: StorageAuthority,
    private readonly command: (program: string, args: string[]) => void = (program, args) => {
      execFileSync(program, args, { timeout: 30_000, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 8192 });
    }, private readonly io: { directory: typeof openDirectory; mountInfo(): string; chown(fd: number): void;
      isTmpfs(path: string): boolean } = {
      directory: openDirectory, mountInfo: () => readFileSync('/proc/self/mountinfo', 'utf8'),
      chown: fd => fchownSync(fd, 1000, 1000),
      isTmpfs: path => statfsSync(path).type === 0x01021994,
    }) {
    mkdirSync(config.ledgerRoot, { recursive: true, mode: 0o700 });
    const root = this.io.directory(config.ledgerRoot, []);
    try { fchmodSync(root.fd, 0o700); } finally { root.close(); }
  }
  private serial<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(uid) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(fn);
    this.pending.set(uid, current);
    void current.finally(() => { if (this.pending.get(uid) === current) this.pending.delete(uid); }).catch(() => undefined);
    return current;
  }
  private ledgerPath(uid: string): string { return join(this.config.ledgerRoot, `${uid}.json`); }
  private load(uid: string): StorageRecord | undefined {
    try {
      const fd = openSync(this.ledgerPath(uid), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 8192) throw new Error('invalid storage ledger file');
        const record = StorageRecordSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
        if (record.podUid !== uid) throw new Error('storage ledger identity mismatch');
        return record;
      } finally { closeSync(fd); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  }
  private save(record: StorageRecord) {
    const temp = `${this.ledgerPath(record.podUid)}.tmp`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.ledgerPath(record.podUid));
    const dir = this.io.directory(this.config.ledgerRoot, []); try { fsyncSync(dir.fd); } finally { dir.close(); }
  }
  private volume(record: StorageIdentity, create = false) {
    return this.io.directory(this.config.kubeletPodsRoot,
      [record.podUid, 'volumes', 'kubernetes.io~empty-dir', LATE_VOLUME], create);
  }
  async assign(raw: StorageAssignment): Promise<{ assignmentId: string }> {
    const input = StorageAssignmentSchema.parse(raw);
    return this.serial(input.podUid, async () => {
      if (input.bootstrap.expiresAt <= Date.now() || Buffer.byteLength(JSON.stringify(input.bootstrap)) > BOOTSTRAP_MAX_BYTES) throw new Error('invalid assignment bounds');
      if (input.backingProfile !== this.config.backingProfile) throw new Error('storage deployment configuration differs');
      await this.authority.authorize(input);
      const staging = this.volume(input);
      try {
        // Verify the held directory's actual filesystem as well as the Pod
        // declaration. Disk emptyDir teardown can erase mounted agent data.
        if (!this.io.isTmpfs(staging.path)) throw new Error('shared storage requires tmpfs staging');
      } finally { staging.close(); }
      const old = this.load(input.podUid);
      const { bootstrap, ...identity } = input;
      const record = StorageRecordSchema.parse({ ...identity, assignmentId: bootstrap.assignmentId, published: false });
      if (old) {
        if (JSON.stringify({ ...old, published: false }) !== JSON.stringify(record)) throw new Error('instance already assigned');
        if (!old.published) { await this.releaseLocked(old); throw new Error('partial assignment reclaimed; retry with a new instance'); }
        return { assignmentId: old.assignmentId }; // Never remount or recreate consumed secrets on retry.
      }
      // Durable intent precedes every mount. Restart recovery can unwind a partial bind.
      this.save(record);
      try {
        await this.authority.protect(input);
        for (const role of input.roles) {
          const backing = role === 'user-files' ? this.config.userFilesRoot : this.config.memoryRoot;
          if (!backing) throw new Error('storage role is not configured');
          const source = this.io.directory(backing, sourceParts(input.agentId, role), role === 'user-files');
          const volume = this.volume(record);
          let target;
          try {
            if (role === 'user-files') { this.io.chown(source.fd); }
            target = this.io.directory(volume, [targetName(role)], true);
            this.command('mount', ['--no-canonicalize', '--bind', source.path, target.path]);
            if (role === 'memory') {
              const mounted = this.io.directory(volume, [targetName(role)]);
              try { this.command('mount', ['--no-canonicalize', '-o', 'remount,bind,ro', mounted.path]); }
              finally { mounted.close(); }
            }
          } finally { target?.close(); volume.close(); source.close(); }
        }
        const volume = this.volume(record);
        const directory = this.io.directory(volume, ['bootstrap'], true);
        try {
          this.io.chown(directory.fd); fchmodSync(directory.fd, 0o700);
          const temp = `${directory.path}/session.tmp`;
          const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { writeFileSync(fd, JSON.stringify(bootstrap)); this.io.chown(fd); fsyncSync(fd); }
          finally { closeSync(fd); }
          await this.authority.authorize(input); // Recheck UID and deletion immediately before granting credentials.
          renameSync(temp, `${directory.path}/${BOOTSTRAP_FILE}`); fsyncSync(directory.fd);
        } finally { directory.close(); volume.close(); }
        this.save({ ...record, published: true });
        return { assignmentId: record.assignmentId };
      } catch {
        // Keep durable intent + finalizers for recovery; never discard an active mount.
        await this.releaseLocked(record).catch(() => undefined);
        throw new Error('storage activation failed');
      }
    });
  }
  async status(identity: StorageIdentity): Promise<{ accepted: boolean }> {
    return this.serial(identity.podUid, async () => {
      const record = this.load(identity.podUid);
      if (!record || !this.sameIdentity(record, identity)) throw new Error('unknown assignment');
      const volume = this.volume(record);
      let directory;
      try {
        directory = this.io.directory(volume, ['bootstrap']);
        const fd = openSync(`${directory.path}/${BOOTSTRAP_ACK}`, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = fstatSync(fd);
          if (stat.size > 1024 || !stat.isFile()) throw new Error('invalid activation receipt');
          const ack = JSON.parse(readFileSync(fd, 'utf8')) as { assignmentId?: unknown; instanceId?: unknown };
          return { accepted: ack.assignmentId === record.assignmentId && ack.instanceId === record.podUid };
        } finally { closeSync(fd); }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { accepted: false }; throw e; }
      finally { directory?.close(); volume.close(); }
    });
  }
  private sameIdentity(record: StorageIdentity, input: StorageIdentity) {
    return ['podName', 'podUid', 'claimName', 'claimUid', 'sandboxName', 'sandboxUid'].every(k =>
      record[k as keyof StorageIdentity] === input[k as keyof StorageIdentity]);
  }
  async release(identity: StorageIdentity): Promise<void> {
    return this.serial(identity.podUid, async () => {
      const record = this.load(identity.podUid);
      if (!record) return;
      if (!this.sameIdentity(record, identity)) throw new Error('assignment identity mismatch');
      await this.releaseLocked(record);
    });
  }
  private async releaseLocked(record: StorageRecord) {
    // Stop all containers before detaching data. Authority waits for termination.
    await this.authority.stop(record);
    let volume;
    try { volume = this.volume(record); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (volume) {
      try {
        for (const role of record.roles) {
          let target;
          try {
            target = this.io.directory(volume, [targetName(role)]);
            const targetStat = fstatSync(target.fd), volumeStat = fstatSync(volume.fd);
            // A planned but never completed bind lives on the same filesystem as emptyDir.
            // Require a mount record too: local acceptance sources may have the same device.
            const stillMounted = () => this.io.mountInfo().split('\n').some(line => line.split(' ')[4]?.endsWith(
              `/${record.podUid}/volumes/kubernetes.io~empty-dir/${LATE_VOLUME}/${targetName(role)}`));
            const mounted = stillMounted();
            if (mounted || targetStat.dev !== volumeStat.dev) {
              this.command('sync', ['-f', target.path]);
              this.command('umount', ['--no-canonicalize', '-l', target.path]);
              if (stillMounted()) throw new Error('storage mount remains attached');
            }
          } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          finally { target?.close(); }
        }
        const directory = this.io.directory(volume, ['bootstrap'], true);
        try { for (const file of [BOOTSTRAP_FILE, 'session.tmp']) {
          try { unlinkSync(`${directory.path}/${file}`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        } } finally { directory.close(); }
      } finally { volume.close(); }
    }
    await this.authority.finish(record);
    unlinkSync(this.ledgerPath(record.podUid));
  }
  async reconcile(): Promise<void> {
    let failed = false;
    for (const file of readdirSync(this.config.ledgerRoot)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      try {
        const record = this.load(file.slice(0, -5));
        if (record && (!record.published || await this.authority.abandoned(record))) await this.release(record);
      } catch { failed = true; }
    }
    if (failed) throw new Error('storage recovery pending');
  }
}

export const STORAGE_REQUEST_MAX_BYTES = BOOTSTRAP_MAX_BYTES + 4096;
