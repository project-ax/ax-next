/**
 * ToolUse — tool-call rendering per Tide design.
 *
 * Two pieces:
 *
 *   - `ToolGroup` wraps consecutive tool-call parts. It renders a single
 *     summary header — a comma-joined past-tense verb phrase (e.g.
 *     "Searched the web, read the file") plus a chevron — and toggles a
 *     body that contains the per-tool detail panels (`ToolFallback`
 *     children rendered by assistant-ui's MessageParts).
 *
 *   - `ToolFallback` renders one tool's detail panel — name, raw args
 *     JSON, and either a result or error block. Used as the
 *     `tools.Fallback` for unknown tool names.
 *
 * The header verb-mapping is best-effort. Known tool ids from the Tide
 * mock get a hand-tuned phrase; anything else falls back to the tool
 * name's last segment ("github.search_issues" → "ran search issues").
 *
 * Reference: design_handoff_tide/Tide Sessions.html, `.msg-tools` /
 * `.tgroup` / `.tstep` block.
 */
import type { FC, PropsWithChildren } from 'react';
import { useMemo, useState } from 'react';
import { useMessage } from '@assistant-ui/react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';

const VERB_MAP: Record<string, string> = {
  'email.search': 'searched email',
  'email.read': 'read the thread',
  'email.send': 'sent a reply',
  'calendar.read': 'checked your calendar',
  'calendar.create': 'held time on your calendar',
  'slack.search': 'searched slack',
  'drive.find': 'found a file',
  'drive.read': 'read the file',
  'drive.write': 'updated the file',
  'web.search': 'searched the web',
  'web.read': 'read the page',
  'flights.search': 'priced flights',
  'finance.read': 'pulled numbers',
  'linear.search': 'searched linear',
  'linear.create': 'opened a ticket',
};

const toolVerb = (name: string): string => {
  if (VERB_MAP[name]) return VERB_MAP[name];
  const tail = name.includes('.') ? name.split('.').slice(1).join(' ') : name;
  return `ran ${tail.replace(/_/g, ' ')}`;
};

/** "searched email, read the thread" — first verb sentence-cased, dedupe adjacent. */
const headerPhrase = (toolNames: readonly string[]): string => {
  const verbs = toolNames.map(toolVerb);
  const dedup: string[] = [];
  for (const v of verbs) if (dedup[dedup.length - 1] !== v) dedup.push(v);
  const first = dedup[0];
  if (!first) return 'thinking';
  dedup[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return dedup.join(', ');
};

type GroupStatus = 'running' | 'failed' | 'done';

type ToolPart = {
  type: 'tool-call';
  toolName: string;
  isError?: boolean;
  status?: { type?: string };
};

const isToolPart = (p: unknown): p is ToolPart =>
  !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'tool-call';

const computeGroupStatus = (parts: readonly ToolPart[]): GroupStatus => {
  if (parts.some((p) => p.status?.type === 'running')) return 'running';
  if (parts.some((p) => p.isError || p.status?.type === 'incomplete')) return 'failed';
  return 'done';
};

type GroupProps = PropsWithChildren<{ startIndex: number; endIndex: number }>;

const EMPTY_PARTS: readonly unknown[] = Object.freeze([]);

export const ToolGroup: FC<GroupProps> = ({ startIndex, endIndex, children }) => {
  const [open, setOpen] = useState(false);
  // useMessage selectors must return stable references — useSyncExternalStore
  // bails out when the previous and next snapshots are not identical (===),
  // so `m.parts ?? []` would allocate a new empty array on every call and
  // loop forever. The frozen singleton keeps that path stable; the live
  // `m.parts` reference is stable across renders when content doesn't change.
  const parts = useMessage(
    (m) => (m as { content?: readonly unknown[] }).content ?? EMPTY_PARTS,
  );
  const slice = useMemo(
    () => parts.slice(startIndex, endIndex + 1).filter(isToolPart),
    [parts, startIndex, endIndex],
  );

  const status = computeGroupStatus(slice);
  const phrase = headerPhrase(slice.map((p) => p.toolName));

  return (
    <div className={`tgroup ${status}${open ? ' open' : ''}`} data-testid="tool-group">
      <button
        type="button"
        className="tgroup-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tgroup-title">{phrase}</span>
        <svg
          className="tgroup-chev"
          viewBox="0 0 11 11"
          aria-hidden="true"
          width="11"
          height="11"
        >
          <path
            d="M3.5 2 L7.5 5.5 L3.5 9"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div className="tgroup-body" role="region">
        {children}
      </div>
    </div>
  );
};

const formatJSON = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

const stepStatus = (p: ToolCallMessagePartProps): 'running' | 'failed' | 'done' => {
  if (p.status?.type === 'running') return 'running';
  if (p.isError || p.status?.type === 'incomplete') return 'failed';
  return 'done';
};

export const ToolFallback: FC<ToolCallMessagePartProps> = (p) => {
  const status = stepStatus(p);
  return (
    <div className="tstep" data-testid="tool-step">
      <div className="tstep-name">
        {p.toolName}
        <span className={`tstep-status ${status}`}>{status}</span>
      </div>
      <div className="tstep-label">args</div>
      <div className="tstep-args">{formatJSON(p.args)}</div>
      {status === 'failed' ? (
        <>
          <div className="tstep-label">error</div>
          <div className="tstep-error">
            {formatJSON(p.result) || 'failed'}
          </div>
        </>
      ) : status === 'done' && p.result !== undefined ? (
        <>
          <div className="tstep-label">result</div>
          <div className="tstep-result">{formatJSON(p.result)}</div>
        </>
      ) : null}
    </div>
  );
};
