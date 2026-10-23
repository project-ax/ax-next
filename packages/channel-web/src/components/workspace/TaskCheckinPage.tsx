/**
 * `/workspace/tasks/<agentId>/<routineId>/checkins/<conversationId>` — one
 * task check-in, read-only (See what it did, TASK-911).
 *
 * It says when the check-in ran, why, and the report it ended with, then what
 * the agent said and every tool it ran. The page reads its own check-in
 * (`useTaskCheckin`), so it only fetches while it is mounted; the shell keys it
 * by the check-in's ids, since a refresh keeps what's on screen.
 *
 * NOTHING HERE SENDS. A check-in is a finished, unattended run, and nobody
 * reading it should be able to add to it, stop it or pick it back up. So the
 * transcript is the agent view's own renderer (`AgentConversation`) in
 * `readOnly` mode, which draws no composer (and with it no Stop) and turns
 * "Edit first" off, the one in-thread path that sends. Its `onSend` does
 * nothing anyway, and the page passes no `onStop`, makes no `workspaceApi`
 * write and opens no chat or stream. The only controls it hands the thread are
 * the approval cards' buttons: those cards are the decision queue's own rows,
 * answered exactly as on Today (decisions row 7).
 *
 * AGENT-WRITTEN TEXT IS DRAWN AS TEXT, outside the transcript. The report's
 * update and a failed check-in's reason were written by a model or carry text
 * from outside, and the server fenced both before they left
 * (`server/routes-workspace.ts`). Here they are only React text children:
 * never `dangerouslySetInnerHTML`, never the markdown renderer, so `**bold**`
 * or `<img>` shows as those characters. The task's name is text too, and the
 * one attribute built from it is its crumb's inert `title`. The transcript is
 * drawn only by `AgentConversation`, exactly as the agent view draws it: its
 * markdown shows an image as its alt text, so nothing a model wrote makes the
 * browser fetch, and it leaves file links out of prose.
 */
import { useId, useLayoutEffect, useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { HTTP_SESSION_ENDED } from '@/lib/http';
import { readAlertVariant } from '@/lib/read-register';
import { routeLinkProps } from '@/lib/route-link';
import { TASK_GROUP_LABELS } from '@/lib/task-groups';
import { updateText } from '@/lib/task-updates';
import type { DecisionQueue } from '@/lib/workspace-decisions';
import type { WorkspaceGrant } from '@/lib/workspace-grant-store';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import type { TaskReadError } from '@/lib/workspace-task';
import { useTaskCheckin } from '@/lib/workspace-task-checkin';
import { checkInWhen } from '@/lib/workspace-time';
import type { TaskCheckin } from '@/lib/workspace-types';
import { AgentConversation, approvalReadFrom } from './AgentConversation';
import { StateDot, StateDotSlot } from './bits';
import { WorkspaceHeader } from './WorkspaceHeader';

const LOAD_COPY: Record<TaskReadError, string> = {
  failed: 'We couldn’t load this check-in just now. Nothing was lost.',
  gone: 'We couldn’t find this check-in. It may be too old to open here, or it belongs to someone else.',
  expired: HTTP_SESSION_ENDED,
};
const REFRESH_FAILED =
  'We couldn’t refresh this check-in just now, so what you see may be out of date.';
const NOTHING_ELSE = 'There’s nothing else to show from this check-in.';
const NO_REASON = 'No reason was recorded.';

/**
 * Why it ran. A manual start says only that it wasn't the schedule: Check now
 * and the agent's own start both record `manual`, and nothing says which, so
 * naming either would be a guess (decisions row 10).
 */
const WHY: Record<TaskCheckin['triggerSource'], string> = {
  tick: 'On its schedule',
  manual: 'Started outside its schedule',
  webhook: 'Started by an update from another app',
};

/**
 * Sends nothing. `readOnly` draws no composer and this page holds no way to
 * send, so a composer drawn by mistake would still reach nothing.
 */
const NO_SEND = (): void => {};
/**
 * No permission requests here. Presence routes a grant only to the agent's own
 * thread, and Today shows every one, so there is nothing for this page to add.
 */
const NO_GRANTS: readonly WorkspaceGrant[] = [];
/** `onGrantResolved` for a thread that draws no grants: nothing can call it. */
const IGNORE = (): void => {};
/** `onGranted` for a thread that draws no grants: nothing is picked back up from here. */
const NOT_GRANTED = async (): Promise<boolean> => false;

export function TaskCheckinPage({
  agentId,
  routineId,
  conversationId,
  leading,
  onNavigate,
  decisions,
  onApprove,
  onDismiss,
  onUndo,
  busyIds,
  notices,
  decisionsError,
  onRetryDecisions,
}: {
  agentId: string;
  routineId: string;
  conversationId: string;
  leading?: ReactNode;
  onNavigate: (route: WorkspaceRoute) => void;
  /*
    The decision queue's own members, typed as the queue types them. AgentView
    types `onApprove` as `(id) => void` but hands `queue.approve` straight
    through, so Always Allow's scope still reaches the server there; only the
    type is narrower. Typed as the queue's own, the scope is visible here too.
  */
  decisions: DecisionQueue['decisions'];
  onApprove: DecisionQueue['approve'];
  onDismiss: DecisionQueue['dismiss'];
  onUndo: DecisionQueue['undo'];
  busyIds?: DecisionQueue['busyIds'];
  notices?: DecisionQueue['notices'];
  decisionsError: DecisionQueue['error'];
  onRetryDecisions: () => void;
}) {
  const { state, refresh } = useTaskCheckin(agentId, routineId, conversationId);
  const page = state.kind === 'ready' ? state.page : null;
  // The time in the title is read against the clock when the check-in last
  // arrived, not when the page first opened (`TaskBody`'s rule). A layout
  // effect, so a stale time never reaches the screen.
  const [now, setNow] = useState(() => new Date());
  useLayoutEffect(() => setNow(new Date()), [page]);
  const when = page === null ? null : checkInWhen(page.checkIn.firedAt, now);

  return (
    <>
      <WorkspaceHeader
        title={when === null ? 'Check-in' : `Check-in ${when}`}
        leading={
          <>
            {leading}
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <a {...routeLinkProps({ kind: 'tasks' }, onNavigate)}>Tasks</a>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <a
                      {...routeLinkProps({ kind: 'task', agentId, routineId }, onNavigate)}
                      className="max-w-[16rem] truncate"
                      title={page?.taskName}
                    >
                      {page?.taskName ?? 'Task'}
                    </a>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </BreadcrumbList>
            </Breadcrumb>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {state.kind !== 'ready' ? (
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 px-6 pb-6">
              {state.kind === 'loading' ? (
                <div className="flex justify-center py-10">
                  <Spinner />
                </div>
              ) : (
                <CheckinLoadFailure error={state.error} onRetry={refresh} />
              )}
            </div>
          </div>
        ) : (
          <>
            {/*
              No title: this sits over a check-in the page can still show, and
              it knows nothing about what it couldn't load (`lib/read-register.ts`).
            */}
            {state.refreshFailed && (
              <div className="px-6 pt-4">
                <Alert variant="destructive">
                  <AlertDescription className="flex flex-wrap items-center gap-3">
                    <span className="min-w-0">{REFRESH_FAILED}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="ml-auto"
                      onClick={refresh}
                      disabled={state.refreshing}
                    >
                      Try again
                    </Button>
                  </AlertDescription>
                </Alert>
              </div>
            )}
            <CheckinSummary page={state.page} />
            {state.page.thread.length === 0 ? (
              <p className="mx-auto w-full max-w-[900px] px-6 py-6 text-[13px] text-muted-foreground">
                {NOTHING_ELSE}
              </p>
            ) : (
              /*
                No `busy`, `onStop` or `stopping`: nothing is running here, since
                a check-in reaches Updates only once it has finished. No
                `conversationKey`: the shell mounts this page once per check-in,
                so the thread never swaps under it. `settling` and
                `failureStripShown` only quiet the empty-thread welcome, which
                `readOnly` never draws. The conversation id is the one the
                server found (it trims what it is handed), not the address as
                typed, since file downloads are scoped by it. It is never null
                here (the server answers only for a check-in with that id);
                null would still fail safe: the agent's files wouldn't be
                drawn, rather than download under the address as typed.
              */
              <AgentConversation
                agent={{ id: agentId, name: state.page.agentName }}
                thread={state.page.thread}
                conversationId={state.page.checkIn.conversationId ?? null}
                decisions={decisions}
                readOnly
                onSend={NO_SEND}
                onApprove={onApprove}
                onDismiss={onDismiss}
                onUndo={onUndo}
                {...(busyIds !== undefined ? { busyIds } : {})}
                {...(notices !== undefined ? { notices } : {})}
                approvalRead={approvalReadFrom(state.page.decisions.status, decisionsError)}
                onRetryApprovals={() => {
                  onRetryDecisions();
                  refresh();
                }}
                grants={NO_GRANTS}
                onGrantResolved={IGNORE}
                onGranted={NOT_GRANTED}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * The page couldn't load at all. A failed read is ours to retry. A check-in
 * that isn't there (or isn't yours: the route answers 404 alike) and an ended
 * session offer no button, since pressing again can't fix either
 * (`lib/read-register.ts`). The crumbs above still lead back.
 */
function CheckinLoadFailure({ error, onRetry }: { error: TaskReadError; onRetry: () => void }) {
  return (
    <Alert variant={readAlertVariant(error)}>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span className="min-w-0">{LOAD_COPY[error]}</span>
        {error === 'failed' && (
          <Button variant="secondary" size="sm" className="ml-auto" onClick={onRetry}>
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * How the check-in went, in the agent view's past-conversation banner frame:
 * its mark and group word, what it said (an Updates entry's words), why it
 * failed when it did, and who ran it, why, and that this is read-only. People
 * see no reply box, so the last line says why.
 */
function CheckinSummary({ page }: { page: TaskCheckin }) {
  const headingId = useId();
  const { checkIn } = page;
  const { report } = checkIn;
  return (
    <section
      aria-labelledby={headingId}
      className="flex shrink-0 flex-col gap-1 border-b border-border bg-muted px-6 py-3"
    >
      <h2 id={headingId} className="sr-only">
        How this check-in went
      </h2>
      {report !== null ? (
        <>
          <p className="flex items-center gap-2 text-[12.5px] font-medium">
            <StateDotSlot>
              <StateDot state={report.status} />
            </StateDotSlot>
            <span>{TASK_GROUP_LABELS[report.status]}</span>
          </p>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
            {updateText(checkIn)}
          </p>
        </>
      ) : (
        <p className="flex items-center gap-2 text-[13px] leading-relaxed">
          <StateDotSlot>
            <StateDot state="no-update" />
          </StateDotSlot>
          <span className="min-w-0 whitespace-pre-wrap break-words">{updateText(checkIn)}</span>
        </p>
      )}
      {checkIn.status === 'error' && (
        <p className="whitespace-pre-wrap break-words text-[12px] text-muted-foreground">
          {checkIn.error ?? NO_REASON}
        </p>
      )}
      <p className="break-words text-[12px] text-muted-foreground">
        {`${page.agentName} · ${WHY[page.triggerSource]} · read-only`}
      </p>
    </section>
  );
}
