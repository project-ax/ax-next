import { deriveCredentialPlan } from './credential-plan.js';
import { oauthClientSecretRefFor } from './oauth-client-secret-ref.js';
import type { Capabilities, CapabilitySlot, KeyMode } from './types.js';

// ---------------------------------------------------------------------------
// TASK-887 — does an edit point a connector "somewhere new"?
//
// THE QUESTION. Every stored credential of a connector (each agent's sign-in or
// key, the shared workspace key, the OAuth client secret) was entered for the
// connector as it was defined at the time. An edit that would bind one of them
// somewhere it was not bound before has to sign everyone out first. This file
// decides whether an edit does that. It is pure: no I/O, and no URL is parsed.
//
// THE RULE. Each side becomes a set of REACH FACTS (each the JSON of a tuple),
// and the edit points somewhere new iff `after` has a fact `before` lacks.
// Removing something never counts by itself. Facts are raw strings, so a
// respelling reads as new: the rule can over-purge, never under-purge.
//
//   1. ['slot', slot, occurrence, ref, kind, address, headerName,
//       authServerUrl, tokenUrl, secretRef]
//      One per top-level slot and EVERY server carrying the name the slot
//      names (server names may repeat); one with address null when no
//      server carries it.
//   2. ['slot-first', slot, occurrence, ref, kind, address, headerName,
//       authServerUrl, tokenUrl, secretRef]
//      One per top-level slot, with the address of the FIRST server carrying
//      the slot's server name (null when none does). Fact 1 is a set, so it
//      can't see order; this one can. Every consumer below binds a slot to
//      that first server, so swapping [A, B] to [B, A], or dropping A from
//      [A, B], moves every stored credential to B and must count.
//   3. ['server-slot', address, slot, kind, headerName, authServerUrl,
//       tokenUrl, secretRef]
//      One per server-level slot and every server carrying its server's
//      name, by the same rule. No credential is bound to these today;
//      keeping them as facts means a later consumer can't make one live
//      silently (the TASK-712 precedent).
//   4. ['server-slot-first', address, slot, kind, headerName, authServerUrl,
//       tokenUrl, secretRef]
//      One per server-level slot, with the address of the first server
//      carrying its server's name. Fact 3 keys on that name, as fact 1 does,
//      so it gets fact 2's order rule too: a later consumer that looks the
//      server up by name gets the first one, like every consumer today.
//   5. ['host', host]
//      One per top-level allowed host, only when the connector has an env
//      key (an api-key slot with no headerName): env keys are the only
//      credentials bound to those hosts.
//
//   - `address` is [transport, url ?? null], the "address" TASK-758's tool
//     permission reset and the editors compare. A path-only change counts; a
//     server renamed with its url kept does not.
//   - `ref` is the slot's deriveCredentialPlan ref. Removing one of two env
//     slots collapses the other onto `account:<id>`, where an older row sits.
//   - `occurrence` is how many earlier slots share the slot's name. It is 0
//     unless a name repeats (the write schema allows that), and then the
//     runtime binds by position (below), so moving those slots counts.
//   - `secretRef` is 'own' for no client secret or this connector's own
//     `account:<id>:OAUTH_CLIENT_SECRET`, else the raw ref: a ref re-pointed
//     at another key would post that key to a token endpoint.
//   - headerName is api-key only; authServerUrl, tokenUrl and secretRef are
//     oauth only. Each is null where it doesn't apply.
//
// WHAT THE FACTS MIRROR — where stored credentials are sent. These rules live
// in other plugins, so they are restated here (invariant 2: no import):
//   - The session proxy: @ax/chat-orchestrator connector-union.ts,
//     `foldConnectorCaps` (L904-917). An OAuth token or a header key is bound
//     to the host of the first server its slot names; an env key to the
//     top-level allowedHosts. A repeated slot name is skipped (L893).
//   - Host-side tool listing and approved calls: @ax/mcp-client
//     connector-inventory/connector-headers.ts (~L75-120). It matches a slot
//     to a server by name, but only the FIRST server with that name gets the
//     slot's token or header; a later same-name server gets none, like a
//     server with no slot. It finds a slot's ref by slot name. Fact 2 pins
//     that first server; fact 1 stays one per same-name server anyway, a
//     deliberately cautious extra (adding a twin can only over-purge), plus
//     `occurrence`.
//   - Sign-in: @ax/mcp-oauth routes.ts, `begin` (~L614-698) and the
//     callback's connector re-read (~L965-1023). Both read the first server
//     with the slot's name; the callback refuses when its url moved. Both read authServerUrl and
//     clientSecretRef, and the top-level allowedHosts.
//     Nothing reads `tokenUrl` today; it stays a fact for the same reason as
//     server-level slots.
//
// NOT REACH. scopes, clientId and clientRegistration: a refresh (@ax/mcp-oauth
// resolver.ts L186-203, TASK-696) uses only the stored token's own endpoint,
// resource and client, so editing them moves no stored credential. Nor are
// packages (registry egress only), services (no credential placeholders),
// display fields, or server-level hosts. A host added to a connector with no
// env key doesn't count either: its OAuth tokens and header keys go to their
// server alone, and the remote editor merges discovered sign-in hosts into
// allowedHosts on every save, which must not sign anyone out.
//
// THE CLIENT COPY. @ax/channel-web keeps a copy of this rule in
// `src/lib/connector-form.ts` (it drives the editors' warning and which saved
// values must be typed again). Its contract test,
// `src/__tests__/connector-retarget-contract.test.ts`, runs this package's
// table (`__tests__/retarget.test.ts`) through both copies. Change one,
// change the other.
// ---------------------------------------------------------------------------

/** The parts of a connector that decide where its stored credentials go. */
export interface RetargetSubject {
  id: string;
  keyMode: KeyMode;
  capabilities: Pick<Capabilities, 'allowedHosts' | 'credentials' | 'mcpServers'>;
}

type ServerSpec = Capabilities['mcpServers'][number];
type Address = [transport: string, url: string | null];

function addressOf(server: ServerSpec): Address {
  return [server.transport, server.url ?? null];
}

/**
 * The address of every server called `name` (names may repeat, and a
 * credential follows the name), or `[null]` when none is.
 */
function addressesNamed(servers: readonly ServerSpec[], name: string | undefined): Array<Address | null> {
  const named = name === undefined ? [] : servers.filter((s) => s.name === name);
  return named.length > 0 ? named.map(addressOf) : [null];
}

/**
 * The address of the FIRST server called `name`, the one every consumer binds
 * a credential to, or null when none is.
 */
function firstAddressNamed(servers: readonly ServerSpec[], name: string | undefined): Address | null {
  const first = name === undefined ? undefined : servers.find((s) => s.name === name);
  return first ? addressOf(first) : null;
}

/** An env key: an api-key slot that is not sent as a request header. */
function isEnvKey(slot: CapabilitySlot): boolean {
  return slot.kind === 'api-key' && !slot.headerName;
}

/** [headerName, authServerUrl, tokenUrl, secretRef], null where not applicable. */
function bindingFields(
  connectorId: string,
  slot: CapabilitySlot,
): [string | null, string | null, string | null, string | null] {
  if (slot.kind === 'api-key') return [slot.headerName ?? null, null, null, null];
  const ref = slot.clientSecretRef;
  const secretRef = !ref || ref === oauthClientSecretRefFor(connectorId) ? 'own' : ref;
  return [null, slot.authServerUrl ?? null, slot.tokenUrl ?? null, secretRef];
}

function reachFacts(c: RetargetSubject): Set<string> {
  const facts = new Set<string>();
  const add = (fact: unknown[]): void => {
    facts.add(JSON.stringify(fact));
  };
  // `Capabilities` types its slots api-key only (the shared skills-parser
  // shape); stored slots are this package's api-key | oauth union.
  const slots = c.capabilities.credentials as CapabilitySlot[];
  const servers = c.capabilities.mcpServers;
  const plan = deriveCredentialPlan(c); // one entry per slot, in slot order
  const seen = new Map<string, number>();
  slots.forEach((slot, i) => {
    const occurrence = seen.get(slot.slot) ?? 0;
    seen.set(slot.slot, occurrence + 1);
    const ref = plan[i]?.ref ?? null;
    const binding = bindingFields(c.id, slot);
    for (const address of addressesNamed(servers, slot.server)) {
      add(['slot', slot.slot, occurrence, ref, slot.kind, address, ...binding]);
    }
    add(['slot-first', slot.slot, occurrence, ref, slot.kind, firstAddressNamed(servers, slot.server), ...binding]);
  });
  for (const server of servers) {
    for (const slot of server.credentials as CapabilitySlot[]) {
      const binding = bindingFields(c.id, slot);
      for (const address of addressesNamed(servers, server.name)) {
        add(['server-slot', address, slot.slot, slot.kind, ...binding]);
      }
      add(['server-slot-first', firstAddressNamed(servers, server.name), slot.slot, slot.kind, ...binding]);
    }
  }
  if (slots.some(isEnvKey)) {
    for (const host of c.capabilities.allowedHosts) add(['host', host]);
  }
  return facts;
}

/**
 * Would saving `after` over `before` bind a stored credential of this
 * connector somewhere it was not bound before? True iff `after` has a reach
 * fact `before` lacks (see the file comment). Pure; neither input is modified.
 */
export function pointsSomewhereNew(before: RetargetSubject, after: RetargetSubject): boolean {
  const known = reachFacts(before);
  for (const fact of reachFacts(after)) {
    if (!known.has(fact)) return true;
  }
  return false;
}
