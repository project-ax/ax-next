import { describe, expect, it } from 'vitest';
import { parseRoutineRow } from '../parse-routine.js';

const ENC = new TextEncoder();

describe('parseRoutineRow', () => {
  it('returns parsed fields + a deterministic spec_hash', () => {
    const bytes = ENC.encode([
      '---', 'name: r', 'description: d',
      'trigger:', '  kind: interval', '  every: "60s"',
      '---', '# prompt',
    ].join('\n') + '\n');
    const a = parseRoutineRow(bytes);
    const b = parseRoutineRow(bytes);
    expect(a.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.specHash).toBe(b.specHash);
    expect(a.specHash).toHaveLength(64);
  });

  it('different content yields different spec_hash', () => {
    const a = parseRoutineRow(ENC.encode('---\nname: a\ndescription: d\ntrigger:\n  kind: interval\n  every: "60s"\n---\n'));
    const b = parseRoutineRow(ENC.encode('---\nname: a\ndescription: d\ntrigger:\n  kind: interval\n  every: "120s"\n---\n'));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.specHash).not.toBe(b.specHash);
  });

  it('propagates parser failure', () => {
    const r = parseRoutineRow(ENC.encode('no frontmatter'));
    expect(r.ok).toBe(false);
  });
});
