import type { ActiveHours } from '@ax/validator-routine';

interface LocalHm {
  hour: number;
  minute: number;
  ymd: { y: number; m: number; d: number };
}

function localParts(d: Date, tz: string): LocalHm {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    hour: parts.hour === '24' ? 0 : Number.parseInt(parts.hour, 10),
    minute: Number.parseInt(parts.minute, 10),
    ymd: {
      y: Number.parseInt(parts.year, 10),
      m: Number.parseInt(parts.month, 10),
      d: Number.parseInt(parts.day, 10),
    },
  };
}

function parseHm(hm: string): { h: number; m: number } {
  const [h, m] = hm.split(':');
  return { h: Number.parseInt(h!, 10), m: Number.parseInt(m!, 10) };
}

function buildLocal(ymd: { y: number; m: number; d: number }, h: number, m: number, tz: string): Date {
  let guess = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, h, m, 0));
  for (let i = 0; i < 2; i++) {
    const seen = localParts(guess, tz);
    const seenMs = Date.UTC(seen.ymd.y, seen.ymd.m - 1, seen.ymd.d, seen.hour, seen.minute, 0);
    const wantMs = Date.UTC(ymd.y, ymd.m - 1, ymd.d, h, m, 0);
    guess = new Date(guess.getTime() + (wantMs - seenMs));
  }
  return guess;
}

function addDays(ymd: { y: number; m: number; d: number }, days: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function advanceToNextActiveWindow(candidate: Date, ah: ActiveHours): Date {
  const local = localParts(candidate, ah.tz);
  const startHm = parseHm(ah.start);
  const endHm = parseHm(ah.end);
  const candidateMinutes = local.hour * 60 + local.minute;
  const startMinutes = startHm.h * 60 + startHm.m;
  const endMinutes = endHm.h * 60 + endHm.m;

  if (candidateMinutes >= startMinutes && candidateMinutes < endMinutes) {
    return candidate;
  }
  if (candidateMinutes < startMinutes) {
    return buildLocal(local.ymd, startHm.h, startHm.m, ah.tz);
  }
  return buildLocal(addDays(local.ymd, 1), startHm.h, startHm.m, ah.tz);
}
