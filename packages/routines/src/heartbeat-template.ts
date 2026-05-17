/**
 * Default heartbeat routine seeded into every new agent's workspace at
 * `.ax/routines/heartbeat.md`. Daily interval + silence-token so quiet
 * days don't clutter the routines fire log.
 */
export const HEARTBEAT_TEMPLATE: string =
  [
    '---',
    'name: heartbeat',
    'description: daily check-in; says HEARTBEAT_OK and goes quiet when nothing\'s outstanding',
    'trigger:',
    '  kind: interval',
    '  every: "24h"',
    'conversation: shared',
    'silenceToken: HEARTBEAT_OK',
    '---',
    'If nothing\'s outstanding for you to report on, just say `HEARTBEAT_OK` and nothing else. Otherwise, give a one-paragraph summary.',
    '',
  ].join('\n');

export const HEARTBEAT_PATH = '.ax/routines/heartbeat.md';
