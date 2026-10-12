const REPORT_MAX_CHARS = 1024;
/**
 * One bounded, single-line description of an error for the helper's log. Every
 * bootstrap env value (session/proxy tokens, endpoints) is redacted first —
 * an error message that happens to echo one must never carry it into a log.
 */
export function describeFailure(error: unknown, secrets: readonly string[]): string {
  let text = error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? error.name}: ${error.message}` : String(error);
  for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join('[redacted]');
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, REPORT_MAX_CHARS);
}
