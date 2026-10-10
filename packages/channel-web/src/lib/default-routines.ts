import { httpFetch } from './http';
import type {
  RoutineDefaultSummary,
  RoutineGetDefaultOutput,
  RoutineUpsertDefaultInput,
  RoutineUpsertDefaultOutput,
} from '@ax/routines-contract';
import { readRoutineResponse, RoutineApiError } from './routines';
export type DefaultRoutineSummary = RoutineDefaultSummary;
export type DefaultRoutineDetail = RoutineGetDefaultOutput;
async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await httpFetch(path, {
      method,
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new RoutineApiError(0);
  }
  return readRoutineResponse<T>(res);
}
const base = '/admin/routines/defaults';
export async function listDefaultRoutines(): Promise<DefaultRoutineSummary[]> {
  return (await request<{ defaults: DefaultRoutineSummary[] }>(base)).defaults;
}
export function getDefaultRoutine(id: string): Promise<DefaultRoutineDetail> {
  return request(`${base}/${encodeURIComponent(id)}`);
}
/** Editable canonical interval fields only; omitted enabled preserves the catalog setting. */
export function upsertDefaultRoutine(
  definition: RoutineUpsertDefaultInput,
): Promise<RoutineUpsertDefaultOutput> {
  return request(base, 'POST', definition);
}
export function updateDefaultRoutine(
  id: string,
  definition: RoutineUpsertDefaultInput,
): Promise<RoutineUpsertDefaultOutput> {
  return request(`${base}/${encodeURIComponent(id)}`, 'PUT', definition);
}
export function deleteDefaultRoutine(id: string): Promise<void> {
  return request(`${base}/${encodeURIComponent(id)}`, 'DELETE');
}
