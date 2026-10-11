import { vi } from 'vitest';

/** Suppress only the diagnostic a negative test names. Unexpected output stays visible. */
export function captureExpectedStderr(matches: (message: string) => boolean) {
  const messages: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...args: unknown[]) => {
    const message = String(chunk);
    if (matches(message)) { messages.push(message); return true; }
    return Reflect.apply(original, process.stderr, [chunk, ...args]) as boolean;
  }) as typeof process.stderr.write);
  return { messages, restore: () => spy.mockRestore() };
}
