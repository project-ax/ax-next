// ---------------------------------------------------------------------------
// service-diagnosis (TASK-160) — make a failed dev-service sidecar SELF-DIAGNOSING.
//
// When a declared dev service (TASK-150 ServiceDescriptor) fails to start under
// the locked sandbox context — almost always because a directory it needs to
// write isn't in `writablePaths`, so the container hits EROFS / permission
// denied — today the failure is opaque ("session failed"). This module is the
// SHARED, backend-agnostic vocabulary for turning that failure into an author-
// facing, actionable message: "service 'kafka' couldn't write /opt/kafka
// (read-only filesystem) — add it to writablePaths".
//
// SECURITY POSTURE (security-checklist). The sidecar's own log output is
// THIRD-PARTY / UNTRUSTED (an arbitrary connector-declared image). We treat it
// as hostile:
//   - It is captured BOUNDED at the source (k8s `tailLines`, a slice on compose
//     stderr) — this module additionally clamps anything it touches.
//   - We never echo the raw log into the user-facing message. We SCAN it with a
//     fixed set of regexes for the known "couldn't write here" shapes and
//     EXTRACT just an absolute-looking path. The path is re-validated before
//     display; everything else is a CURATED reason phrase from a closed set.
//   - The final one-line message strips control characters (incl. ANSI / CR /
//     LF) so a malicious image can't inject a wall of text, fake "SYSTEM:"
//     instructions, or terminal escapes into the author's error card.
//
// `ServiceStartupDiagnosis` carries NO backend vocabulary (no `pod`,
// `initContainer`, `compose`, `docker`, exit code) — only `service` / `path` /
// `reason`. That keeps it safe to ride the backend-agnostic `chat:turn-error`
// surface (Invariant I1).
// ---------------------------------------------------------------------------

/**
 * A backend-agnostic, author-facing diagnosis of why a dev-service sidecar
 * failed to start. Produced by each sandbox backend at its failure site and
 * formatted into a one-line `detail` string by {@link formatServiceDiagnosis}.
 */
export interface ServiceStartupDiagnosis {
  /** The declared service name (descriptor `name`; charset-bounded upstream). */
  service: string;
  /**
   * The absolute in-container path the service tried (and failed) to write,
   * when we could extract it from the log. Absent when the log didn't name one.
   */
  path?: string;
  /**
   * A CURATED reason phrase from a closed set — never raw log text.
   * One of: 'read-only filesystem' | 'permission denied' | 'startup failed'.
   */
  reason: string;
}

/** Closed set of curated reason phrases. */
export const SERVICE_DIAGNOSIS_REASONS = {
  readOnly: 'read-only filesystem',
  permissionDenied: 'permission denied',
  startupFailed: 'startup failed',
} as const;

/** Max chars of any captured tail this module will scan (defense-in-depth; the
 *  capture sites already bound it). */
const MAX_TAIL_CHARS = 4096;
/** Max length of a service name we'll surface (descriptor names are ≤64). */
const MAX_SERVICE_CHARS = 80;
/** Max length of a path we'll surface. */
const MAX_PATH_CHARS = 256;
/** Absolute-path shape — leading slash, no whitespace, bounded. */
const ABSOLUTE_PATH_RE = /^\/[^\s]{0,255}$/;

/** Control chars to strip: C0 (U+0000-U+001F, incl. CR/LF/TAB), DEL (U+007F),
 *  and the C1 range (U+0080-U+009F) used by ANSI escapes. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * Strip control characters so untrusted text can't inject newlines / terminal
 * escapes / fake structured lines into a one-line message. Collapses any run of
 * removed chars (and any whitespace) to a single space and trims.
 */
function sanitizeOneLine(s: string): string {
  return s
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scan a BOUNDED log tail for the common "couldn't write here" failure shapes
 * and extract an absolute path + a curated reason. Pure + side-effect-free.
 *
 * Recognized shapes (case-insensitive):
 *   - EROFS / "read-only file system"  → reason 'read-only filesystem'
 *   - EACCES / "permission denied"      → reason 'permission denied'
 * The first matching LINE wins; we pull the first absolute-path token on it.
 * Unrecognized input → `{ reason: 'startup failed' }` (no path).
 */
export function extractWritablePathFromLog(
  tail: string,
): { path?: string; reason: string } {
  const bounded = typeof tail === 'string' ? tail.slice(-MAX_TAIL_CHARS) : '';
  // Normalize line endings without trusting them for content.
  const lines = bounded.split(/\r\n|\r|\n/);

  const readOnlyRe = /\bEROFS\b|read-only file ?system/i;
  const permRe = /\bEACCES\b|permission denied/i;
  // An absolute path token: a slash-led run up to whitespace or a quote/colon
  // that commonly terminates a path in these messages.
  const pathTokenRe = /(\/[^\s'":]+)/;

  for (const line of lines) {
    const isReadOnly = readOnlyRe.test(line);
    const isPerm = permRe.test(line);
    if (!isReadOnly && !isPerm) continue;
    const reason = isReadOnly
      ? SERVICE_DIAGNOSIS_REASONS.readOnly
      : SERVICE_DIAGNOSIS_REASONS.permissionDenied;
    const m = pathTokenRe.exec(line);
    const candidate = m?.[1];
    if (candidate !== undefined) {
      const clamped = candidate.slice(0, MAX_PATH_CHARS);
      if (ABSOLUTE_PATH_RE.test(clamped)) {
        return { path: clamped, reason };
      }
    }
    return { reason };
  }
  return { reason: SERVICE_DIAGNOSIS_REASONS.startupFailed };
}

/**
 * Format a diagnosis into the bounded, untrusted-safe, one-line author-facing
 * message. The `path` is included only when it still looks like an absolute
 * path after re-validation (the extractor already checked, but the diagnosis
 * may arrive from anywhere). Everything is sanitized + length-clamped.
 */
export function formatServiceDiagnosis(d: ServiceStartupDiagnosis): string {
  const service = sanitizeOneLine(String(d.service)).slice(0, MAX_SERVICE_CHARS);
  const reason =
    sanitizeOneLine(String(d.reason)).slice(0, MAX_PATH_CHARS) ||
    SERVICE_DIAGNOSIS_REASONS.startupFailed;
  const rawPath =
    typeof d.path === 'string'
      ? sanitizeOneLine(d.path).slice(0, MAX_PATH_CHARS)
      : undefined;
  const path =
    rawPath !== undefined && ABSOLUTE_PATH_RE.test(rawPath) ? rawPath : undefined;

  const svc = service.length > 0 ? `'${service}'` : 'a dev service';
  if (path !== undefined) {
    return `Dev service ${svc} couldn't write ${path} (${reason}) — add ${path} to the service's writablePaths.`;
  }
  return `Dev service ${svc} failed to start (${reason}). If it needs to write to a directory, add that path to the service's writablePaths.`;
}
