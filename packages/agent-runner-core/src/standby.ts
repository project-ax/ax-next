import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import {
  BOOTSTRAP_ROOT, BOOTSTRAP_FILE, BOOTSTRAP_ACK, BOOTSTRAP_MAX_BYTES,
  BootstrapAssignmentSchema,
} from '@ax/sandbox-protocol';
import { scaffoldPythonVenv } from './python-venv.js';

/** Called before constructing runner state, IPC, or the model loop. Single assignment. */
export async function waitForAssignment(options: {
  env?: NodeJS.ProcessEnv; root?: string; signal?: AbortSignal; pollMs?: number;
} = {}): Promise<void> {
  const env = options.env ?? process.env;
  if (env.AX_STANDBY !== '1') return;
  const root = options.root ?? BOOTSTRAP_ROOT;
  const file = join(root, BOOTSTRAP_FILE);
  if (!env.AX_INSTANCE_ID) throw new Error('standby instance identity missing');
  // Image-only preparation, before reading tenant configuration or credentials.
  // The shared template and bootstrap schema fix the ephemeral tier at this path.
  // Await completion so the session cannot race a half-copied venv; failure is
  // best-effort and the ordinary session scaffold retains its existing fallback.
  await scaffoldPythonVenv('/ephemeral', { offlineOnly: true }).catch(() => false);
  for (;;) {
    options.signal?.throwIfAborted();
    let handle;
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('standby assignment unreadable');
      await setTimeout(options.pollMs ?? 50, undefined, { signal: options.signal });
      continue;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > BOOTSTRAP_MAX_BYTES || stat.size === 0 ||
          (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) {
        throw new Error('invalid standby assignment file');
      }
      const bytes = Buffer.alloc(BOOTSTRAP_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > BOOTSTRAP_MAX_BYTES) throw new Error('standby assignment too large');
      const result = BootstrapAssignmentSchema.safeParse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
      if (!result.success || result.data.instanceId !== env.AX_INSTANCE_ID || result.data.expiresAt <= Date.now()) {
        throw new Error('invalid standby assignment');
      }
      // Consume the secret before accepting any work. Used instances are never reassigned.
      await unlink(file);
      const assignment = result.data;
      const ack = join(root, `${BOOTSTRAP_ACK}.tmp`);
      const out = await open(ack, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await out.writeFile(JSON.stringify({ assignmentId: assignment.assignmentId, instanceId: assignment.instanceId }));
        await out.sync();
      } finally { await out.close(); }
      await rename(ack, join(root, BOOTSTRAP_ACK));
      Object.assign(env, assignment.env);
      delete env.AX_STANDBY;
      return;
    } catch {
      // Never log JSON, tokens, or raw validation errors from the secret file.
      await unlink(file).catch(() => undefined);
      throw new Error('standby activation failed');
    } finally { await handle.close(); }
  }
}
