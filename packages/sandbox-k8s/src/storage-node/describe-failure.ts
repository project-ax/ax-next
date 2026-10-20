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
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').slice(0, REPORT_MAX_CHARS);
}

/**
 * `@kubernetes/client-node`'s ApiException builds its message as `HTTP-Code: <code>\nMessage:
 * <text>\nBody: <JSON of the body>\nHeaders: <JSON of the response headers>`. An apiserver's
 * headers carry a per-request `audit-id` and `date`, so an error described whole never reads
 * the same twice. Matched by its message, not `instanceof`: the package loads the client only
 * lazily (main.ts, k8s-api.ts), and an import here would load it wherever this file goes.
 */
const API_EXCEPTION = /^HTTP-Code: (\d+)\nMessage: /;
const API_BODY = '\nBody: ';
const API_HEADERS = '\nHeaders: ';

/**
 * The message of the Kubernetes Status in an ApiException's `Body:` section, or undefined.
 * The generated API classes pass the response text as the body, so that section is JSON of
 * a string of JSON. The log and metrics helpers pass the parsed Status.
 */
function statusMessage(section: string): string | undefined {
  try {
    let status: unknown = JSON.parse(section);
    if (typeof status === 'string') status = JSON.parse(status);
    const { kind, message } = (status ?? {}) as { kind?: unknown; message?: unknown };
    return kind === 'Status' && typeof message === 'string' && message.length > 0 ? message : undefined;
  } catch { return undefined; } // Not JSON, so not a Status.
}

/**
 * One bounded, single-line description of an error for the helper's log. The
 * bootstrap env (session/proxy tokens, endpoints) is redacted first — an error
 * message that happens to echo one must never carry it into a log.
 *
 * A Kubernetes API error reads `HTTP <code>: <Status message>` when its body is a
 * Status, and otherwise as usual, cut where the response headers begin. Either way
 * the same failure reads the same every time, which is what lets a caller report
 * it once per change.
 */
export function describeFailure(error: unknown, env: Readonly<Record<string, string>>): string {
  if (!(error instanceof Error)) return redact(String(error), env);
  let message = error.message;
  const api = API_EXCEPTION.exec(message);
  if (api) {
    const headers = message.lastIndexOf(API_HEADERS);
    if (headers >= 0) message = message.slice(0, headers);
    const body = message.indexOf(API_BODY);
    const status = body < 0 ? undefined : statusMessage(message.slice(body + API_BODY.length));
    if (status !== undefined) return redact(`HTTP ${api[1]}: ${status}`, env);
  }
  return redact(`${(error as NodeJS.ErrnoException).code ?? error.name}: ${message}`, env);
}

/**
 * A stand-in for `error` to attach as a rethrown error's `cause`: a fresh Error
 * with the redacted message and the original's `name`/`code`, and no `cause`.
 * Its stack is its own: a header of that name and the redacted message, over
 * the frames that created the stand-in. Neither the original's message nor
 * its frames are kept. Never attach the original — a logger that
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
