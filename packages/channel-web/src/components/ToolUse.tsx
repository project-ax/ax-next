/**
 * ToolUse — tool-call rendering per design.
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
 * NOTE (TASK-260): `ToolGroup` is NOT on the live render path. `Thread.tsx`
 * imports only `ArtifactPublishTool` and `ToolFallback`; tool-call parts are
 * folded into the chain-of-thought disclosure, whose collapsed header comes
 * from `chainOfThoughtLabel` in `ChainOfThought.tsx`. `ToolGroup` and its
 * `VERB_MAP` are exercised only by this component's own test today. Left in
 * place rather than deleted in a bug-fix card, but do not reach for `VERB_MAP`
 * expecting a user to see the result — a follow-up card owns reviving or
 * removing it.
 *
 * Class names like `tgroup`, `tgroup-body`, `tgroup-title`, `tstep` are
 * kept as test hooks — no CSS targets them anymore; Tailwind drives
 * the styling.
 */
import type { FC, PropsWithChildren } from 'react';
import { useMemo, useState } from 'react';
import { useMessage } from '@assistant-ui/react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { cn } from '@/lib/utils';
import { ArtifactChip } from './ArtifactChip';
import { useConversationId } from '../lib/use-conversation-id';

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
  const bodyId = `tgroup-body-${startIndex}-${endIndex}`;
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
    <div
      className={cn(
        'tgroup flex flex-col my-3.5 max-w-[60ch] font-sans text-muted-foreground',
        '[&+.tgroup]:-mt-2',
        status,
        open && 'open',
      )}
      data-testid="tool-group"
    >
      <button
        type="button"
        className="
          tgroup-head inline-flex items-center gap-1.5 cursor-pointer
          text-[14px] leading-[1.4] text-muted-foreground transition-colors
          hover:text-foreground
          focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/50 focus-visible:outline-offset-2 focus-visible:rounded-sm
        "
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tgroup-title break-words">{phrase}</span>
        <svg
          viewBox="0 0 11 11"
          aria-hidden="true"
          width="11"
          height="11"
          className={cn(
            'shrink-0 mt-px transition-[transform,color] duration-150',
            'text-ink-ghost',
            open && status !== 'running' && 'rotate-90 text-muted-foreground',
            status === 'running' && 'animate-spin text-primary',
            status === 'failed' && 'text-destructive',
          )}
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
      <div
        id={bodyId}
        className="tgroup-body mt-2 ml-0.5 pl-3.5 border-l border-border"
        role="region"
        hidden={!open}
      >
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

const STEP_LABEL_CLASS =
  'uppercase text-[9.5px] tracking-[0.14em] text-ink-ghost mt-1.5 mb-0.5';

/**
 * The settled state has NO word (TASK-260).
 *
 * `done` was the one element in this panel that made a claim rather than
 * reporting — and it is not always a true one. A tool call HELD for a person's
 * approval has not run; its body says "Nothing has happened yet", and a `DONE`
 * badge one line above that is a contradiction in adjacent pixels. Deleting the
 * word costs nothing on the happy path, because the presence of a result block
 * IS the completion signal and the absence of an error block IS the not-failed
 * signal — and it removes a console-vocabulary shout from every tool call in
 * the product, not just the held ones.
 *
 * The two states that remain are sentence-cased for the same reason: a
 * non-technical user did not cause them and should not be shouted at about
 * them.
 *
 * There is deliberately no third `Waiting` state here. Detecting a hold
 * client-side would mean string-matching the runner's host-authored constant,
 * which puts two packages in charge of one sentence — the exact failure
 * `workspace/decision-copy.ts` was written to prevent. A real hold state needs
 * a persisted flag first, and that is its own card.
 */
const STATUS_WORD: Record<'running' | 'failed', string> = {
  running: 'Running',
  failed: 'Failed',
};

export const ToolFallback: FC<ToolCallMessagePartProps> = (p) => {
  const status = stepStatus(p);
  return (
    <div
      className="
        tstep px-2.5 py-2 rounded-md bg-muted
        font-mono text-[11px] leading-[1.55] text-muted-foreground
        whitespace-pre-wrap break-words
        [&+.tstep]:mt-1.5
      "
      data-testid="tool-step"
    >
      <div className="tstep-name text-primary font-medium mb-1">
        {p.toolName}
        {status !== 'done' ? (
          <span
            className={cn(
              'tstep-status ml-2 font-sans font-normal text-[11px]',
              status === 'running' ? 'text-primary' : 'text-destructive',
            )}
          >
            {STATUS_WORD[status]}
          </span>
        ) : null}
      </div>
      <div className={STEP_LABEL_CLASS}>args</div>
      <div className="tstep-args">{formatJSON(p.args)}</div>
      {status === 'failed' ? (
        <>
          <div className={STEP_LABEL_CLASS}>error</div>
          <div className="tstep-error">{formatJSON(p.result) || 'failed'}</div>
        </>
      ) : status === 'done' && p.result !== undefined ? (
        <>
          <div className={STEP_LABEL_CLASS}>result</div>
          {/*
           * A string result is PROSE; an object result is DATA (TASK-260). The
           * panel is monospace because most tool output is JSON, but a tool
           * that returns a sentence — a held call's "Waiting for you to
           * choose…", an error explanation, a summary — reads as a code dump
           * at 11px mono. Typeof is the whole heuristic: no tool-name list to
           * go stale, and it improves every string-returning tool rather than
           * special-casing one.
           */}
          <div
            className={cn(
              'tstep-result',
              typeof p.result === 'string' && 'font-sans text-[13px] leading-[1.5]',
            )}
          >
            {formatJSON(p.result)}
          </div>
        </>
      ) : null}
    </div>
  );
};

/**
 * Result shape emitted by the `artifact_publish` runner tool. We don't trust
 * the assistant — every field is treated as optional and the chip falls back
 * to the standard tool panel if anything's missing or malformed.
 */
interface ArtifactPublishToolResult {
  artifactId?: string;
  downloadUrl?: string;
  path?: string;
  displayName?: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256?: string;
}

/**
 * Custom renderer for the `artifact_publish` tool. Parses the tool's JSON
 * result and renders an inline `ArtifactChip` so the user can download the
 * published file straight from the transcript. Any failure path (still
 * running, errored, parse-failed, missing fields, missing conversation
 * context) falls back to the standard `ToolFallback` panel — the user
 * still sees what happened, just without the chip affordance.
 */
/**
 * The tool result may arrive as a JSON string, an already-parsed object, or
 * the SDK/MCP ARRAY shape `[{type:'text', text:<json>}]` that the runner
 * persists for an artifact_publish result (TASK-77). Return the first
 * candidate object that parses, or null. Array entries that aren't `text`
 * blocks (e.g. images) are skipped.
 */
function parseArtifactResult(result: unknown): ArtifactPublishToolResult | null {
  const texts: string[] = [];
  if (typeof result === 'string') {
    texts.push(result);
  } else if (Array.isArray(result)) {
    for (const entry of result) {
      if (
        entry &&
        typeof entry === 'object' &&
        (entry as { type?: unknown }).type === 'text' &&
        typeof (entry as { text?: unknown }).text === 'string'
      ) {
        texts.push((entry as { text: string }).text);
      }
    }
  } else if (result && typeof result === 'object') {
    // Already-parsed object — re-serialize so the single parse path below
    // applies uniformly.
    texts.push(JSON.stringify(result));
  }
  for (const text of texts) {
    try {
      return JSON.parse(text) as ArtifactPublishToolResult;
    } catch {
      /* not JSON — try the next candidate */
    }
  }
  return null;
}

export const ArtifactPublishTool: FC<ToolCallMessagePartProps> = (p) => {
  const conversationId = useConversationId();
  if (p.status?.type === 'running' || p.result === undefined) {
    return <ToolFallback {...p} />;
  }
  if (p.isError === true) {
    return <ToolFallback {...p} />;
  }
  const parsed = parseArtifactResult(p.result);
  if (
    !parsed ||
    conversationId === null ||
    typeof parsed.path !== 'string' ||
    typeof parsed.displayName !== 'string' ||
    typeof parsed.mediaType !== 'string' ||
    typeof parsed.sizeBytes !== 'number'
  ) {
    return <ToolFallback {...p} />;
  }
  return (
    <ArtifactChip
      variant="inline"
      conversationId={conversationId}
      path={parsed.path}
      displayName={parsed.displayName}
      mediaType={parsed.mediaType}
      sizeBytes={parsed.sizeBytes}
      {...(parsed.artifactId !== undefined && { artifactId: parsed.artifactId })}
    />
  );
};
