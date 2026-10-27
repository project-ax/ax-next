import type { RepeatTaskState } from '@/lib/workspace-types';
import { timeAgo } from '@/lib/workspace-time';

/** Host observations, never an invented agent report. */
export function RepeatRunSummary({ run, enabled, now }: { run: RepeatTaskState | undefined; enabled: boolean; now: Date }) {
  if (run === undefined) return <p>Run details are unavailable.</p>;
  const line = !enabled ? 'Paused.' : (run.active ?? 0) > 0 ? 'Working.'
    : run.status === 'error' ? 'Last run failed.' : run.status === 'silenced' ? 'Last run finished quietly.'
    : run.status === 'ok' ? 'Last run completed.' : 'No completed runs yet.';
  return <>
    <p className="text-sm">{line}</p>
    {run.lastRunAt !== null && <p className="text-sm text-muted-foreground">Last run {timeAgo(run.lastRunAt, now)}</p>}
    {run.active !== null && run.active > 0 && <p className="text-sm text-muted-foreground">{run.active} {run.active === 1 ? 'run active' : 'runs active'}{!enabled ? ' · finishing after Pause' : ''}</p>}
    {run.waiting !== null && run.waiting > 0 && <p className="text-sm text-muted-foreground">{run.waiting} {run.waiting === 1 ? 'app update waiting' : 'app updates waiting'}</p>}
    {run.status === 'error' && run.error !== null && <p className="text-sm">{run.error}</p>}
    {run.warning !== null && <p className="text-sm text-muted-foreground">{run.warning}</p>}
  </>;
}
