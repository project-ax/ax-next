import type { ToolDescriptor } from '@ax/core';

export const CONNECTOR_PROPOSE_TOOL_NAME = 'connector_propose' as const;

/**
 * The agent asks for a CONNECTOR — authenticated access to a data source,
 * mechanism hidden (MCP | CLI | direct API) — by calling this tool. The host
 * executor (this package's plugin) reads the draft args, derives the (user,
 * agent) scope from the trusted session ctx, and calls the
 * `connectors:install-authored` hook, which files a PENDING request for a
 * workspace admin (zero reach). Only an admin can turn it into a connector; the
 * person then adds it to the agent from the Connectors tab. There is no in-chat
 * approval card.
 *
 * Host-executed (`executesIn: 'host'`, mirror of `request_capability`): the
 * connector's declared surface is structured JSON the model produces inline, so
 * no sandbox executor + IPC action is needed. The host hook is the authoritative
 * validator of the (untrusted, model-authored) proposal; this descriptor only
 * advertises the tool to the model.
 */
export const CONNECTOR_PROPOSE_DESCRIPTOR: ToolDescriptor = {
  name: CONNECTOR_PROPOSE_TOOL_NAME,
  description: [
    'Ask your workspace admin to add a new connector — authenticated access to a',
    'service or data source. A connector hides its mechanism: it may be backed by a',
    'remote MCP server (an http URL), a CLI tool fetched from a package registry, or',
    'direct API calls over an allowed host. Pass the access surface as arguments.',
    'This only sends a request: an admin reviews it and sets it up, and nothing',
    'reaches the outside world until they do.',
    '',
    'Arguments:',
    '  connectorId: lowercase id, /^[a-z0-9][a-z0-9_-]*$/, max 128 chars (e.g. "salesforce").',
    '  name:        a short human label (e.g. "Salesforce").',
    '  hosts:       every host the connector reaches (bare hostnames, no scheme/path).',
    '  slots:       credential slots it needs — [{ slot: "SF_API_KEY", kind: "api-key" }].',
    '               Slot names are SCREAMING_SNAKE_CASE; the only kind is "api-key".',
    '  packages:    { npm: [...], pypi: [...] } — registries it fetches binaries from. Optional.',
    '  mcpServers:  remote MCP backing — [{ name, transport: "http", url, allowedHosts, credentials }]. Optional.',
    '  usageNote:   a short "how to use me" blurb so the connector works once set up.',
    '  keyMode:     a hint the admin decides. "personal" — each agent adds its own key',
    '               (per-user data like a personal Gmail/Drive); or "workspace" — one',
    '               shared key the admin enters (an org-wide system like the company',
    '               Salesforce).',
    '',
    'IMPORTANT: a connector you ask for is NOT available this turn. Once an admin',
    'sets it up, the user adds it to this agent from the Connectors tab, and it',
    'works from their next message. Do not try to use it now. Tell the user you have',
    'asked their admin and what happens next; do not restate any keys.',
  ].join('\n'),
  activityPhrase: 'Proposing a new connection',
  inputSchema: {
    type: 'object',
    properties: {
      connectorId: {
        type: 'string',
        description: 'Lowercase connector id, /^[a-z0-9][a-z0-9_-]*$/, e.g. "salesforce".',
      },
      name: { type: 'string', description: 'A short human label, e.g. "Salesforce".' },
      hosts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Bare hostnames the connector reaches (no scheme/path). May be empty.',
      },
      slots: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            slot: { type: 'string', description: 'SCREAMING_SNAKE_CASE slot name.' },
            kind: { type: 'string', enum: ['api-key'] },
            description: { type: 'string' },
            account: { type: 'string' },
          },
          required: ['slot', 'kind'],
        },
        description: 'Credential slots the connector needs (names only — never values).',
      },
      packages: {
        type: 'object',
        properties: {
          npm: { type: 'array', items: { type: 'string' } },
          pypi: { type: 'array', items: { type: 'string' } },
        },
        description: 'Package registries the connector fetches binaries from. Optional.',
      },
      mcpServers: {
        type: 'array',
        items: { type: 'object' },
        description:
          'Remote MCP backing — [{ name, transport: "http", url, allowedHosts, credentials }]. Optional.',
      },
      usageNote: {
        type: 'string',
        description: 'A short "how to use me" blurb. Optional.',
      },
      keyMode: {
        type: 'string',
        enum: ['personal', 'workspace'],
        description:
          'A hint the admin decides. "personal" = each agent adds its own key; "workspace" = one shared key the admin enters.',
      },
    },
    required: ['connectorId', 'name', 'keyMode'],
    additionalProperties: false,
  },
  executesIn: 'host',
};
