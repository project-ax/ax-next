import { Cron } from 'croner';
import type { TriggerEngine } from './interval.js';

export const cronEngine: TriggerEngine = {
  schedulable: true,
  nextRun(spec, from) {
    if (spec.kind !== 'cron') return null;
    try {
      const c = new Cron(spec.expr, { timezone: spec.tz });
      const next = c.nextRun(from);
      return next ?? null;
    } catch {
      return null;
    }
  },
};
