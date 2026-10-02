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

/** How long Stop keeps tools frozen waiting for the SDK to take the interrupt. */
export const INTERRUPT_ACK_MS = 2000;

/** Stop could not establish ownership of, or kill, the tool processes. */
export class ToolTerminationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ToolTerminationError';
  }
}

function killOwned(owned: ProcessIdentity[]): void {
  // Children before parents: the reverse of the freeze order.
  for (const proc of [...owned].reverse()) {
    if (identity(proc.pid)?.started !== proc.started) continue;
    try { process.kill(proc.pid, 'SIGKILL'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }
}

/** Own the SDK child, never infer process ownership from model-writable files. */
export function createInterruptProcesses() {
  let root: ProcessIdentity | null = null;
  let startup: Map<number, ProcessIdentity> | null = null;
  const self = {
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
    /**
     * SIGSTOP every model-tool descendant of the SDK child and hand back the
     * function that SIGKILLs them. Freezing first and killing later is what
     * keeps Stop deterministic: a KILLED tool is a finished tool, and the SDK
     * reacts to a finished tool by sending its result to the model — so if the
     * kill reaches the SDK before the interrupt does, Stop starts one more
     * model call and the turn ends `aborted_streaming` (TASK-746). A frozen
     * tool can neither finish nor write; it just waits for the interrupt.
     */
    freezeTools(): () => void {
      const none = (): void => {};
      // Before the first prompt there are no model tools to kill. In particular,
      // an early Stop must not tear down the SDK's initializing MCP servers.
      if (startup === null || root === null || identity(root.pid)?.started !== root.started) return none;
      const table = new Map<number, ProcessIdentity>();
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const proc = identity(Number(name));
        if (proc !== null) table.set(proc.pid, proc);
      }
      // Recheck after the snapshot as well: PID reuse must never grant reach
      // into a different process tree if the SDK exited during enumeration.
      if (identity(root.pid)?.started !== root.started) return none;
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
      } catch (err) {
        // Even an unexpected /proc read failure must not leave frozen tools.
        killOwned(owned);
        throw err;
      }
      // The SDK itself remains alive to persist the interrupted tool result,
      // finish this turn, and accept the next message in the same warm session.
      let killed = false;
      return () => {
        if (killed) return;
        killed = true;
        killOwned(owned);
      };
    },
    /**
     * The Stop order: freeze the tools, let the SDK take the interrupt while
     * they cannot finish, then kill them. The SIGKILL waits for the SDK's
     * interrupt acknowledgement, bounded by `ackMs` so a wedged SDK can never
     * keep a frozen tool alive. Resolves once the interrupt itself settles.
     * Tool-termination failures reject with {@link ToolTerminationError}
     * (without sending the interrupt, if freezing failed); an interrupt
     * failure rejects with its own error, after the tools are dead.
     */
    async stop(interrupt: () => Promise<void>, ackMs = INTERRUPT_ACK_MS): Promise<void> {
      let release: () => void;
      try {
        release = self.freezeTools();
      } catch (err) {
        throw new ToolTerminationError(err);
      }
      const settled = (async () => interrupt())().then(
        () => null,
        (err: unknown) => ({ err }),
      );
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([settled, new Promise<void>((r) => { timer = setTimeout(r, ackMs); })]);
      clearTimeout(timer);
      try {
        release();
      } catch (err) {
        throw new ToolTerminationError(err);
      }
      const failed = await settled;
      if (failed !== null) throw failed.err;
    },
  };
  return self;
}
