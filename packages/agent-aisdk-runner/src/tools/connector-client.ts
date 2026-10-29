import { Ajv } from 'ajv';
import formatsModule, { type FormatsPlugin } from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { ResultSchema, ListToolsResultSchema, type ClientRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { AnySchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';

// The 2 MiB wire cap bounds bytes, but not Zod's per-element errors or Ajv's
// schema compilation. Allow 16,384 values and 32 container levels per page:
// room for 256 tools with ordinary parameter schemas, while keeping parser
// work bounded independently of strings' lengths. Existing byte/tool/page
// limits still apply. Reject before ListToolsResultSchema traverses the page.
export const MAX_LIST_VALUES = 16_384;
export const MAX_LIST_DEPTH = 32;

function withinBudget(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  let remaining = MAX_LIST_VALUES;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (--remaining < 0) return false;
    if (typeof entry.value !== 'object' || entry.value === null) continue;
    if (entry.depth >= MAX_LIST_DEPTH) return false;
    const keys = Object.keys(entry.value);
    if (keys.length > remaining - pending.length) return false;
    for (const key of keys) {
      pending.push({ value: (entry.value as Record<string, unknown>)[key], depth: entry.depth + 1 });
    }
  }
  return true;
}

const boundedList = ResultSchema.superRefine((value, ctx) => {
  if (!withinBudget(value)) ctx.addIssue({ code: 'custom', message: 'tool list exceeds its structural budget' });
}).pipe(ListToolsResultSchema);

class BoundedClient extends Client {
  override request<T extends AnySchema>(request: ClientRequest, schema: T, options?: RequestOptions): Promise<SchemaOutput<T>> {
    // listTools retains the SDK's output-schema/task metadata cache. Only its
    // result parser is wrapped; every accepted result still passes the full
    // SDK schema. The method determines its result type at this boundary.
    return super.request(request, request.method === 'tools/list' ? boundedList as unknown as T : schema, options);
  }
}

export function createConnectorClient(): Client {
  const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: false });
  // ajv-formats is CommonJS; its runtime default is the callable plugin.
  (formatsModule as unknown as FormatsPlugin)(ajv);
  return new BoundedClient({ name: 'ax-aisdk-runner', version: '0.0.0' }, {
    jsonSchemaValidator: new AjvJsonSchemaValidator(ajv),
  });
}
