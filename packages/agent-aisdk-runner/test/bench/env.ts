/**
 * Fail with the WHOLE list of missing keys, not the first one.
 *
 * Same helper the memory-strata bench uses, for the same small reason: a bench
 * that dies one key at a time makes someone run it three times to learn what it
 * needed.
 */
export function requireKeys<T extends Record<string, string | undefined>>(
  env: T,
): { [K in keyof T]: string } {
  const missing = Object.entries(env)
    .filter(([, value]) => value === undefined || value.length === 0)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `The compaction bench needs: ${missing.join(', ')}. Set them in your ` +
        `shell before running pnpm bench — this one talks to a real provider, ` +
        `which is the whole point of it.`,
    );
  }
  return env as { [K in keyof T]: string };
}
