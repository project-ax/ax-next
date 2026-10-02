import {
  emptyCapabilities,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorOAuthSlot,
} from './connectors';

export type ClientRegistration = NonNullable<
  ConnectorOAuthSlot['clientRegistration']
>;
export interface HeaderDraft {
  slot: string;
  name: string;
  value: string;
  saved: boolean;
}
export interface RemoteMcpDraft {
  name: string;
  url: string;
  signIn: 'none' | 'oauth';
  registration: ClientRegistration;
  clientId: string;
  clientSecret: string;
  clientSecretRef: string;
  headers: HeaderDraft[];
  scopes: string;
}

export const reservedHeaders = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'proxy-connection',
  'upgrade',
  'trailer',
  'te',
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);
export const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

export function remoteDraft(connector?: Connector): RemoteMcpDraft {
  const server = connector?.capabilities.mcpServers[0];
  const oauth = connector?.capabilities.credentials.find(
    (s): s is ConnectorOAuthSlot =>
      s.kind === 'oauth' && s.server === server?.name,
  );
  return {
    name: connector?.name ?? '',
    url: server?.url ?? '',
    signIn: oauth ? 'oauth' : 'none',
    registration:
      oauth?.clientRegistration ?? (oauth?.clientId ? 'custom' : 'auto'),
    clientId: oauth?.clientId ?? '',
    clientSecret: '',
    clientSecretRef: oauth?.clientSecretRef ?? '',
    headers: (connector?.capabilities.credentials ?? []).flatMap((s) =>
      s.kind === 'api-key' && s.server === server?.name && s.headerName
        ? [{ slot: s.slot, name: s.headerName, value: '', saved: true }]
        : [],
    ),
    scopes: (oauth?.scopes ?? []).join(' '),
  };
}

export function serverHost(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (
      url.length > 2048 ||
      parsed.protocol !== 'https:' ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      return undefined;
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

export function remoteErrors(draft: RemoteMcpDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = 'Enter a name for this connector.';
  else if (draft.name.trim().length > 128)
    errors.name = 'Use a name of up to 128 characters.';
  if (!serverHost(draft.url.trim()))
    errors.url =
      'Enter an HTTPS server URL on port 443, without a username, password, or fragment.';
  if (
    draft.signIn === 'oauth' &&
    draft.registration === 'custom' &&
    !draft.clientId.trim()
  )
    errors.clientId = 'Enter the client ID registered with this service.';
  const names = new Set<string>();
  for (const header of draft.headers) {
    const name = header.name.trim().toLowerCase();
    if (
      !headerNamePattern.test(header.name.trim()) ||
      reservedHeaders.has(name)
    )
      errors[`name-${header.slot}`] = 'Enter a valid custom header name.';
    else if (draft.signIn === 'oauth' && name === 'authorization')
      errors[`name-${header.slot}`] =
        'OAuth supplies Authorization. Choose a different header.';
    else if (names.has(name))
      errors[`name-${header.slot}`] = 'Each header needs a different name.';
    names.add(name);
    if (!header.saved && !header.value)
      errors[`value-${header.slot}`] = 'Enter a header value.';
    if (/[\x00-\x1f\x7f]/.test(header.value) || header.value.length > 8192)
      errors[`value-${header.slot}`] =
        'Use a single line of text, up to 8,192 characters.';
  }
  return errors;
}

/** Overlay only this remote server's controls. Hidden capabilities and other
 * servers/slots remain byte-for-byte data, rather than being reconstructed. */
export function remoteCapabilities(
  draft: RemoteMcpDraft,
  connectorId: string,
  connector?: Connector,
  discoveredHosts: string[] = [],
): ConnectorCapabilities {
  const base = connector?.capabilities ?? emptyCapabilities();
  const leading = base.mcpServers[0];
  const serverName = leading?.name ?? connectorId;
  const previousOAuth = base.credentials.find(
    (s): s is ConnectorOAuthSlot =>
      s.kind === 'oauth' && s.server === serverName,
  );
  const credentials = base.credentials.filter(
    (s) =>
      !(s.kind === 'oauth' && s.server === serverName) &&
      !(s.kind === 'api-key' && s.headerName && s.server === serverName),
  );
  if (draft.signIn === 'oauth') {
    let slot = previousOAuth?.slot ?? 'MCP_OAUTH';
    while (credentials.some((s) => s.slot === slot)) slot += '_';
    const oauth: ConnectorOAuthSlot = {
      ...previousOAuth,
      slot,
      kind: 'oauth',
      server: serverName,
      scopes: draft.scopes.split(/[\s,]+/).filter(Boolean),
      clientRegistration: draft.registration,
    };
    delete oauth.clientId;
    delete oauth.clientSecretRef;
    if (draft.registration === 'custom') {
      oauth.clientId = draft.clientId.trim();
      if (draft.clientSecretRef) oauth.clientSecretRef = draft.clientSecretRef;
    }
    credentials.push(oauth);
  }
  for (const header of draft.headers) {
    const previous = base.credentials.find(
      (s) => s.slot === header.slot && s.kind === 'api-key',
    );
    credentials.push({
      ...previous,
      kind: 'api-key',
      slot: header.slot,
      headerName: header.name.trim(),
      server: serverName,
      description: header.name.trim(),
    });
  }
  return {
    ...base,
    allowedHosts: [
      ...new Set([
        ...base.allowedHosts,
        ...discoveredHosts,
        serverHost(draft.url.trim())!,
      ]),
    ],
    credentials,
    mcpServers: [
      {
        ...leading,
        name: serverName,
        transport: 'http',
        url: draft.url.trim(),
        allowedHosts: leading?.allowedHosts ?? [],
        credentials: leading?.credentials ?? [],
      },
      ...base.mcpServers.slice(1),
    ],
  };
}
