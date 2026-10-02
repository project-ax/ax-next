import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

type ProcessIdentity = { pid: number; parent: number; started: string };

function identity(pid: number): ProcessIdentity | null {
  try {
    // comm may contain spaces and parentheses. Fields after its LAST closing
    // parenthesis start at stat field 3; starttime is field 22.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, parent: Number(fields[1]), started: fields[19]! };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' ||
        (err as NodeJS.ErrnoException).code === 'ESRCH') return null;
    throw err;
  }
}

/** Own the SDK child, never infer process ownership from model-writable files. */
export function createInterruptProcesses() {
  let root: ProcessIdentity | null = null;
  let startup: Map<number, ProcessIdentity> | null = null;
  return {
    spawn(options: SpawnOptions): SpawnedProcess {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd, env: options.env, signal: options.signal,
        // Match the SDK default: unread stderr must not block its pipe.
        stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true,
      });
      if (process.platform === 'linux' && child.pid !== undefined) {
        root = identity(child.pid);
        child.once('exit', () => { root = null; });
      }
      return child;
    },
    preserveStartupProcesses(): void {
      // Called by the first UserPromptSubmit hook, before provider/tool work.
      // SDK initialization has already connected its long-lived MCP servers.
      if (startup !== null || root === null) return;
      startup = new Map();
      const table = new Map<number, ProcessIdentity>();
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const proc = identity(Number(name));
        if (proc !== null) table.set(proc.pid, proc);
      }
      const parents = new Set([root.pid]);
      for (;;) {
        const next = [...table.values()].filter(p => parents.has(p.parent) && !parents.has(p.pid));
        if (next.length === 0) break;
        for (const proc of next) { startup.set(proc.pid, proc); parents.add(proc.pid); }
      }
    },
    killTools(): void {
      // Before the first prompt there are no model tools to kill. In particular,
      // an early Stop must not tear down the SDK's initializing MCP servers.
      if (startup === null || root === null || identity(root.pid)?.started !== root.started) return;
      const table = new Map<number, ProcessIdentity>();
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const proc = identity(Number(name));
        if (proc !== null) table.set(proc.pid, proc);
      }
      // Recheck after the snapshot as well: PID reuse must never grant reach
      // into a different process tree if the SDK exited during enumeration.
      if (identity(root.pid)?.started !== root.started) return;
      const owned: ProcessIdentity[] = [];
      const parents = new Set([root.pid]);
      const protectedParents = new Set<number>();
      for (const proc of table.values()) {
        if (proc.pid !== root.pid && startup.get(proc.pid)?.started === proc.started) {
          protectedParents.add(proc.pid);
        }
      }
      // Preserve new children of long-lived startup processes too, such as an
      // MCP server launching its own request worker. They are not native Bash.
      for (;;) {
        const descendants = [...table.values()].filter(
          p => protectedParents.has(p.parent) && !protectedParents.has(p.pid),
        );
        if (descendants.length === 0) break;
        for (const proc of descendants) protectedParents.add(proc.pid);
      }
      // Breadth first: freeze parents before children. Killing sleep first would
      // wake its shell and permit the very delayed write Stop must prevent.
      try {
        for (;;) {
          const next = [...table.values()].filter(
            p => parents.has(p.parent) && !parents.has(p.pid) && !protectedParents.has(p.pid),
          );
          if (next.length === 0) break;
          for (const proc of next) {
            if (identity(proc.pid)?.started !== proc.started) {
              table.delete(proc.pid);
              continue;
            }
            try { process.kill(proc.pid, 'SIGSTOP'); } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
            }
            owned.push(proc);
            parents.add(proc.pid);
          }
          // Processes may fork while we take the snapshot. Refresh after freezing
          // this level; their stopped parents cannot create further descendants.
          for (const name of readdirSync('/proc')) {
            if (!/^\d+$/.test(name)) continue;
            const proc = identity(Number(name));
            if (proc !== null) table.set(proc.pid, proc);
          }
        }
      } finally {
        // Even an unexpected /proc read failure must not leave frozen tools.
        for (const proc of owned.reverse()) {
          if (identity(proc.pid)?.started !== proc.started) continue;
          try { process.kill(proc.pid, 'SIGKILL'); } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
          }
        }
      }
      // The SDK itself remains alive to persist the interrupted tool result,
      // finish this turn, and accept the next message in the same warm session.
    },
  };
}
