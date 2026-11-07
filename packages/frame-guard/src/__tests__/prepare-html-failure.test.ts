import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTreeAdapter as tree, html as spec, type DefaultTreeAdapterTypes as Tree } from 'parse5';

// prepareArtifactHtml refuses a page it cannot vouch for, with a reason, and
// never throws. Real input reaches most of those paths (prepare-html.test.ts:
// deep nesting, <plaintext>, doctypes). The rest need parse5 to misbehave in ways
// no markup makes it: throw from deep inside, or keep handing back a tree with
// something new to cut. So parse5's parser is wrapped here, and a test says how.
const hooks = vi.hoisted(() => ({
  beforeParse: undefined as (() => void) | undefined,
  afterParse: undefined as ((doc: unknown) => void) | undefined,
  beforeSerialize: undefined as (() => void) | undefined,
  afterSerialize: undefined as (() => void) | undefined,
  /** Changes what the serializer wrote, as a serializer that wrote more than the tree's count said would. */
  serialized: undefined as ((written: string) => string) | undefined,
}));

vi.mock('parse5', async (importOriginal) => {
  const real = await importOriginal<typeof import('parse5')>();
  // One of these per parse: `beforeParse` runs as the parser is made, `afterParse` once the last of the
  // page has been written to its tokenizer, with the document it built.
  class HookedParser<T extends import('parse5').TreeAdapterTypeMap> extends real.Parser<T> {
    constructor(...args: ConstructorParameters<typeof real.Parser<T>>) {
      hooks.beforeParse?.();
      super(...args);
      const write = this.tokenizer.write.bind(this.tokenizer);
      this.tokenizer.write = (chunk: string, isLastChunk: boolean, writeCallback?: () => void): void => {
        write(chunk, isLastChunk, writeCallback);
        if (isLastChunk) hooks.afterParse?.(this.document);
      };
    }
  }
  return {
    ...real,
    Parser: HookedParser,
    serializeOuter: ((...args: Parameters<typeof real.serializeOuter>) => {
      hooks.beforeSerialize?.();
      try {
        const written = real.serializeOuter(...args);
        return hooks.serialized?.(written) ?? written;
      } finally {
        hooks.afterSerialize?.();
      }
    }) as typeof real.serializeOuter,
  };
});

import { prepareArtifactHtml as transform, type PrepareResult } from '../index.js';

/** The page, or the reason it was refused. */
const outcome = (html: string): string => {
  const result: PrepareResult = transform(html);
  return result.ok ? result.html : `refused: ${result.reason}`;
};

beforeEach(() => {
  hooks.beforeParse = undefined;
  hooks.afterParse = undefined;
  hooks.beforeSerialize = undefined;
  hooks.afterSerialize = undefined;
  hooks.serialized = undefined;
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
    expect(outcome('<p>x</p>')).toEqual(expect.stringContaining('<p>x</p>'));
    expect(parses).toBe(2);
  });

  it.each([
    ['a stack overflow while parsing', () => new RangeError('Maximum call stack size exceeded')],
    ['any other error while parsing', () => new TypeError('boom')],
  ])('refuses with the parser-error code, not a throw, after %s', (_name, make) => {
    hooks.beforeParse = () => {
      throw make();
    };
    expect(() => transform('<p>x</p>')).not.toThrow();
    expect(outcome('<p>x</p>')).toBe('refused: parse_error');
  });

  it('refuses with the parser-error code, not a throw, after a stack overflow while serializing', () => {
    hooks.beforeSerialize = () => {
      throw new RangeError('Maximum call stack size exceeded');
    };
    expect(() => transform('<p>x</p>')).not.toThrow();
    expect(outcome('<p>x</p>')).toBe('refused: parse_error');
  });

  it('looks at the clock while the page is being written out: a clock that runs out of time only then still refuses it', () => {
    // The clock is read at the start, after the parse and just before the page is written; none of those sees
    // the jump. It happens inside the serializer (for the length of one call of it, so the second pass reads
    // a good clock again and cannot be what notices): only a look that the serializer's own reads of the tree
    // make can. 2,000 paragraphs are 4,000 nodes, a look every 1,024 of them.
    let late = false;
    hooks.beforeSerialize = () => void (late = true);
    hooks.afterSerialize = () => void (late = false);
    const now = (): number => (late ? 10_000 : 0);
    const page = '<p>x</p>'.repeat(2000);
    expect(transform(page, { now, budgetMs: 100 })).toEqual({ ok: false, reason: 'too_slow' });
    // ...and with the clock where it was, the same page is fine.
    expect(transform(page, { now: () => 0, budgetMs: 100 }).ok).toBe(true);
  });

  it('checks the length of what was written, too, whatever the tree said it would be', () => {
    // The count of the tree, made before anything is written, is meant never to be low (a test holds it to
    // that); this is the second check, on the string itself, for the day it is.
    let parses = 0;
    hooks.beforeParse = () => void (parses += 1);
    hooks.serialized = (written) => `${written}${' '.repeat(200_000)}`;
    expect(transform('<p>x</p>')).toEqual({ ok: false, reason: 'output_too_large' });
    // Refused on the string itself, before it is read again: the next pass would refuse it too (its tree
    // weighs what it is), which is why the count of parses is what shows this check is there.
    expect(parses).toBe(1);
    hooks.serialized = undefined;
    expect(transform('<p>x</p>').ok).toBe(true);
  });

  it('refuses a page that keeps growing something to cut as never settling, after exactly four parses', () => {
    let parses = 0;
    hooks.beforeParse = () => void (parses += 1);
    hooks.afterParse = addIframe;
    expect(outcome('<p>x</p>')).toBe('refused: no_fixpoint');
    expect(parses).toBe(4);
  });

  it('still serves a page whose last cut is in the fourth parse, and no later one', () => {
    let parses = 0;
    hooks.beforeParse = () => void (parses += 1);
    hooks.afterParse = (doc) => {
      // Something to cut in the first three parses; the fourth is clean.
      if (parses <= 3) addIframe(doc);
    };
    const out = outcome('<p>x</p>');
    expect(out).not.toMatch(/^refused/);
    expect(out).not.toContain('<iframe');
    expect(parses).toBe(4);
  });

  it('serves a page that settles after two cuts in three parses', () => {
    let parses = 0;
    hooks.beforeParse = () => void (parses += 1);
    hooks.afterParse = (doc) => {
      if (parses <= 2) addIframe(doc);
    };
    expect(outcome('<p>x</p>')).not.toMatch(/^refused/);
    expect(parses).toBe(3);
  });
});

describe('a limit ends the transform in the parse that crosses it', () => {
  // Reading the result back would find most of these too (a tag that grew 300 attributes is one tag with 300
  // in the next pass). The point of a limit is to stop the work, so the number of parses is what shows it.
  const attributes = (from: number, count: number): string => Array.from({ length: count }, (_, i) => ` b${from + i}`).join('');

  it('repeated <body> tags that add too many attributes: one parse, not two', () => {
    let parses = 0;
    hooks.beforeParse = () => void (parses += 1);
    expect(outcome(`<body${attributes(0, 200)}><body${attributes(200, 100)}>`)).toBe('refused: too_many_attrs');
    expect(parses).toBe(1);
  });

  it('a page nested too deep: one parse (and an ordinary page takes two)', () => {
    let parses = 0;
    hooks.beforeParse = () => void (parses += 1);
    expect(outcome('<div>'.repeat(600))).toBe('refused: too_deep');
    expect(parses).toBe(1);
    parses = 0;
    expect(outcome('<p>x</p>'.repeat(50))).not.toMatch(/^refused/);
    expect(parses).toBe(2);
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
