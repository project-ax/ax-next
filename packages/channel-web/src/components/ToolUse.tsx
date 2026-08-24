/**
 * ToolUse — the per-tool-call detail panels the transcript renders.
 *
 * Two exported pieces, both leaf renderers. `Thread.tsx` chooses between
 * them per tool-call part with `ARTIFACT_PUBLISH_BY_NAME[toolName] ??
 * ToolFallback`:
 *
 *   - `ToolFallback` renders one tool's detail panel — name, raw args
 *     JSON, and either a result or error block. It is the default, so it
 *     covers every tool without a bespoke renderer, and it renders INSIDE
 *     the collapsed chain-of-thought disclosure.
 *
 *   - `ArtifactPublishTool` is the bespoke renderer for `artifact_publish`:
 *     it parses the tool result and shows a downloadable `ArtifactChip`,
 *     degrading to `ToolFallback` on any missing or malformed field. It
 *     renders at the top level, deliberately OUTSIDE the disclosure, so a
 *     download isn't buried (`STANDALONE_TOOL_NAMES` in `Thread.tsx`).
 *
 * There is deliberately NO grouping/disclosure component here. The collapsed
 * "what the assistant did" header a user sees is `ChainOfThought.tsx` (a
 * shadcn `Collapsible`, label from `chainOfThoughtLabel`), which `Thread.tsx`
 * fills by coalescing reasoning + tool-call parts. A rival `ToolGroup` used
 * to live in this file — it was superseded by `ChainOfThought` in PR #307 and
 * then sat unrendered until TASK-269 deleted it. To change what the collapsed
 * header says, edit `ChainOfThought.tsx`; nothing in this file is on that path.
 *
 * Class names like `tstep` are kept as test hooks — no CSS targets them
 * anymore; Tailwind drives the styling.
 */
import type { FC } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { cn } from '@/lib/utils';
import { ArtifactChip } from './ArtifactChip';
import { useConversationId } from '../lib/use-conversation-id';

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
