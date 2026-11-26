import { useEffect, useState } from 'react';
import { AsyncState, Notice } from '@project-ax/ui';
import { fetchOwnUsage, type PersonalUsage } from '@/lib/usage-admin';
import { formatUsd } from '@/lib/usage-copy';

/** Mounted inside the account menu: read only the authenticated user's totals. */
export function PersonalUsageLine() {
  const [usage, setUsage] = useState<PersonalUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const value = await fetchOwnUsage();
        if (live) {
          setUsage(value);
          setFailed(false);
        }
      } catch {
        if (live) setFailed(true);
      }
    };
    void read();
    const timer = setInterval(() => void read(), 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [attempt]);
  return (
    <div className="px-2.5 py-2 text-xs text-muted-foreground">
      {failed ? (
        <Notice
          tone="danger"
          action={{
            label: 'Try again',
            onClick: () => {
              setFailed(false);
              setAttempt((n) => n + 1);
            },
          }}
        >
          Usage unavailable
        </Notice>
      ) : usage ? (
        <div role="status">
          <p>
            {formatUsd(usage.spendUsd)} of {formatUsd(usage.limits.dailySpendUsd)} used in the last
            24 hours
          </p>
          <p>
            {usage.turnsLastHour} of {usage.limits.turnsPerHour} messages in the last hour
          </p>
        </div>
      ) : (
        <AsyncState status="loading" skeleton="lines" loadingLabel="Loading your usage" />
      )}
    </div>
  );
}
