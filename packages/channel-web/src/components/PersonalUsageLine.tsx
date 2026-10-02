import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
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
    <div className="px-2.5 py-2 text-xs text-muted-foreground" role="status">
      {failed ? (
        <div className="flex items-center justify-between gap-2">
          <span>Usage unavailable</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFailed(false);
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : usage ? (
        <>
          <p>
            {formatUsd(usage.spendUsd)} of {formatUsd(usage.limits.dailySpendUsd)} used in the last
            24 hours
          </p>
          <p>
            {usage.turnsLastHour} of {usage.limits.turnsPerHour} messages in the last hour
          </p>
        </>
      ) : (
        'Loading your usage…'
      )}
    </div>
  );
}
