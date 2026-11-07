import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTreeAdapter as tree, html as spec, type DefaultTreeAdapterTypes as Tree } from 'parse5';

// prepareArtifactHtml answers null when it cannot vouch for a page, and never
// throws. Real input reaches a few of those paths (prepare-html.test.ts: deep
// nesting, <plaintext>, doctypes). The rest need parse5 to misbehave in ways no
// markup makes it: throw from deep inside, or keep handing back a tree with
// something new to cut. So parse5 is wrapped here, and a test says how.
const hooks = vi.hoisted(() => ({
  beforeParse: undefined as (() => void) | undefined,
  afterParse: undefined as ((doc: unknown) => void) | undefined,
  beforeSerialize: undefined as (() => void) | undefined,
}));

vi.mock('parse5', async (importOriginal) => {
  const real = await importOriginal<typeof import('parse5')>();
  return {
    ...real,
    parse: ((...args: Parameters<typeof real.parse>) => {
      hooks.beforeParse?.();
      const doc = real.parse(...args);
      hooks.afterParse?.(doc);
      return doc;
    }) as typeof real.parse,
    serializeOuter: ((...args: Parameters<typeof real.serializeOuter>) => {
      hooks.beforeSerialize?.();
      return real.serializeOuter(...args);
    }) as typeof real.serializeOuter,
  };
});

import { prepareArtifactHtml } from '../index.js';

beforeEach(() => {
  hooks.beforeParse = undefined;
  hooks.afterParse = undefined;
  hooks.beforeSerialize = undefined;
});

/** Adds a fresh <iframe> to the body of a parsed page, as a parse that keeps revealing one would. */
function addIframe(doc: unknown): void {
  const root = (doc as Tree.Document).childNodes.find((n): n is Tree.Element => tree.isElementNode(n) && n.tagName === 'html');
  const body = root?.childNodes.find((n): n is Tree.Element => tree.isElementNode(n) && n.tagName === 'body');
  if (body === undefined) throw new Error('the test page has no body');
  tree.appendChild(body, tree.createElement('iframe', spec.NS.HTML, []));
}

describe('prepareArtifactHtml when parse5 misbehaves', () => {
  it('passes a page through when nothing is wrong (so the wrapper itself is not what fails below)', () => {
    let parses = 0;
    hooks.beforeParse = () => void (parses += 1);
    expect(prepareArtifactHtml('<p>x</p>')).toEqual(expect.stringContaining('<p>x</p>'));
    expect(parses).toBe(2);
  });

  it.each([
    ['a stack overflow while parsing', () => new RangeError('Maximum call stack size exceeded')],
    ['any other error while parsing', () => new TypeError('boom')],
  ])('answers null, not a throw, after %s', (_name, make) => {
    hooks.beforeParse = () => {
      throw make();
    };
    expect(() => prepareArtifactHtml('<p>x</p>')).not.toThrow();
    expect(prepareArtifactHtml('<p>x</p>')).toBeNull();
  });

  it('answers null, not a throw, after a stack overflow while serializing', () => {
    hooks.beforeSerialize = () => {
      throw new RangeError('Maximum call stack size exceeded');
    };
    expect(() => prepareArtifactHtml('<p>x</p>')).not.toThrow();
    expect(prepareArtifactHtml('<p>x</p>')).toBeNull();
  });

  it('answers null for a page that keeps growing something to cut, after exactly four parses', () => {
    let parses = 0;
    hooks.beforeParse = () => void (parses += 1);
    hooks.afterParse = addIframe;
    expect(prepareArtifactHtml('<p>x</p>')).toBeNull();
    expect(parses).toBe(4);
  });

  it('still serves a page whose last cut is in the fourth parse, and no later one', () => {
    let parses = 0;
    hooks.beforeParse = () => void (parses += 1);
    hooks.afterParse = (doc) => {
      // Something to cut in the first three parses; the fourth is clean.
      if (parses <= 3) addIframe(doc);
    };
    const out = prepareArtifactHtml('<p>x</p>');
    expect(out).not.toBeNull();
    expect(out).not.toContain('<iframe');
    expect(parses).toBe(4);
  });

  it('serves a page that settles after two cuts in three parses', () => {
    let parses = 0;
    hooks.beforeParse = () => void (parses += 1);
    hooks.afterParse = (doc) => {
      if (parses <= 2) addIframe(doc);
    };
    expect(prepareArtifactHtml('<p>x</p>')).not.toBeNull();
    expect(parses).toBe(3);
  });
});

describe('loading prepare-html when the guard script cannot ride in a <script> element', () => {
  // The guard goes out inline. If the HTML parser would change its text, we
  // would ship a script nobody tested, and "the guard is already there" could
  // never match what we wrote. The module checks that once, with the real
  // parser, and refuses to load rather than 404 every artifact later.
  const GOOD = readFileSync(new URL('../frame-guard.js', import.meta.url), 'utf8');

  it('loads with the real guard', async () => {
    vi.resetModules();
    await expect(import('../prepare-html.js')).resolves.toHaveProperty('prepareArtifactHtml');
  });

  it.each([
    ['a script-closing tag', `${GOOD}\n// </script>\n`],
    ['a comment opener that stops the closing tag from closing', `${GOOD}\n// <!--<script>\n`],
    ['a carriage return, which the parser turns into a line feed', `${GOOD}\r\n`],
  ])('refuses to load when the guard holds %s', async (_name, source) => {
    vi.resetModules();
    vi.doMock('../guard.js', () => ({ FRAME_GUARD_SOURCE: source, CHILD_FRAME_TAGS: ['iframe'], DSD_ATTRS: ['shadowrootmode'] }));
    try {
      await expect(import('../prepare-html.js')).rejects.toThrow('does not survive the HTML parser');
    } finally {
      vi.doUnmock('../guard.js');
      vi.resetModules();
    }
  });
});
