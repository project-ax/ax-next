// ---------------------------------------------------------------------------
// activity-phrase — the host-authored tool activity label on the tool-call
// wire shape (TASK-271).
//
// A tool's `activityPhrase` is authored in-repo on its `ToolDescriptor`
// (TASK-229) and reaches the transcript so the UI can render a human-readable
// label instead of a transformed wire identifier. It round-trips through the
// (untrusted) runner, so the host MUST pass it through `sanitizeActivityPhrase`
// at the IPC ingress (see `@ax/ipc-core`'s event validators) before it touches
// storage or an SSE frame — the same treatment as any other agent-authored
// string.
//
// The zod schemas below accept any string on purpose: parsing must never drop
// a whole chunk/block over a hostile phrase. The fence is the sanitizer, not
// the parser.
// ---------------------------------------------------------------------------

/**
 * Display ceiling for a phrase that reaches a user-facing surface. Tool
 * descriptors cap at 40; this matches `@ax/agent-activity`'s status-line
 * fence (60) so both surfaces decline the same input. Truncation here is a
 * hard cut with no ellipsis marker: only hostile (non-descriptor) input can
 * exceed 40, and hostile input gets no typographic courtesy.
 */
export const ACTIVITY_PHRASE_MAX_CHARS = 60;

// ANSI CSI escape sequences (`\u001b[...m` color codes and friends). A phrase
// carrying these would restyle the terminal/log line it lands on.
const ANSI_CSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

// C0/C1 controls (includes \t \r \n) + DEL. Stripped after the first-line
// cut, so interior tabs cannot smuggle column breaks into a one-line label.
const CONTROL_RE = /[\x00-\x1F\x7F-\x9F]/g;

/**
 * Fence a runner-supplied activity phrase for a user-facing surface.
 * Returns the safe single-line label, or `undefined` when there is nothing
 * safe to show (caller omits the field — never an empty string, which would
 * render as a blank label where a fallback name belongs).
 */
export function sanitizeActivityPhrase(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // One line: cut at the first line break rather than joining, so a hostile
  // second line cannot dilute or contradict the first.
  const firstLine = value.split(/[\r\n\u2028\u2029]/, 1)[0] ?? '';
  const clean = firstLine.replace(ANSI_CSI_RE, '').replace(CONTROL_RE, '').trim();
  if (clean.length === 0) return undefined;
  return clean.length > ACTIVITY_PHRASE_MAX_CHARS
    ? clean.slice(0, ACTIVITY_PHRASE_MAX_CHARS)
    : clean;
}
