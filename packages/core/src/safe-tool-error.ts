import { PluginError } from './errors.js';

const TOOL_MESSAGES = {
  validation: 'Routine input is invalid. Check the indicated field.',
  'revision-conflict': 'The routine changed. Read it with routine_get and submit a fresh edit.',
  'webhook-path-conflict': 'Another routine on this agent already uses that webhook path.',
  'request-conflict': 'This request ID was used for different input. Use a new request ID.',
  'approval-required': 'This operation requires human approval.',
  'not-found': 'The routine is unavailable.',
  forbidden: 'This operation is not allowed for this person and agent.',
  disabled: 'Enable the routine before firing it.',
  'cleanup-pending': 'Credential removal is pending. Retry after it completes.',
  unavailable: 'Routine management is temporarily unavailable.',
} as const;
const TOOL_FIELDS = ['input','name','description','promptBody','enabled','trigger',
  'trigger.every','trigger.expr','trigger.tz','trigger.path','trigger.events',
  'trigger.hmac','trigger.hmac.header','trigger.hmac.algorithm','trigger.hmac.prefix',
  'activeHours','activeHours.start','activeHours.end','activeHours.tz',
  'silenceToken','silenceMaxChars','conversation','routineId','expectedRevision','requestId'] as const;
export type SafeToolCode = keyof typeof TOOL_MESSAGES;
export type SafeToolField = typeof TOOL_FIELDS[number];

/** Fixed templates only: error text and caller-provided names never reach a receipt or wire. */
export function safeToolMessage(code: SafeToolCode, field: SafeToolField): string {
  const checkedCode = typeof code === 'string' && Object.hasOwn(TOOL_MESSAGES, code) ? code : 'unavailable';
  const checkedField = (TOOL_FIELDS as readonly string[]).includes(field) ? field : 'input';
  return `${TOOL_MESSAGES[checkedCode]} Field: ${checkedField}`;
}

/** Actionable failures stay thrown so host replay cannot record them as successful execution. */
export class SafeToolError extends PluginError {
  readonly toolCode: SafeToolCode;
  readonly field: SafeToolField;
  constructor(code: SafeToolCode, field: SafeToolField) {
    const checkedCode = typeof code === 'string' && Object.hasOwn(TOOL_MESSAGES, code) ? code : 'unavailable';
    const checkedField = (TOOL_FIELDS as readonly string[]).includes(field) ? field : 'input';
    super({ code: 'invalid-payload', plugin: '@ax/core', message: safeToolMessage(checkedCode, checkedField) });
    this.toolCode = checkedCode;
    this.field = checkedField;
  }
}
