import { durationToSeconds, type TriggerSpec } from '@ax/validator-routine';

export interface TriggerEngine {
  nextRun(spec: TriggerSpec, from: Date): Date | null;
  schedulable: boolean;
}

export const intervalEngine: TriggerEngine = {
  schedulable: true,
  nextRun(spec, from) {
    if (spec.kind !== 'interval') return null;
    const seconds = durationToSeconds(spec.every);
    if (seconds === null) return null;
    return new Date(from.getTime() + seconds * 1000);
  },
};
