/**
 * Slice 2c — what "Set it up" carries from an agent's connector request into
 * the create editor.
 *
 * ONE RULE: carry only what the chosen editor visibly shows and lets the admin
 * edit. Everything else in the request is agent-chosen reach the admin would
 * never see before saving, so it is NOT carried — it is named in `leftOut`
 * instead, and the editor lists it ("This request also asked for: …") so the
 * admin can add it after creating the connector, on purpose.
 *
 * Two editors, two answers:
 *   - the remote-server form (`RemoteMcpConnectorForm`) shows ONE MCP server:
 *     its URL, its request headers (by name) and its OAuth sign-in;
 *   - the general editor (`LegacyConnectorEditDialog`) shows allowed hosts,
 *     each key / sign-in row (name, label, server, scopes, client id), the
 *     LEADING package and the services.
 *
 * Every phrase in `leftOut` includes agent-written text; the editor renders
 * it through React text nodes only.
 */
import type {
  ConnectorCapabilities,
  ConnectorCredentialSlot,
  ConnectorMcpServerSpec,
  ConnectorPrefill,
} from './connectors';

const empty = (): ConnectorCapabilities => ({
  allowedHosts: [],
  credentials: [],
  mcpServers: [],
  packages: { npm: [], pypi: [] },
});

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function slotPhrase(s: ConnectorCredentialSlot): string {
  return s.kind === 'oauth' ? `a sign-in named ${s.slot}` : `a key named ${s.slot}`;
}

function serverPhrase(m: ConnectorMcpServerSpec): string {
  return m.url ? `another server, ${m.url}` : `another server named ${m.name}`;
}

function packagesAndServices(caps: ConnectorCapabilities, keepLeading: boolean): string[] {
  const out: string[] = [];
  const npm = caps.packages.npm;
  const pypi = caps.packages.pypi;
  // The general editor shows one leading package (npm first, else PyPI).
  const leadNpm = keepLeading && npm.length > 0;
  const leadPypi = keepLeading && !leadNpm && pypi.length > 0;
  npm.forEach((p, i) => {
    if (!(leadNpm && i === 0)) out.push(`the npm package ${p}`);
  });
  pypi.forEach((p, i) => {
    if (!(leadPypi && i === 0)) out.push(`the PyPI package ${p}`);
  });
  return out;
}

/** Remote-server form: the leading MCP server only. */
export function prefillForRemoteForm(p: ConnectorPrefill): ConnectorPrefill {
  const caps = p.capabilities;
  const [server, ...others] = caps.mcpServers;
  const leftOut: string[] = [];
  const carried = empty();
  const serverHost = hostOf(server?.url);
  if (server) {
    carried.mcpServers = [
      {
        name: server.name,
        transport: 'http',
        ...(server.url ? { url: server.url } : {}),
        allowedHosts: [],
        credentials: [],
      },
    ];
    for (const h of server.allowedHosts) leftOut.push(`access to ${h}`);
    for (const s of server.credentials) leftOut.push(slotPhrase(s));
  }
  for (const m of others) leftOut.push(serverPhrase(m));
  for (const h of caps.allowedHosts) {
    // The server's own host is what the form's URL field already shows.
    if (h !== serverHost) leftOut.push(`access to ${h}`);
  }
  let oauthKept = false;
  for (const s of caps.credentials) {
    const onServer = server !== undefined && s.server === server.name;
    if (s.kind === 'api-key' && onServer && s.headerName) {
      // Shown as a request header row: its name; the admin types the value.
      carried.credentials.push({
        slot: s.slot,
        kind: 'api-key',
        headerName: s.headerName,
        server: s.server!,
      });
    } else if (s.kind === 'oauth' && onServer && !oauthKept) {
      // Shown as the server's sign-in: scopes and client id are form fields.
      oauthKept = true;
      carried.credentials.push({
        slot: s.slot,
        kind: 'oauth',
        server: s.server,
        ...(s.scopes ? { scopes: s.scopes } : {}),
        ...(s.clientId ? { clientId: s.clientId } : {}),
        ...(s.clientRegistration ? { clientRegistration: s.clientRegistration } : {}),
      });
    } else {
      leftOut.push(slotPhrase(s));
    }
  }
  leftOut.push(...packagesAndServices(caps, false));
  for (const svc of caps.services ?? []) leftOut.push(`the service ${svc.name}`);
  return { ...p, capabilities: carried, leftOut };
}

/** General editor: hosts, key / sign-in rows, the leading package, services. */
export function prefillForGeneralForm(p: ConnectorPrefill): ConnectorPrefill {
  const caps = p.capabilities;
  const leftOut: string[] = [];
  const carried = empty();
  carried.allowedHosts = [...caps.allowedHosts];
  for (const m of caps.mcpServers) leftOut.push(serverPhrase(m));
  for (const s of caps.credentials) {
    if (s.kind === 'oauth') {
      // The row shows name, server, scopes and client id — nothing else.
      carried.credentials.push({
        slot: s.slot,
        kind: 'oauth',
        server: s.server,
        ...(s.scopes ? { scopes: s.scopes } : {}),
        ...(s.clientId ? { clientId: s.clientId } : {}),
      });
      if (s.authServerUrl || s.tokenUrl) leftOut.push(`sign-in addresses for ${s.slot}`);
    } else {
      // The row shows name and label; a header the key is sent in is not.
      carried.credentials.push({
        slot: s.slot,
        kind: 'api-key',
        ...(s.description ? { description: s.description } : {}),
      });
      if (s.headerName) leftOut.push(`sending the key ${s.slot} as the header ${s.headerName}`);
    }
  }
  if (caps.packages.npm.length > 0) carried.packages.npm = [caps.packages.npm[0]!];
  else if (caps.packages.pypi.length > 0) carried.packages.pypi = [caps.packages.pypi[0]!];
  leftOut.push(...packagesAndServices(caps, true));
  if (caps.services && caps.services.length > 0) carried.services = [...caps.services];
  return { ...p, capabilities: carried, leftOut };
}
