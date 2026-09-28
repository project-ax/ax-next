import { PluginError } from '@ax/core';

import type { MemoryAccess } from './access.js';
import { factsPath, subjectSlug, type FactsPath } from './export-paths.js';
import { rementionedSlotRows, retractedRementionRows, selectProfileRows } from './profile.js';
import { escapeStatementText, formatDay, renderNotedAt } from './render.js';
import { SLOTS } from './slots.js';
import { PLUGIN_NAME } from './plugin-name.js';

export interface ExportFact {
  id: string;
  about: string;
  relation: string;
  value: string;
  when: string;
  until?: string;
  closedBy?: string;
  slot?: string;
  provenance: string;
  conversationId?: string;
  kind?: string;
  recordedAt: string;
  /**
   * The engine's never-true bit: a person said this row was NEVER right.
   * Such a row is dropped from every export file — see `buildFactsExport`.
   */
  neverTrue?: boolean;
  /**
   * Who spoke the source turn (TASK-648). Read only by the profile pick and
   * the hide rule of Recent (TASK-646), the journals and the subject pages
   * (TASK-655), all through `profile.ts`: an extracted row
   * from the person's own turn can bring back a value they retracted.
   * Anything but `'user'` counts as not the person.
   */
  sourceRole?: string;
}

const PROVENANCES = new Set(['extracted', 'agent', 'human']);
const USER_SUBJECT = /^user:.+/;
const SLOT_SET = new Set<string>(SLOTS);
const UNBOUNDED = Number.POSITIVE_INFINITY;

function invalidReturn(message: string): PluginError {
  return new PluginError({
    code: 'invalid-return',
    plugin: PLUGIN_NAME,
    message,
  });
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isParseableInstant(v: string): boolean {
  return Number.isFinite(Date.parse(v));
}

function validateRow(row: ExportFact, index: number): void {
  const bad = (field: string): PluginError =>
    invalidReturn(`scan row ${index}: ${field} is missing or unreadable`);
  if (row === null || typeof row !== 'object') throw bad('row');
  if (!isNonEmptyString(row.id)) throw bad('id');
  if (!isNonEmptyString(row.about)) throw bad('about');
  if (!isNonEmptyString(row.relation)) throw bad('relation');
  if (!isNonEmptyString(row.value)) throw bad('value');
  if (!isNonEmptyString(row.when) || !isParseableInstant(row.when)) throw bad('when');
  if (!isNonEmptyString(row.recordedAt) || !isParseableInstant(row.recordedAt)) {
    throw bad('recordedAt');
  }
  if (row.until !== undefined && (!isNonEmptyString(row.until) || !isParseableInstant(row.until))) {
    throw bad('until');
  }
  if (row.closedBy !== undefined && !isNonEmptyString(row.closedBy)) throw bad('closedBy');
  if (row.slot !== undefined && !isNonEmptyString(row.slot)) throw bad('slot');
  if (row.conversationId !== undefined && typeof row.conversationId !== 'string') {
    throw bad('conversationId');
  }
  if (!isNonEmptyString(row.provenance) || !PROVENANCES.has(row.provenance)) {
    throw bad('provenance');
  }
  if (row.neverTrue !== undefined && typeof row.neverTrue !== 'boolean') throw bad('neverTrue');
}

function statementLine(row: ExportFact, includeAbout: boolean): string {
  const parts = [formatDay(row.when)!];
  if (includeAbout) parts.push(escapeStatementText(row.about, UNBOUNDED));
  parts.push(
    escapeStatementText(row.relation, UNBOUNDED),
    escapeStatementText(row.value, UNBOUNDED),
  );
  let line = `- ${parts.join(' · ')}`;
  if (row.until !== undefined) line += ` (until ${formatDay(row.until)!})`;
  return line;
}

function dedup(lines: Iterable<string>): string[] {
  return [...new Set(lines)];
}

function byWhenThenId(a: ExportFact, b: ExportFact): number {
  return a.when < b.when ? -1 : a.when > b.when ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function monthOf(row: ExportFact): string {
  return new Date(row.recordedAt).toISOString().slice(0, 7);
}

function buildProfile(
  rows: readonly ExportFact[],
  retracted: readonly ExportFact[],
  access: MemoryAccess,
): string {
  const active = rows.filter(
    (r) => r.until === undefined && r.slot !== undefined && SLOT_SET.has(r.slot),
  );
  let out = '# Profile\n\n';
  // Closed rows ride along as history so the pick can tell a re-mention of a
  // replaced value from a genuinely newer one (TASK-602). Never-true rows are
  // not exported, but they ride along here too: a value the person said was
  // never right, said again in chat, is a re-mention (TASK-633). History only
  // — a closed row is never a candidate, so none of them is rendered.
  const closed = [...rows.filter((r) => r.until !== undefined), ...retracted];
  const renderGroup = (group: readonly ExportFact[]): string[] =>
    selectProfileRows(
      group,
      SLOTS.length,
      closed.filter((r) => group.some((g) => g.about === r.about)),
    ).map(
      (row) =>
        `- ${escapeStatementText(row.slot!, UNBOUNDED)}: ${escapeStatementText(row.value, UNBOUNDED)}${renderNotedAt(row.when)}`,
    );
  if (access.visibility === 'personal') {
    const own = active.filter((r) => r.about === `user:${access.userId}`);
    out += dedup(renderGroup(own)).join('\n');
  } else {
    const subjects = [...new Set(active.filter((r) => USER_SUBJECT.test(r.about)).map((r) => r.about))].sort();
    const sections: string[] = [];
    for (const subject of subjects) {
      const lines = dedup(renderGroup(active.filter((r) => r.about === subject)));
      if (lines.length === 0) continue;
      sections.push(`## ${escapeStatementText(subject, UNBOUNDED)}\n\n${lines.join('\n')}`);
    }
    out += sections.join('\n\n');
  }
  return out.endsWith('\n') ? out : `${out}\n`;
}

function buildRecent(rows: readonly ExportFact[]): string {
  let out = '# Recent\n\n';
  const groups = new Map<string, ExportFact[]>();
  for (const row of rows) {
    if (row.conversationId === undefined || row.conversationId === '') continue;
    const list = groups.get(row.conversationId);
    if (list === undefined) groups.set(row.conversationId, [row]);
    else list.push(row);
  }
  const ranked = [...groups.entries()]
    .map(([conversationId, list]) => ({
      conversationId,
      list,
      newest: list.reduce((a, b) => (a.recordedAt > b.recordedAt ? a : b)),
    }))
    .sort(
      (a, b) =>
        b.newest.recordedAt.localeCompare(a.newest.recordedAt) ||
        a.conversationId.localeCompare(b.conversationId),
    )
    .slice(0, 3);
  const sections: string[] = [];
  for (const group of ranked) {
    const top = [...group.list]
      .sort(
        (a, b) =>
          b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id),
      )
      .slice(0, 3);
    const lines = dedup(top.map((row) => statementLine(row, true)));
    sections.push(
      `## ${formatDay(group.newest.recordedAt)!}\n\n${lines.join('\n')}`,
    );
  }
  out += sections.join('\n\n');
  return out.endsWith('\n') ? out : `${out}\n`;
}

export function buildFactsExport(
  scanned: readonly ExportFact[],
  access: MemoryAccess,
): Map<FactsPath, string> {
  scanned.forEach(validateRow);
  // A row a person said was NEVER right is not a past truth, so no export
  // file — profile, recent, journals, subject pages — may offer it for a
  // "what did I say in March" read (TASK-624). Dropped once, here, before
  // any file is built. A Forget (also `until` set, no `closedBy`) and a
  // replaced row are unchanged: those were once true. The profile still
  // reads never-true rows as history (never renders them), so the same value said again
  // in chat cannot win back its slot (TASK-633).
  const rows = scanned.filter((row) => row.neverTrue !== true);
  const retracted = scanned.filter((row) => row.neverTrue === true);
  // Recent offers what is current, so it hides what `memory:recall`'s active
  // read hides, decided by the same predicate: a re-mention of a value the
  // person said was never right (TASK-639 ruling, applied here by TASK-646),
  // or of one a higher-provenance row replaced. The scan is the whole store,
  // so every chain is in it.
  // Journals and subject pages are the record of what was said, so a
  // re-mention of a REPLACED value stays there. A RETRACTED value does not:
  // one rule everywhere (TASK-655 ruling, "yes, everywhere") — hidden unless
  // the person restated it (their own edit, or their own chat message,
  // TASK-648). It judges closed rows too (TASK-657): a hidden re-mention that
  // something newer superseded stays hidden instead of coming back as a
  // closed "(until …)" line.
  const hiddenFromRecord = retractedRementionRows(rows, retracted);
  // Recent shows closed rows as well, so it hides that set too.
  const hiddenFromRecent = new Set([...rementionedSlotRows(rows, retracted), ...hiddenFromRecord]);

  const out = new Map<FactsPath, string>();
  out.set(factsPath({ kind: 'profile' }), buildProfile(rows, retracted, access));
  out.set(
    factsPath({ kind: 'recent' }),
    buildRecent(rows.filter((row) => !hiddenFromRecent.has(row))),
  );

  const userJournals = new Map<string, ExportFact[]>();
  const assistantJournals = new Map<string, ExportFact[]>();
  const subjects = new Map<string, ExportFact[]>();
  const push = (map: Map<string, ExportFact[]>, key: string, row: ExportFact) => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [row]);
    else list.push(row);
  };
  for (const row of rows) {
    if (hiddenFromRecord.has(row)) continue;
    if (USER_SUBJECT.test(row.about)) push(userJournals, monthOf(row), row);
    else if (row.about === 'assistant') push(assistantJournals, monthOf(row), row);
    else push(subjects, row.about, row);
  }

  for (const [month, list] of [...userJournals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let text = `# User memories — ${month}\n\n`;
    const bySubject = new Map<string, ExportFact[]>();
    for (const row of list) push(bySubject, row.about, row);
    const sections: string[] = [];
    for (const subject of [...bySubject.keys()].sort()) {
      const lines = dedup(
        bySubject.get(subject)!.sort(byWhenThenId).map((row) => statementLine(row, false)),
      );
      sections.push(`## ${escapeStatementText(subject, UNBOUNDED)}\n\n${lines.join('\n')}`);
    }
    text += sections.join('\n\n');
    out.set(factsPath({ kind: 'journal', speaker: 'user', month }), `${text}\n`);
  }

  for (const [month, list] of [...assistantJournals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lines = dedup(
      [...list].sort(byWhenThenId).map((row) => statementLine(row, false)),
    );
    out.set(
      factsPath({ kind: 'journal', speaker: 'assistant', month }),
      `# Assistant memories — ${month}\n\n${lines.join('\n')}\n`,
    );
  }

  for (const subject of [...subjects.keys()].sort()) {
    const lines = dedup(
      subjects.get(subject)!.sort(byWhenThenId).map((row) => statementLine(row, false)),
    );
    out.set(
      factsPath({ kind: 'subject', subject }),
      `# ${escapeStatementText(subject, UNBOUNDED)}\n\n${lines.join('\n')}\n`,
    );
  }

  return out;
}

export { subjectSlug };
