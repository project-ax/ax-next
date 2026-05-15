export interface RoutineFrontmatterFields {
  name: string;
  description: string;
  trigger: TriggerSpec;
  activeHours?: { start: string; end: string; tz: string };
  silenceToken?: string;
  silenceMaxChars: number;
  conversation: 'per-fire' | 'shared';
  promptBody: string;
}
export type TriggerSpec =
  | { kind: 'interval'; every: string }
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'webhook'; path: string };
export type RoutineFrontmatterResult =
  | { ok: true; fields: RoutineFrontmatterFields }
  | { ok: false; reason: string };
export function parseRoutineFrontmatter(_text: string): RoutineFrontmatterResult {
  return { ok: false, reason: 'not yet implemented' };
}
export function parseRoutineFrontmatterBytes(_bytes: Uint8Array): RoutineFrontmatterResult {
  return { ok: false, reason: 'not yet implemented' };
}
export function durationToSeconds(_every: string): number | null {
  return null;
}
