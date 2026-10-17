const REPORT_MAX_CHARS = 1024;
/** Values of keys named like this are credentials and are redacted at ANY non-empty length. */
const SECRET_NAME = /TOKEN|SECRET|KEY|AUTH|PASSWORD|CRED|COOKIE/i;
/**
 * Every OTHER value this long is redacted too (endpoints, ids that might be
 * bearer-ish). Shorter non-secret values (a session id like `sess1`, a port)
 * stay: they are what an operator correlates a failure by, and stripping
 * every short string would shred ordinary words out of the message.
 */
const LONG_VALUE_CHARS = 8;

/** The values to redact, longest first so a short secret inside a longer value leaves no fragment. */
function redactionList(env: Readonly<Record<string, string>>): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (SECRET_NAME.test(name) || value.length >= LONG_VALUE_CHARS) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function redact(text: string, env: Readonly<Record<string, string>>): string {
  for (const value of redactionList(env)) text = text.split(value).join('[redacted]');
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, REPORT_MAX_CHARS);
}

/**
 * One bounded, single-line description of an error for the helper's log. The
 * bootstrap env (session/proxy tokens, endpoints) is redacted first — an error
 * message that happens to echo one must never carry it into a log.
 */
export function describeFailure(error: unknown, env: Readonly<Record<string, string>>): string {
  const text = error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? error.name}: ${error.message}` : String(error);
  return redact(text, env);
}

/**
 * A stand-in for `error` to attach as a rethrown error's `cause`: a fresh Error
 * with the redacted message and the original's `name`/`code`, and no `cause`
 * or stack of its own. Never attach the original — a logger that
 * deep-serializes `cause` (pino does) would print the unredacted message.
 */
export function redactedError(error: unknown, env: Readonly<Record<string, string>>): Error {
  const out = new Error(redact(error instanceof Error ? error.message : String(error), env));
  if (error instanceof Error) {
    out.name = error.name;
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string') (out as NodeJS.ErrnoException).code = code;
  }
  return out;
}
