import { httpFetch, REQUEST_TIMEOUT_MS, RequestTimeoutError, withRequestTimeout } from './http';
import type {
  RoutineDefinition,
  RoutineKey,
  RoutinePatch,
  RoutineView,
  RoutineFireView,
  RoutineCreateInput,
  RoutineUpdateInput,
  RoutineDeleteInput,
  RoutineFireNowInput,
  RoutineFireNowOutput,
  RoutineDeleteOutput,
  RoutineSchedule,
  WebhookTrigger,
} from '@ax/routines-contract';
/**
 * A Settings answer carries no task state (TASK-957): a routine's `task` is
 * always null, its `steps` always empty, and a run's `report` always null. A
 * task's page reads them, fenced, through `workspaceApi`.
 */
export type Routine = RoutineView;
export type Fire = RoutineFireView;
export type TriggerSpec = RoutineSchedule | WebhookTrigger;
export type ActiveHours = NonNullable<RoutineDefinition['activeHours']>;
export type FireStatus = RoutineFireView['status'];
export type FireSource = RoutineFireView['triggerSource'];
export type FireNowInput = RoutineFireNowInput;
export type FireNowOutput = RoutineFireNowOutput;
export type { RoutineDefinition, RoutinePatch };
export interface RoutineConsent {
  enabled: boolean;
  revision: string;
}
export interface RoutineReceiver { url: string; version: string; legacyActive: boolean }
export interface AgentDefaultState {
  defaultRoutineId: string;
  name: string;
  enabled: boolean;
}
const messages = {
  validation: 'Check the indicated routine field.',
  'revision-conflict': 'This routine changed. Refresh it before saving.',
  'webhook-path-conflict': 'Another routine already uses that webhook path.',
  'request-conflict': 'This request ID was already used for another change.',
  'approval-required': 'This change requires approval.',
  'not-found': 'This routine is unavailable.',
  forbidden: 'You cannot manage this routine.',
  busy: 'Three runs are already in progress. Try again when one finishes.',
  disabled: 'Enable this routine before running it.',
  'cleanup-pending': 'Credential removal is pending. Try again shortly.',
  unavailable: 'Routine management is temporarily unavailable.',
} as const;
export type RoutineErrorCode = keyof typeof messages;
const fields = [
  'input',
  'name',
  'description',
  'promptBody',
  'enabled',
  'trigger',
  'trigger.every',
  'trigger.expr',
  'trigger.tz',
  'trigger.path',
  'trigger.events',
  'trigger.hmac',
  'trigger.hmac.header',
  'trigger.hmac.algorithm',
  'trigger.hmac.prefix',
  'schedule',
  'schedule.every',
  'schedule.expr',
  'schedule.tz',
  'webhook',
  'webhook.path',
  'webhook.events',
  'webhook.hmac',
  'webhook.hmac.header',
  'webhook.hmac.algorithm',
  'webhook.hmac.prefix',
  'activeHours',
  'activeHours.start',
  'activeHours.end',
  'activeHours.tz',
  'activeHours.days',
  'silenceToken',
  'silenceMaxChars',
  'conversation',
  'routineId',
  'expectedRevision',
  'requestId',
] as const;
export type RoutineErrorField = (typeof fields)[number];
export class RoutineApiError extends Error {
  readonly code: RoutineErrorCode;
  readonly field?: RoutineErrorField;
  constructor(
    readonly status: number,
    code: unknown = 'unavailable',
    field?: unknown,
  ) {
    const checked =
      typeof code === 'string' && Object.hasOwn(messages, code)
        ? (code as RoutineErrorCode)
        : 'unavailable';
    super(messages[checked]);
    this.name = 'RoutineApiError';
    this.code = checked;
    if (
      typeof field === 'string' &&
      (fields as readonly string[]).includes(field)
    )
      this.field = field as RoutineErrorField;
  }
}
/** Read once; arbitrary server/provider exception messages never become UI copy. */
export async function readRoutineResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new RoutineApiError(res.status);
    }
    const error =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as { code?: unknown; field?: unknown })
        : {};
    throw new RoutineApiError(res.status, error.code, error.field);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  try {
    // The deadline covers the whole request, the body read included (TASK-937).
    return await withRequestTimeout(path, REQUEST_TIMEOUT_MS, async (signal) => {
      let res: Response;
      try {
        res = await httpFetch(path, {
          method,
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'ax-admin',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
        });
      } catch {
        throw new RoutineApiError(0);
      }
      return readRoutineResponse<T>(res);
    });
  } catch (e) {
    // No answer in time reads as a fetch that threw: no answer at all.
    if (e instanceof RequestTimeoutError) throw new RoutineApiError(0);
    throw e;
  }
}
const collection = (agentId: string) =>
  `/settings/routines/${encodeURIComponent(agentId)}`;
const item = (input: { agentId: string; routineId: string }) =>
  `${collection(input.agentId)}/${encodeURIComponent(input.routineId)}`;
/** Request IDs belong to logical mutations. Callers retain them across uncertain retries. */
export const routineApi = {
  async list(agentId: string): Promise<RoutineView[]> {
    return (await request<{ routines: RoutineView[] }>(collection(agentId)))
      .routines;
  },
  async get(input: {
    agentId: string;
    routineId: string;
  }): Promise<RoutineView> {
    return (await request<{ routine: RoutineView }>(item(input))).routine;
  },
  async create({ agentId, ...body }: RoutineCreateInput): Promise<RoutineView> {
    return (
      await request<{ routine: RoutineView }>(collection(agentId), 'POST', body)
    ).routine;
  },
  async update({
    agentId,
    routineId,
    ...body
  }: RoutineUpdateInput): Promise<RoutineView> {
    return (
      await request<{ routine: RoutineView }>(
        item({ agentId, routineId }),
        'PATCH',
        body,
      )
    ).routine;
  },
  remove({
    agentId,
    routineId,
    ...body
  }: RoutineDeleteInput): Promise<RoutineDeleteOutput> {
    return request(item({ agentId, routineId }), 'DELETE', body);
  },
  fireNow({
    agentId,
    routineId,
    ...body
  }: RoutineFireNowInput): Promise<RoutineFireNowOutput> {
    return request(`${item({ agentId, routineId })}/fire`, 'POST', body);
  },
  async recentFires(input: {
    agentId: string;
    routineId: string;
    limit?: number;
  }): Promise<RoutineFireView[]> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    return (
      await request<{ fires: RoutineFireView[] }>(
        `${item(input)}/fires${query.size ? `?${query}` : ''}`,
      )
    ).fires;
  },
  getConsent(agentId: string): Promise<RoutineConsent> {
    return request(`${collection(agentId)}/consent`);
  },
  revokeConsent(agentId: string): Promise<RoutineConsent> {
    return request(`${collection(agentId)}/consent`, 'DELETE', {});
  },
  getReceiver(agentId: string): Promise<{ url: string }> {
    return request(`${collection(agentId)}/receiver`);
  },
  getTaskReceiver(key: RoutineKey): Promise<RoutineReceiver> {
    return request(`${collection(key.agentId)}/${encodeURIComponent(key.routineId)}/receiver`);
  },
  replaceTaskReceiver(key: RoutineKey, expectedVersion: string): Promise<RoutineReceiver> {
    return request(`${collection(key.agentId)}/${encodeURIComponent(key.routineId)}/receiver/replace`, 'POST', { expectedVersion });
  },
  getReceiverAccess(agentId: string): Promise<{ allowed: boolean }> {
    return request(`${collection(agentId)}/receiver-access`);
  },
  async listAgentDefaults(agentId: string): Promise<AgentDefaultState[]> {
    return (
      await request<{ defaults: AgentDefaultState[] }>(
        `${collection(agentId)}/defaults`,
      )
    ).defaults;
  },
  async setAgentDefaultEnabled({
    agentId,
    defaultRoutineId,
    enabled,
  }: {
    agentId: string;
    defaultRoutineId: string;
    enabled: boolean;
  }): Promise<void> {
    await request(
      `${collection(agentId)}/defaults/${encodeURIComponent(defaultRoutineId)}`,
      'POST',
      { enabled },
    );
  },
};
