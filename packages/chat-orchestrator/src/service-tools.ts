import type { ToolDescriptor } from '@ax/core';

// ---------------------------------------------------------------------------
// Dev services on demand (spec §3.2) — the two host tools the orchestrator
// registers (`tool:register`, the way @ax/routines registers `routine_*`):
//
//   restart_with_services({ set })  turn a service set on for this
//       conversation and restart the sandbox with it, inside this turn.
//   stop_services()                 turn it off; the next sandbox has none.
//
// The model chooses WHEN to restart and WHICH of its listed sets, never what
// runs: a set is an admin-approved connector's services, digest-pinned at
// import. Both executors live in orchestrator.ts (they need its per-request
// state); this file holds what they say and the catalog rule. Every refusal
// and result is a host constant, plus set ids and service names already
// checked against SAFE_NAME_RE (service-sets.ts).
//
// Executors never throw for a refusal: a host tool's throw reaches the model
// as a redacted generic error, so a refusal is an `ok: false` result whose
// message says on its own what happened (the @ax/agents identity tools'
// convention).
// ---------------------------------------------------------------------------

export const RESTART_WITH_SERVICES = 'restart_with_services';
export const STOP_SERVICES = 'stop_services';

export const RESTART_WITH_SERVICES_DESCRIPTOR: ToolDescriptor = {
  name: RESTART_WITH_SERVICES,
  description:
    'Restart your sandbox with a service set running beside it (databases, brokers and the like an ' +
    'admin set up), inside this same turn. Pass the set\'s name from the list in your instructions. ' +
    'SAVE YOUR WORK FIRST: push your branch, or write to /files. The new sandbox starts empty; the ' +
    'conversation carries over. After you call it your turn ends, and you continue in the new sandbox ' +
    'with a note listing where each service listens. Once per turn. Turn services off with stop_services.',
  activityPhrase: 'Restarting with dev services',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      set: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description: 'The name of the service set to start.',
      },
    },
    required: ['set'],
    additionalProperties: false,
  },
};

export const STOP_SERVICES_DESCRIPTOR: ToolDescriptor = {
  name: STOP_SERVICES,
  description:
    'Turn off the service set this conversation runs with. Nothing restarts now: this sandbox keeps ' +
    'its services until it is replaced, and the next one starts without them.',
  activityPhrase: 'Turning off dev services',
  executesIn: 'host',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export const SERVICE_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  RESTART_WITH_SERVICES_DESCRIPTOR,
  STOP_SERVICES_DESCRIPTOR,
];

export type ServiceToolResult = { ok: true; message: string } | { ok: false; message: string };

/** The `set` of a restart call, or null when the input isn't `{ set: <non-empty string> }`. */
export function parseRestartInput(input: unknown): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'set') return null;
  const set = (input as { set?: unknown }).set;
  return typeof set === 'string' && set.length > 0 && set.length <= 64 ? set : null;
}

/** Every refusal the restart tool gives, as host text. */
export const RESTART_REFUSALS = {
  invalidInput: 'Nothing restarted. Pass the name of a service set as "set".',
  noConversation: 'Nothing restarted. Services can only be started from a conversation.',
  noTurn:
    'Nothing restarted. This turn has no request to carry over into a new sandbox. Ask again in your ' +
    'next reply to the person.',
  alreadyRestarted: 'Nothing restarted. This turn already restarted once; a turn restarts at most once.',
  unavailable: 'Nothing restarted. The service settings could not be read or saved; try again later.',
  disabled: 'Nothing restarted. Services on demand are turned off on this host.',
  calledOff: 'Nothing restarted. The restart was called off (the turn was stopped, or services were turned off).',
} as const;

export function unknownSetRefusal(available: readonly string[]): string {
  return available.length === 0
    ? 'Nothing restarted. No service sets are set up for you.'
    : `Nothing restarted. That is not one of your service sets. Yours: ${available.join(', ')}.`;
}

export function alreadyOnRefusal(current: string, safe: boolean): string {
  const name = safe ? `the ${current} services are` : 'services are';
  return `Nothing restarted. ${name[0]!.toUpperCase()}${name.slice(1)} already running in this conversation. Call stop_services first to switch sets.`;
}

export function atCapRefusal(max: number): string {
  return (
    `Nothing restarted. This agent already has ${max} conversations running services. ` +
    'Try again when one finishes.'
  );
}

export function restartAccepted(set: string): string {
  return (
    `Restarting with the ${set} services. Your turn ends here and continues in a new sandbox. ` +
    'Finish this reply in a sentence; do not start new work.'
  );
}

export const STOP_RESULTS = {
  noConversation: 'Nothing changed. Services belong to a conversation, and this turn has none.',
  stopped:
    'Services are off for this conversation. This sandbox keeps them until it is replaced; the next ' +
    'one starts without them.',
  notOn: 'No services were on in this conversation.',
  unavailable: 'Nothing changed. The service settings could not be saved; try again later.',
} as const;

/**
 * Which of the two tools a session is offered: both when its agent has a
 * service set (the spawn found one among its connectors), neither otherwise.
 * An offered tool is appended to a NON-wildcard `allowedTools` (the host's
 * `tool:list` and the runner filter by it: the withBrokerDefaults rule). A
 * tool not offered is appended to `disallowedTools` only where the agent
 * lists it itself; never by shrinking `allowedTools`, which could empty it
 * into the wildcard. A WILDCARD agent (empty `allowedTools` and
 * `mcpConfigIds`) is left exactly as it was: it already sees the whole
 * catalog, the admin API refuses to make one (so it is the dev loop's), and
 * its frozen snapshot stays byte-identical. Visibility isn't a grant: the
 * executors refuse when there is nothing to start.
 */
export function serviceToolScope(
  agent: { allowedTools: readonly string[]; mcpConfigIds: readonly string[] },
  allowedTools: readonly string[],
  disallowedTools: readonly string[] | undefined,
  opts: { offered: boolean },
): { allowedTools: string[]; disallowedTools: string[] | undefined } {
  const wildcard = agent.allowedTools.length === 0 && agent.mcpConfigIds.length === 0;
  const allowed = [...allowedTools];
  const listed = new Set(allowedTools);
  const denied = new Set(disallowedTools ?? []);
  const hidden: string[] = [];
  for (const tool of [RESTART_WITH_SERVICES, STOP_SERVICES]) {
    if (opts.offered) {
      if (!wildcard && !listed.has(tool)) {
        allowed.push(tool);
        listed.add(tool);
      }
    } else if (!wildcard && listed.has(tool) && !denied.has(tool)) {
      hidden.push(tool);
      denied.add(tool);
    }
  }
  return {
    allowedTools: allowed,
    disallowedTools:
      hidden.length > 0
        ? [...(disallowedTools ?? []), ...hidden]
        : disallowedTools === undefined
          ? undefined
          : [...disallowedTools],
  };
}
