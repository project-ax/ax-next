import { describe, expect, it } from 'vitest';
import { personLabel, SHARING_COPY } from '../sharing-copy';

/** Bidi override, built from a code so no typed escape decodes into the literal character. */
const RLO = String.fromCharCode(0x202e);

/**
 * What every line that takes arguments is called with. A line missing here fails
 * `everyLine`, so a new one can't skip the product-name check below.
 */
const ARGS: Record<string, unknown[][]> = {
  'nav.summary': [['Fern']],
  heading: [['Fern']],
  'audience.justMe': [[1], [3]],
  'audience.people': [[['Ali'], 1], [['Ali', 'Bo'], 2], [['Ali', 'Bo'], 5]],
  'picker.title': [['Fern']],
  'picker.emptyDraft': [['Fern']],
  'picker.remove': [['Ali']],
  'picker.sameAsItem': [['Fern']],
  'picker.copyFailed': [['Fern']],
  'picker.narrowed': [['Fern']],
  'confirm.title': [['Fern', 'everyone'], ['Fern', ['Ali']], ['Fern', ['Ali', 'Bo', 'Cy']]],
  'confirm.connections': [['Fern', ['Gmail']], ['Fern', ['Gmail', 'Google Calendar', 'Slack']]],
  'confirm.signedInAs': [['someone@example.com']],
  'confirm.memory': [['Fern']],
  'confirm.filesAndInstructions': [['Fern']],
  'confirm.connectionsFailed': [['Fern']],
  'owners.remove': [['Ali']],
  'owners.addTitle': [['Fern']],
  'owners.confirmTitle': [['Ali', 'Fern']],
  'owners.consequences': [
    ['Fern', { kind: 'you' }],
    ['Fern', { kind: 'name', name: 'Vinay' }],
  ],
  team: [['Fern']],
  sharedBy: [['Vinay'], [null]],
  'errors.forbidden': [['Fern']],
  'errors.notFound': [['Fern']],
  'errors.loadFailed': [['Fern']],
};

/** Every string the deck can produce, with the path that produced it. */
function everyLine(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      out.push({ path, text: node });
    } else if (typeof node === 'function') {
      const calls = ARGS[path];
      if (calls === undefined) throw new Error(`no sample arguments for ${path}`);
      for (const args of calls) {
        const text = (node as (...a: unknown[]) => unknown)(...args);
        if (typeof text !== 'string') throw new Error(`${path} did not return a string`);
        out.push({ path, text });
      }
    } else if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path === '' ? k : `${path}.${k}`);
    }
  };
  walk(SHARING_COPY, '');
  return out;
}

describe('SHARING_COPY', () => {
  it('no string names the product', () => {
    const lines = everyLine();
    expect(lines.length).toBeGreaterThan(40);
    for (const { path, text } of lines) {
      expect(text, path).not.toMatch(/\bAX\b/);
      expect(text, path).not.toMatch(/Canopy/i);
      expect(text, path).not.toMatch(/undefined|\[object/);
      expect(text.trim(), path).not.toBe('');
    }
  });

  it('the option for everyone is plain "Everyone"', () => {
    expect(SHARING_COPY.picker.everyoneOption).toBe('Everyone');
    expect(SHARING_COPY.audience.everyone).toBe('Everyone');
  });

  it('the audience summary lists at most two names, then counts the rest', () => {
    const { people } = SHARING_COPY.audience;
    expect(people(['Ali'], 1)).toContain('Ali');
    const two = people(['Ali', 'Bo'], 2);
    expect(two).toContain('Ali');
    expect(two).toContain('Bo');
    const many = people(['Ali', 'Bo', 'Cy', 'Di'], 5);
    expect(many).toContain('Ali');
    expect(many).toContain('Bo');
    expect(many).not.toContain('Cy');
    expect(many).toContain('3');
  });

  it('narrowing says people may still remember what the agent told them', () => {
    const line = SHARING_COPY.picker.narrowed('Fern');
    expect(line).toContain('Fern');
    expect(line).toContain('remember');
  });

  it('the widen confirmation names each connection, the memory, the files and the Instructions', () => {
    const c = SHARING_COPY.confirm;
    const conns = c.connections('Fern', ['Gmail', 'Google Calendar']);
    expect(conns).toContain('Gmail');
    expect(conns).toContain('Google Calendar');
    expect(c.memory('Fern')).toMatch(/remembers/);
    expect(c.memory('Fern')).toMatch(/before today/);
    const files = c.filesAndInstructions('Fern');
    expect(files).toMatch(/files/);
    expect(files).toMatch(/artifacts/);
    expect(files).toMatch(/Instructions/);
    expect(c.signedInAs('a@b.example')).toContain('a@b.example');
  });

  it('the confirmation title says who is being shared with', () => {
    expect(SHARING_COPY.confirm.title('Fern', 'everyone')).toContain('Everyone');
    const named = SHARING_COPY.confirm.title('Fern', ['Ali', 'Bo']);
    expect(named).toContain('Ali');
    expect(named).toContain('Bo');
  });

  it('the owner confirmation names routines and who they run as', () => {
    const own = SHARING_COPY.owners.consequences('Fern', { kind: 'you' });
    expect(own).toMatch(/routine/i);
    expect(own).toMatch(/delete/i);
    const other = SHARING_COPY.owners.consequences('Fern', { kind: 'name', name: 'Vinay' });
    expect(other).toContain('Vinay');
    expect(other).toMatch(/routine/i);
  });

  it('a creator literally named "you" is a name, not the reader', () => {
    const named = SHARING_COPY.owners.consequences('Fern', { kind: 'name', name: 'you' });
    expect(named).not.toBe(SHARING_COPY.owners.consequences('Fern', { kind: 'you' }));
    expect(named).not.toContain('your connections');
    expect(named).toContain("you's connections");
  });

  it('the owner confirmation says what owners can change', () => {
    const text = SHARING_COPY.owners.consequences('Fern', { kind: 'you' });
    for (const word of ['Instructions', 'tools', 'connections']) expect(text).toContain(word);
    expect(text).toMatch(/who can use/i);
  });

  it('"Shared by" falls back when the creator could not be looked up', () => {
    expect(SHARING_COPY.sharedBy('Vinay')).toContain('Vinay');
    expect(SHARING_COPY.sharedBy(null)).not.toContain('null');
  });
});

describe('personLabel', () => {
  it('fences and falls back', () => {
    expect(personLabel(null)).toBe(SHARING_COPY.someone);
    expect(personLabel(undefined)).toBe(SHARING_COPY.someone);
    expect(personLabel('   ')).toBe(SHARING_COPY.someone);
    expect(personLabel('Ali' + RLO + 'ce')).toBe('Ali ce');
    expect([...personLabel('x'.repeat(200))]).toHaveLength(80);
  });
});
