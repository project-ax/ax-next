import { useEffect, useState } from 'react';
import { RoutineWebhookStatusOutputSchema, type RoutineWebhookStatus, type WebhookDetectedApp, type WebhookRefusalReason } from '@ax/routines-contract';
import { routineApi } from '@/lib/routines';
import { AsyncState } from '@project-ax/ui';
import { Button } from '@/components/ui/button';
const reasons: Record<WebhookRefusalReason, string> = {
  signature: 'the signature didn’t match. Check the signing secret',
  secret: 'the signing secret wasn’t available. Save it and try again',
  'invalid-body': 'the update couldn’t be read', 'unsupported-content': 'the app sent an unsupported format',
  'event-filter': 'the event wasn’t selected in app setup', 'delivery-id': 'the delivery ID wasn’t valid',
  capacity: 'the update queue or storage limit was reached. The app can retry later',
  unavailable: 'the task couldn’t accept updates just then. The app can retry later',
  paused: 'the task was paused or done', 'too-large': 'the update was larger than 1 MB',
};
/** The app the host detected from a delivery's signature (TASK-1026). */
const apps: Record<WebhookDetectedApp, string> = { stripe: 'Stripe', slack: 'Slack', zendesk: 'Zendesk', github: 'GitHub', linear: 'Linear', other: 'Signed app' };
const time = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
/** Remount this read when private setup changes. Failed refreshes clear earlier connection claims. */
export function TaskAppConnection({ agentId, routineId }: { agentId: string; routineId: string }) {
  const [status, setStatus] = useState<RoutineWebhookStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus(null); setFailed(false);
    void routineApi.getWebhookStatus({ agentId, routineId }).then(raw => {
      const value = RoutineWebhookStatusOutputSchema.parse(raw);
      if (value.agentId !== agentId || value.routineId !== routineId) throw new Error('Scope changed');
      if (active) setStatus(value);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [agentId, routineId, generation]);
  const refresh = () => { setStatus(null); setFailed(false); setGeneration(value => value + 1); };
  const name = status?.app ? apps[status.app] : 'App';
  // Evidence saved before app detection has a checked signature but no app, so whether it had a timestamp is unknown.
  const timestampUnknown = status?.app === null;
  const noTimestamp = !!status?.signatureChecked && !status.timestampChecked && !timestampUnknown;
  return <div className="flex min-w-0 flex-col gap-3">
    <p className="text-sm">Send a test from the other app’s webhook settings, then check the connection here. An accepted test follows the task’s usual update rules and may start paid work.</p>
    {failed ? <AsyncState status="error" skeleton="lines" loadingLabel="Checking app connection"
      error={{ message: 'We couldn’t check the connection.', onRetry: refresh }} />
      : status ? <div className="flex flex-col gap-2" role="status">
        <p className="text-sm">{status.lastAcceptedAt ? <>{name} connected · last accepted update {time(status.lastAcceptedAt)} · {status.signatureChecked ? (noTimestamp ? 'signature checked, no timestamp' : 'signature checked') : 'signature not checked'}</>
          : status.verifiedAt ? <>{name} address verified {time(status.verifiedAt)} · Waiting for the first update</>
            : status.setupReady ? 'Waiting for the first update' : 'Waiting for setup'}</p>
        {status.lastAcceptedAt && noTimestamp && <p className="text-sm text-muted-foreground">This app doesn’t sign the time it sent each update, so we can’t spot an old update that’s sent again.</p>}
        {status.lastAcceptedAt && <p className="text-sm text-muted-foreground">Accepted means safely received. Check Updates for the check-in’s result.</p>}
        {status.refusals.length > 0 && <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <p>Updates turned away since {time(status.windowStart)}:</p>
          <ul className="list-disc pl-5">{status.refusals.map(item => <li key={item.reason}>{item.count} because {reasons[item.reason]}.</li>)}</ul>
        </div>}
      </div> : <AsyncState status="loading" skeleton="lines" loadingLabel="Checking app connection" />}
    <Button type="button" variant="outline" className="self-start" disabled={!status && !failed} onClick={refresh}>Check connection</Button>
  </div>;
}
