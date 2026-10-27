import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { routeLinkProps } from '@/lib/route-link';
import { checkInWhen } from '@/lib/workspace-time';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import type { TaskDetail } from '@/lib/workspace-types';
import { RepeatRunSummary } from './RepeatRunSummary';

export function RepeatTaskBody({ detail, agentId, routineId, refreshFailed, onRefresh, onEdit, onNavigate, notice }: {
  detail: TaskDetail; agentId: string; routineId: string; refreshFailed: boolean; onRefresh: () => void;
  onEdit: () => void; onNavigate: (route: WorkspaceRoute) => void;
  notice: { failed: string; register: 'default' | 'destructive' } | null;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(timer); }, []);
  const occurrences = new Map<string, number>();
  return <>
    {refreshFailed && <Alert variant="destructive"><AlertDescription>We couldn’t refresh this job.
      <Button variant="outline" onClick={onRefresh}>Try again</Button></AlertDescription></Alert>}
    {notice !== null && <Alert variant={notice.register}><AlertDescription>{notice.failed}</AlertDescription></Alert>}
    <p className="text-sm text-muted-foreground">{detail.agentName} · Repeat a job</p>
    <div role="status" className="flex flex-col gap-1"><RepeatRunSummary run={detail.repeat} enabled={detail.enabled} now={now} /></div>
    <dl className="flex flex-col gap-3">
      <div><dt className="text-sm text-muted-foreground">When it runs</dt><dd className="text-sm">{detail.schedule ?? 'No schedule saved.'}</dd></div>
      <div><dt className="text-sm text-muted-foreground">Next scheduled run</dt><dd className="text-sm">{detail.nextCheckAt === null ? 'None scheduled.' : checkInWhen(detail.nextCheckAt, now)}</dd></div>
      <div><dt className="text-sm text-muted-foreground">What {detail.agentName} does</dt><dd className="whitespace-pre-wrap break-words text-sm">{detail.brief.promptBody ?? 'No instructions saved.'}</dd></div>
    </dl>
    {detail.permissions.edit && <Button variant="outline" className="self-start" onClick={onEdit}>Edit task</Button>}
    {detail.repeat?.sharedThread && <p className="text-sm text-muted-foreground">This job uses a shared thread. A transcript can include several runs.</p>}
    <section className="flex flex-col gap-3" aria-label="Run history"><h2 className="text-sm font-medium">Run history</h2>
      {detail.updates.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : <ul className="flex flex-col gap-3">
        {detail.updates.map(update => {
          // Equal concurrent shared-thread results are visually identical; keep other rows stable.
          const identity = JSON.stringify(update); const ordinal = occurrences.get(identity) ?? 0; occurrences.set(identity, ordinal + 1);
          return <li key={`${identity}:${ordinal}`} className="flex flex-col gap-1 border-b border-border pb-3">
            <p className="text-sm">{checkInWhen(update.firedAt, now)} · {update.status === 'error' ? 'Failed' : update.status === 'silenced' ? 'Finished quietly' : 'Completed'}</p>
            {update.status === 'error' && <p className="text-sm">{update.error ?? 'The run failed without a recorded reason.'}</p>}
            {update.conversationId !== null && <a className="self-start text-sm underline underline-offset-2"
              {...routeLinkProps({ kind: 'task-checkin', agentId, routineId, conversationId: update.conversationId }, onNavigate)}>See what it did</a>}
          </li>;
        })}
      </ul>}
    </section>
  </>;
}
