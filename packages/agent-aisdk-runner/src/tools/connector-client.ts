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

/** What `initialize` carries as `clientInfo` unless the deployment renames it. */
export const DEFAULT_CONNECTOR_CLIENT_INFO = { name: 'ax-aisdk-runner', version: '0.0.0' } as const;

/** 1-64 printable ASCII characters, no spaces: the host's rule for AX_MCP_CLIENT_NAME. */
const CLIENT_NAME_RE = /^[\x21-\x7e]{1,64}$/;

/**
 * The `clientInfo` for connector sessions. AX_MCP_CLIENT_NAME (forwarded by
 * the sandbox from the host deployment) replaces the name; unset, empty or
 * malformed keeps the default. The host fails boot on a malformed value, so
 * reaching the fallback here means the sandbox env was set some other way.
 */
export function connectorClientInfo(env: NodeJS.ProcessEnv = process.env): { name: string; version: string } {
  const raw = env['AX_MCP_CLIENT_NAME'];
  return raw !== undefined && CLIENT_NAME_RE.test(raw)
    ? { ...DEFAULT_CONNECTOR_CLIENT_INFO, name: raw }
    : { ...DEFAULT_CONNECTOR_CLIENT_INFO };
}

export function createConnectorClient(): Client {
  const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: false });
  // ajv-formats is CommonJS; its runtime default is the callable plugin.
  (formatsModule as unknown as FormatsPlugin)(ajv);
  return new BoundedClient(connectorClientInfo(), {
    jsonSchemaValidator: new AjvJsonSchemaValidator(ajv),
  });
}
