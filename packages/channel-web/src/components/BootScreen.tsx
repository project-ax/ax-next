/**
 * BootScreen — what the product looks like before it can show you anything.
 *
 * There were three of these, each a bare centred `<div>` in lowercase mono:
 * `connecting…`, `loading your agents…`, `creating your agent…`. Together they
 * are the first thing a new user ever sees, and they read like a terminal
 * waiting on a socket rather than an app getting ready (audit B6).
 *
 * Two fixes, and the second matters more than the typography:
 *
 *   1. Sentence case, plain words, and the brand mark — so the wait looks like
 *      part of the product instead of a debug screen.
 *
 *   2. A way out. `App`'s boot fetch has no timeout, so a host that accepts the
 *      connection and then never answers left the SPA on `connecting…`
 *      **forever**, with nothing on screen suggesting anything was wrong or
 *      that reloading might help. After `slowHintAfterMs` we say so.
 *
 * The hint is opt-out (`slowHintAfterMs={null}`) for waits that are legitimately
 * long and already have their own error path — spawning a fresh agent, for one.
 * Crying wolf at ten seconds on a job that honestly takes thirty is its own kind
 * of lie.
 */
import { useEffect, useState } from 'react';
import { BrandMark } from './BrandMark';

/** How long a boot wait may run before we admit something may be wrong. */
export const BOOT_SLOW_HINT_MS = 10_000;

export const BOOT_SLOW_HINT = 'This is taking longer than usual — try reloading.';

export function BootScreen({
  message,
  slowHintAfterMs = BOOT_SLOW_HINT_MS,
}: {
  message: string;
  /** `null` disables the hint for waits that are expected to be long. */
  slowHintAfterMs?: number | null;
}) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (slowHintAfterMs === null) return;
    const t = setTimeout(() => setSlow(true), slowHintAfterMs);
    return () => clearTimeout(t);
  }, [slowHintAfterMs]);

  return (
    <div
      className="flex flex-col items-center justify-center gap-3 min-h-screen p-6 text-center"
      data-testid="boot-screen"
    >
      <BrandMark size="xl" />
      <p className="text-[13px] tracking-[-0.005em] text-muted-foreground">{message}</p>
      {slow && (
        <p className="text-[12.5px] text-muted-foreground/80 max-w-[280px]">
          {BOOT_SLOW_HINT}
        </p>
      )}
    </div>
  );
}
