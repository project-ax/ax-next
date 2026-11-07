import { format } from 'node:util';
import { vi } from 'vitest';

export interface Captured {
  /** Every write, from every channel, one entry per write. */
  output: string[];
  /** The auth-better lines, each tagged with the channel it went to. */
  authLines: Array<{ via: 'stderr' | 'stdout' | 'console'; line: string }>;
}

/**
 * Everything written while `run` is in flight: stderr, stdout (the core
 * logger's channel) and the console. vitest gives its workers a console of its
 * own that never calls process.stdout/stderr.write, so a `console.error(err)`
 * would slip past the two stream spies unless the console is captured too.
 */
export async function captureOutput<T>(run: () => Promise<T>): Promise<{ result: T } & Captured> {
  const output: string[] = [];
  const authLines: Captured['authLines'] = [];
  const push = (via: 'stderr' | 'stdout' | 'console', text: string): void => {
    output.push(text);
    if (text.startsWith('[ax/auth-better]')) authLines.push({ via, line: text });
  };
  const recordTo = (via: 'stderr' | 'stdout') =>
    ((chunk: unknown) => {
      push(via, String(chunk));
      return true;
    }) as typeof process.stderr.write;
  const spies = [
    vi.spyOn(process.stderr, 'write').mockImplementation(recordTo('stderr')),
    vi.spyOn(process.stdout, 'write').mockImplementation(recordTo('stdout')),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        push('console', format(...args));
      }),
    ),
  ];
  try {
    return { result: await run(), output, authLines };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}
