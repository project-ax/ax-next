import { SafeToolError } from '@ax/core';

/** Host task lifetime only. Definitions, permissions, acceptance and results remain in the DB. */
export function createRoutineLifetime() {
  let closing = false;
  let closed = false;
  const effects = new Set<Promise<unknown>>();
  const timers = new Set<() => void>();

  function track<T>(effect: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new SafeToolError('unavailable', 'input'));
    const pending = Promise.resolve().then(effect);
    effects.add(pending);
    void pending.then(() => effects.delete(pending), () => effects.delete(pending));
    return pending;
  }
  function admit<T>(effect: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new SafeToolError('unavailable', 'input'));
    return track(effect);
  }
  function stopAdmission(): void {
    closing = true;
    // A missing-turn grace period cannot outlive the DB. Flush its terminal fallback.
    for (const finish of [...timers]) finish();
  }
  function defer(ms: number, effect: () => Promise<void>): Promise<void> {
    return track(async () => {
      if (!closing) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); timers.delete(finish); resolve(); };
        const timer = setTimeout(finish, ms);
        timer.unref?.();
        timers.add(finish);
      });
      await effect();
    });
  }
  async function drain(): Promise<void> {
    stopAdmission();
    // Providers may start nested completion work while their current effect is settling.
    while (effects.size > 0) await Promise.allSettled([...effects]);
    closed = true;
  }
  return { track, admit, defer, stopAdmission, drain };
}
export type RoutineLifetime = ReturnType<typeof createRoutineLifetime>;
