import { constants, openSync, closeSync, mkdirSync, fstatSync } from 'node:fs';

/**
 * Pin every component, not just the leaf. Subsequent operations use held directory
 * descriptors, so an untrusted rename cannot redirect a privileged mount.
 */
export function openDirectory(root: string | { fd: number }, parts: string[], create = false): { fd: number; path: string; close(): void } {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const fds: number[] = [];
  try {
    // Only a descriptor we already hold may bypass NOFOLLOW at the trusted root.
    fds.push(typeof root === 'string' ? openSync(root, flags) :
      openSync(`/proc/${process.pid}/fd/${root.fd}`, flags & ~constants.O_NOFOLLOW));
    for (const part of parts) {
      if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\0')) throw new Error('unsafe directory component');
      const path = `/proc/${process.pid}/fd/${fds.at(-1)!}/${part}`;
      if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
      fds.push(openSync(path, flags));
    }
    const fd = fds.at(-1)!;
    if (!fstatSync(fd).isDirectory()) throw new Error('not a directory');
    return { fd, path: `/proc/${process.pid}/fd/${fd}`, close: () => { for (const f of fds.splice(0).reverse()) closeSync(f); } };
  } catch (e) { for (const fd of fds.reverse()) closeSync(fd); throw e; }
}
