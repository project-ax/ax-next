/**
 * DecisionRequestBlock — which tool a held call names and the input the agent
 * wrote for it (TASK-699).
 *
 * An approval that does not show what it approves is a rubber stamp: before
 * this, a held MCP call read "Wants to use mcp.github.create_issue" over
 * "Yes, go ahead / No", and the person had no way to see WHAT issue. Both
 * renderers of an open decision — the in-thread `ApprovalCard` and the Today
 * queue's `DecisionRow` — draw this one block, so they cannot disagree.
 *
 * EVERY STRING HERE IS AGENT-AUTHORED DATA, not our voice. It is drawn as plain
 * React text in a monospace block (React escapes it; there is no HTML and no
 * markdown path), it is already fenced and capped on the server
 * (`wireRequest` in `server/routes-workspace.ts`), and nothing here ever hands
 * it back anywhere as if a person had written it — which is why "Edit first"
 * stays keyed to the host-authored `preview`, never to this.
 */
import type { Decision } from '@/lib/workspace-api';

export const DECISION_REQUEST_HEADING = 'What it wants to run';
export const DECISION_REQUEST_NO_INPUT = 'No details were sent with this one.';
export const DECISION_REQUEST_TRUNCATED = 'This is only the beginning. The full request is longer.';
export const DECISION_REQUEST_PROVENANCE =
  'Written by the agent. Have a read before you say yes.';

export function DecisionRequestBlock({
  request,
  className = '',
}: {
  request: NonNullable<Decision['request']>;
  className?: string;
}) {
  return (
    <div
      data-testid="decision-request"
      className={`rounded-md border border-border bg-muted px-3.5 py-2.5 ${className}`}
    >
      <div className="text-[11.5px] text-muted-foreground">{DECISION_REQUEST_HEADING}</div>
      <code
        data-testid="decision-request-tool"
        className="mt-0.5 block break-all font-mono text-[12.5px] text-foreground"
      >
        {request.tool}
      </code>
      {request.input !== null ? (
        <pre
          data-testid="decision-request-input"
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-background px-2.5 py-2 font-mono text-[12px] leading-relaxed text-foreground"
        >
          {request.input}
        </pre>
      ) : (
        <p className="mt-1.5 text-[12px] text-muted-foreground">{DECISION_REQUEST_NO_INPUT}</p>
      )}
      {request.truncated && (
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">{DECISION_REQUEST_TRUNCATED}</p>
      )}
      <p className="mt-1.5 text-[11.5px] text-muted-foreground">{DECISION_REQUEST_PROVENANCE}</p>
    </div>
  );
}
