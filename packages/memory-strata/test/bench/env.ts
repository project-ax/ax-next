export function requireKeys<T extends Record<string, string | undefined>>(env: T): {
  [K in keyof T]: string;
} {
  const missing: string[] = [];
  for (const [key, val] of Object.entries(env)) {
    if (!val) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `Bench environment is missing required keys: ${missing.join(', ')}. ` +
        `Set them in your shell or .env file before running pnpm bench.`,
    );
  }
  return env as { [K in keyof T]: string };
}
