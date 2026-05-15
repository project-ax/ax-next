import { createHash } from 'node:crypto';
import {
  parseRoutineFrontmatterBytes,
  type RoutineFrontmatterFields,
} from '@ax/validator-routine';

export type ParsedRoutine =
  | { ok: true; fields: RoutineFrontmatterFields; specHash: string }
  | { ok: false; reason: string };

export function parseRoutineRow(bytes: Uint8Array): ParsedRoutine {
  const r = parseRoutineFrontmatterBytes(bytes);
  if (!r.ok) return { ok: false, reason: r.reason };
  const specHash = createHash('sha256').update(bytes).digest('hex');
  return { ok: true, fields: r.fields, specHash };
}
