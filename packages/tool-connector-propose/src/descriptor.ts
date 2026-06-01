import type { ToolDescriptor } from '@ax/core';

export const CONNECTOR_PROPOSE_TOOL_NAME = 'connector_propose' as const;

/**
 * TASK-95 (connectors-first-class, design Phase 2). The agent authors a
 * CONNECTOR — authenticated access to a data source, mechanism hidden (MCP | CLI
 * | direct API) — and submits it for approval by calling this tool. The host
 * executor (this package's plugin) reads the draft args, derives the (user,
 * agent) scope from the trusted session ctx, and calls the
 * `connectors:install-authored` hook (TASK-94), which persists a PENDING draft
 * (zero reach) and lets the orchestrator fire ONE approval card.
 *
 * Host-executed (`executesIn: 'host'`, mirror of `request_capability`): the
 * connector's declared surface is structured JSON the model produces inline —
 * there is NO `/ephemeral/...` draft directory to read sandbox-side (unlike
 * `skill_propose`), so no sandbox executor + IPC action is needed. The host hook
 * is the authoritative validator of the (untrusted, model-authored) capability
 * proposal; this descriptor only advertises the tool to the model.
 *
 * The description carries the spawn-time-discovery constraint (design §D6, same
 * as skill_propose): an authored connector is approved + resolved when a session
 * STARTS, so it becomes usable on the user's NEXT message, not the current turn.
 * Without that guidance the agent may try to use a connector it just proposed,
 * find nothing, and get confused.
 */
export const CONNECTOR_PROPOSE_DESCRIPTOR: ToolDescriptor = {
  name: CONNECTOR_PROPOSE_TOOL_NAME,
  description: [
    'Propose a new connector — authenticated access to a service or data source —',
    'so it can be connected for the user. A connector hides its mechanism: it may',
    'be backed by an MCP server (http or stdio), a CLI tool fetched from a package',
    'registry, or direct API calls over an allowed host. Pass the access surface as',
    'arguments; the user approves ONE card listing the hosts it reaches, the',
    'credential slots (keys) it needs, and the package registries it pulls from.',
    'Nothing reaches the outside world until they approve.',
    '',
    'Arguments:',
    '  connectorId: lowercase id, /^[a-z0-9][a-z0-9_-]*$/, max 128 chars (e.g. "salesforce").',
    '  name:        a short human label (e.g. "Salesforce").',
    '  hosts:       every host the connector reaches (bare hostnames, no scheme/path).',
    '  slots:       credential slots it needs — [{ slot: "SF_API_KEY", kind: "api-key" }].',
    '               Slot names are SCREAMING_SNAKE_CASE; the only kind is "api-key".',
    '  packages:    { npm: [...], pypi: [...] } — registries it fetches binaries from. Optional.',
    '  mcpServers:  MCP backing (transport/command/url live INSIDE each spec). Optional.',
    '  usageNote:   a short "how to use me" blurb so connecting it yields a working capability.',
    '  keyMode:     "personal" — prompt EACH user for their own key (per-user data like a',
    '               personal Gmail/Drive); or "workspace" — an admin provides ONE shared key',
    '               every allowed agent spends (an org-wide system like the company Salesforce).',
    '',
    'IMPORTANT: a connector you propose this turn is NOT connected this turn. After',
    'the user approves the card, it is resolved when their next message starts — so',
    'do not try to use it now. Tell the user it will be ready on their next message;',
    'if they asked you to connect AND use a service in one breath, propose it and',
    'offer to continue once they reply. Do not narrate the approval mechanics or',
    'restate any keys — the card handles that privately.',
  ].join('\n'),
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
        description: 'MCP backing (transport/command/url inside each spec). Optional.',
      },
      usageNote: {
        type: 'string',
        description: 'A short "how to use me" blurb. Optional.',
      },
      keyMode: {
        type: 'string',
        enum: ['personal', 'workspace'],
        description:
          '"personal" = prompt each user for their own key; "workspace" = one admin key shared by every allowed agent.',
      },
    },
    required: ['connectorId', 'name', 'keyMode'],
    additionalProperties: false,
  },
  executesIn: 'host',
};
