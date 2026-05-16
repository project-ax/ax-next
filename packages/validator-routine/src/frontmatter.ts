import { load as yamlLoad, YAMLException } from 'js-yaml';
import { Cron } from 'croner';

const FRONTMATTER_FENCE = /^---\n([\s\S]*?)\n---(\n([\s\S]*))?$/;
const DURATION_RE = /^(\d+)(s|m|h|d)$/;
// 00:00–23:59, plus 24:00 as the "midnight at end-of-day" sentinel used
// by activeHours.end (see Task 8). Reject 24:01..24:59 as malformed.
const TIME_OF_DAY_RE = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
const WEBHOOK_PATH_RE = /^\/[A-Za-z0-9._\-/]+$/;
const EVENT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WEBHOOK_PATH_MAX = 128;
const WEBHOOK_EVENTS_MAX = 32;

export interface WebhookHmacSpec {
  secretRef: string;
  header: string;
  algorithm: 'sha256' | 'sha1';
  prefix?: string;
}

export type TriggerSpec =
  | { kind: 'interval'; every: string }
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'webhook'; path: string; events?: string[]; hmac?: WebhookHmacSpec };

export interface ActiveHours {
  start: string;
  end: string;
  tz: string;
}

export interface RoutineFrontmatterFields {
  name: string;
  description: string;
  trigger: TriggerSpec;
  activeHours?: ActiveHours;
  silenceToken?: string;
  silenceMaxChars: number;
  conversation: 'per-fire' | 'shared';
  promptBody: string;
}

export type RoutineFrontmatterResult =
  | { ok: true; fields: RoutineFrontmatterFields }
  | { ok: false; reason: string };

const fail = (reason: string): RoutineFrontmatterResult => ({ ok: false, reason });

export function parseRoutineFrontmatter(text: string): RoutineFrontmatterResult {
  const m = FRONTMATTER_FENCE.exec(text);
  if (m === null) return fail('no frontmatter block');
  const yamlBody = m[1] ?? '';
  const promptBody = (m[3] ?? '').trim();

  let parsed: unknown;
  try {
    parsed = yamlLoad(yamlBody);
  } catch (err) {
    if (err instanceof YAMLException) {
      return fail(`invalid YAML in frontmatter: ${err.reason}`);
    }
    return fail('invalid YAML in frontmatter');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('frontmatter must be a YAML mapping');
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || (obj['name'] as string).length === 0) {
    return fail('frontmatter missing required field: name');
  }
  if (typeof obj['description'] !== 'string' || (obj['description'] as string).length === 0) {
    return fail('frontmatter missing required field: description');
  }

  const triggerRaw = obj['trigger'];
  if (triggerRaw === undefined || triggerRaw === null) {
    return fail('frontmatter missing required field: trigger');
  }
  if (typeof triggerRaw !== 'object' || Array.isArray(triggerRaw)) {
    return fail('frontmatter trigger must be a mapping');
  }
  const trigObj = triggerRaw as Record<string, unknown>;
  const kind = trigObj['kind'];

  let trigger: TriggerSpec;
  switch (kind) {
    case 'interval': {
      const every = trigObj['every'];
      if (typeof every !== 'string' || every.length === 0) {
        return fail('interval trigger missing required field: every');
      }
      if (DURATION_RE.exec(every) === null) {
        return fail(`interval.every: not a valid duration (30s | 5m | 1h | 1d): ${every}`);
      }
      const seconds = durationToSeconds(every);
      if (seconds === null) return fail(`interval.every: cannot parse ${every}`);
      if (seconds < 60) {
        return fail(`interval.every: minimum is 60s (got ${every})`);
      }
      trigger = { kind: 'interval', every };
      break;
    }
    case 'cron': {
      const cronExpr = trigObj['expr'];
      const tz = trigObj['tz'];
      if (typeof cronExpr !== 'string' || cronExpr.length === 0) {
        return fail('cron trigger missing required field: expr');
      }
      if (typeof tz !== 'string' || tz.length === 0) {
        return fail('cron trigger requires explicit tz (no implicit local time)');
      }
      try {
        new Cron(cronExpr, { timezone: tz });
      } catch (err) {
        return fail(`invalid cron: ${err instanceof Error ? err.message : String(err)}`);
      }
      trigger = { kind: 'cron', expr: cronExpr, tz };
      break;
    }
    case 'webhook': {
      const pathRaw = trigObj['path'];
      if (typeof pathRaw !== 'string' || pathRaw.length === 0) {
        return fail('webhook trigger missing required field: path');
      }
      if (pathRaw.length > WEBHOOK_PATH_MAX) {
        return fail(`webhook.path: ${pathRaw.length} > max ${WEBHOOK_PATH_MAX}`);
      }
      if (!WEBHOOK_PATH_RE.test(pathRaw)) {
        return fail('webhook.path: must start with / and contain only letters, digits, dots, hyphens, underscores, and /');
      }
      if (pathRaw.startsWith('/webhooks/')) {
        return fail('webhook.path: must not start with /webhooks/');
      }
      if (pathRaw.includes('..')) {
        return fail('webhook.path: must not contain ..');
      }
      if (pathRaw.includes('//')) {
        return fail('webhook.path: must not contain //');
      }

      const webhook: { kind: 'webhook'; path: string; events?: string[]; hmac?: WebhookHmacSpec } = {
        kind: 'webhook',
        path: pathRaw,
      };

      const eventsRaw = trigObj['events'];
      if (eventsRaw !== undefined && eventsRaw !== null) {
        if (!Array.isArray(eventsRaw)) {
          return fail('webhook.events must be an array');
        }
        if (eventsRaw.length > WEBHOOK_EVENTS_MAX) {
          return fail(`webhook.events: ${eventsRaw.length} > max ${WEBHOOK_EVENTS_MAX}`);
        }
        const events: string[] = [];
        for (const v of eventsRaw) {
          if (typeof v !== 'string' || !EVENT_NAME_RE.test(v)) {
            return fail(`webhook.events: invalid item ${JSON.stringify(v)}`);
          }
          events.push(v);
        }
        webhook.events = events;
      }

      const hmacRaw = trigObj['hmac'];
      if (hmacRaw !== undefined && hmacRaw !== null) {
        if (typeof hmacRaw !== 'object' || Array.isArray(hmacRaw)) {
          return fail('webhook.hmac must be a mapping');
        }
        const hObj = hmacRaw as Record<string, unknown>;
        const secretRef = hObj['secretRef'];
        const header = hObj['header'];
        if (typeof secretRef !== 'string' || secretRef.length === 0) {
          return fail('webhook.hmac.secretRef is required');
        }
        if (typeof header !== 'string' || header.length === 0) {
          return fail('webhook.hmac.header is required');
        }
        let algorithm: 'sha256' | 'sha1' = 'sha256';
        const algRaw = hObj['algorithm'];
        if (algRaw !== undefined && algRaw !== null) {
          if (algRaw !== 'sha256' && algRaw !== 'sha1') {
            return fail(`webhook.hmac.algorithm: must be sha256 or sha1 (got ${JSON.stringify(algRaw)})`);
          }
          algorithm = algRaw;
        }
        const hmac: WebhookHmacSpec = { secretRef, header, algorithm };
        const prefix = hObj['prefix'];
        if (prefix !== undefined && prefix !== null) {
          if (typeof prefix !== 'string') {
            return fail('webhook.hmac.prefix must be a string');
          }
          hmac.prefix = prefix;
        }
        webhook.hmac = hmac;
      }

      trigger = webhook;
      break;
    }
    default:
      return fail(`trigger.kind: unknown value ${JSON.stringify(kind)} (expected interval | cron | webhook)`);
  }

  if (trigger.kind === 'webhook' && obj['activeHours'] !== undefined && obj['activeHours'] !== null) {
    return fail('activeHours is not supported on webhook routines');
  }

  let activeHours: ActiveHours | undefined;
  if (obj['activeHours'] !== undefined && obj['activeHours'] !== null) {
    const ah = obj['activeHours'];
    if (typeof ah !== 'object' || Array.isArray(ah)) {
      return fail('activeHours must be a mapping');
    }
    const ahObj = ah as Record<string, unknown>;
    const start = ahObj['start'];
    const end = ahObj['end'];
    const tz = ahObj['tz'];
    if (typeof start !== 'string' || !TIME_OF_DAY_RE.test(start)) {
      return fail(`activeHours.start: not HH:MM (got ${String(start)})`);
    }
    if (typeof end !== 'string' || !TIME_OF_DAY_RE.test(end)) {
      return fail(`activeHours.end: not HH:MM (got ${String(end)})`);
    }
    if (typeof tz !== 'string' || tz.length === 0) {
      return fail('activeHours.tz is required');
    }
    activeHours = { start, end, tz };
  }

  const silenceTokenRaw = obj['silenceToken'];
  let silenceToken: string | undefined;
  if (silenceTokenRaw !== undefined && silenceTokenRaw !== null) {
    if (typeof silenceTokenRaw !== 'string' || silenceTokenRaw.length === 0) {
      return fail('silenceToken must be a non-empty string when set');
    }
    silenceToken = silenceTokenRaw;
  }

  const silenceMaxRaw = obj['silenceMaxChars'];
  let silenceMaxChars = 300;
  if (silenceMaxRaw !== undefined && silenceMaxRaw !== null) {
    if (typeof silenceMaxRaw !== 'number' || !Number.isInteger(silenceMaxRaw) || silenceMaxRaw < 0) {
      return fail('silenceMaxChars must be a non-negative integer');
    }
    silenceMaxChars = silenceMaxRaw;
  }

  const conversationRaw = obj['conversation'];
  let conversation: 'per-fire' | 'shared';
  if (conversationRaw === undefined || conversationRaw === null) {
    conversation = 'per-fire';
  } else if (conversationRaw === 'per-fire' || conversationRaw === 'shared') {
    conversation = conversationRaw;
  } else {
    return fail(`conversation: must be "per-fire" or "shared" (got ${JSON.stringify(conversationRaw)})`);
  }

  const fields: RoutineFrontmatterFields = {
    name: obj['name'] as string,
    description: obj['description'] as string,
    trigger,
    silenceMaxChars,
    conversation,
    promptBody,
  };
  if (activeHours !== undefined) fields.activeHours = activeHours;
  if (silenceToken !== undefined) fields.silenceToken = silenceToken;
  return { ok: true, fields };
}

export function parseRoutineFrontmatterBytes(bytes: Uint8Array): RoutineFrontmatterResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('routine file is not valid UTF-8');
  }
  return parseRoutineFrontmatter(text);
}

export function durationToSeconds(every: string): number | null {
  const m = DURATION_RE.exec(every);
  if (m === null) return null;
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2]!;
  switch (unit) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86_400;
    default: return null;
  }
}
