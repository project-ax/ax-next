import { describe, expect, it } from 'vitest';
import {
  VISUAL_FRAME_CSP,
  VISUAL_IFRAME_SANDBOX,
  VISUAL_MAX_HEIGHT,
  VISUAL_TOKEN_NAMES,
  VISUAL_TOKEN_VALUE,
  buildVisualDocument,
  inlineScript,
  readThemeTokens,
  sanitizeTokens,
  stripChildFrames,
  visualFileName,
  type VisualAssets,
} from '../visual-doc';

const fake: VisualAssets = { fontFaceCss: '/*f*/', librarySources: ['/*lib*/'], runtimeSource: '/*rt*/' };
const parse = (doc: string) => new DOMParser().parseFromString(doc, 'text/html');

describe('buildVisualDocument', () => {
  it('puts the CSP meta first in head with the exact policy', () => {
    const d = parse(buildVisualDocument({ html: '<p>hi</p>', mode: 'light', tokens: {} }, fake));
    const first = d.head.firstElementChild!;
    expect([first.getAttribute('http-equiv'), first.getAttribute('content')]).toEqual([
      'Content-Security-Policy',
      VISUAL_FRAME_CSP,
    ]);
    for (const bad of ["'unsafe-eval'", 'http:', 'https:', '*']) expect(VISUAL_FRAME_CSP).not.toContain(bad);
  });

  it('starts the raw string with the CSP meta right after <head>, ahead of any other markup', () => {
    const doc = buildVisualDocument({ html: '<p>hi</p>', mode: 'light', tokens: {} }, fake);
    expect(doc.startsWith(
      `<!doctype html><html lang="en" data-theme="light" data-max-height="${VISUAL_MAX_HEIGHT}"><head>` +
        `<meta http-equiv="Content-Security-Policy" content="${VISUAL_FRAME_CSP}">`,
    )).toBe(true);
  });

  it('(RF2) keeps the box around a whole agent document', () => {
    const html =
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><style>.k{color:hsl(var(--primary))}</style></head><body><div class="k">x</div></body></html>';
    const d = parse(buildVisualDocument({ html, mode: 'light', tokens: {} }, fake));
    expect(d.head.firstElementChild!.getAttribute('content')).toBe(VISUAL_FRAME_CSP);
    expect(d.querySelectorAll('html')).toHaveLength(1);
    expect(d.documentElement.innerHTML).toContain('.k{color:hsl(var(--primary))}');
    expect(d.querySelector('body .k')?.textContent).toBe('x');
  });

  it('runs the runtime from head, after the libraries, before any agent markup', () => {
    const d = parse(
      buildVisualDocument(
        { html: '<script>window.agent=1</script><p>x</p>', mode: 'light', tokens: {} },
        { ...fake, librarySources: ['/*lib1*/', '/*lib2*/'] },
      ),
    );
    const headScripts = [...d.head.querySelectorAll('script')].map((s) => s.textContent ?? '');
    expect(headScripts).toHaveLength(3);
    expect(headScripts[0]).toContain('/*lib1*/');
    expect(headScripts[1]).toContain('/*lib2*/');
    expect(headScripts[2]!.startsWith('/*rt*/')).toBe(true);
    expect(headScripts[2]!.endsWith('axVisualRuntime(window, parent);')).toBe(true);
    // The agent's own script lands in body, after everything we inject.
    expect(d.body.querySelector('script')?.textContent).toBe('window.agent=1');
  });

  it('lays out head in the documented order', () => {
    const d = parse(buildVisualDocument({ html: '', mode: 'light', tokens: {} }, fake));
    const order = [...d.head.children].map(
      (el) => el.id || el.getAttribute('http-equiv') || (el.hasAttribute('charset') ? 'charset' : el.tagName),
    );
    expect(order).toEqual([
      'Content-Security-Policy',
      'x-dns-prefetch-control',
      'charset',
      'ax-fonts',
      'ax-theme',
      'ax-base',
      'SCRIPT',
      'SCRIPT',
    ]);
    expect(d.getElementById('ax-fonts')?.textContent).toBe('/*f*/');
  });

  it('escapes </script inside inlined sources', () => {
    const d = parse(
      buildVisualDocument(
        { html: '', mode: 'light', tokens: {} },
        { ...fake, librarySources: ['var s="</script><img src=x>";'] },
      ),
    );
    expect(d.head.querySelector('img')).toBeNull();
    expect(d.head.innerHTML).toContain('<\\/script>');
  });

  it('strips a trailing sourceMappingURL comment from library sources', () => {
    const doc = buildVisualDocument(
      { html: '', mode: 'light', tokens: {} },
      { ...fake, librarySources: ['var a=1;\n//# sourceMappingURL=chart.umd.min.js.map\n'] },
    );
    expect(doc).toContain('var a=1;');
    expect(doc).not.toContain('sourceMappingURL');
  });

  it('writes only allow-listed, well-formed tokens', () => {
    const doc = buildVisualDocument(
      {
        html: '',
        mode: 'dark',
        tokens: {
          '--background': '226.67 15.25% 11.57%',
          '--radius': '0.5625rem',
          '--evil': '0 0% 0%',
          '--card': 'red;}</style><script>x</script>',
        },
      },
      fake,
    );
    expect(doc).toContain('--background:226.67 15.25% 11.57%');
    expect(doc).toContain('--radius:0.5625rem');
    expect(doc).not.toContain('--evil');
    expect(doc).not.toContain('<script>x</script>');
    expect(doc).toContain('color-scheme:dark');
    expect(doc).toContain('data-theme="dark"');
  });

  it('never writes an unknown mode into the theme attribute', () => {
    const doc = buildVisualDocument(
      { html: '', mode: '"><script>x</script>' as unknown as 'light', tokens: {} },
      fake,
    );
    expect(doc).toContain('data-theme="light"');
    expect(doc).not.toContain('<script>x</script>');
  });

  it('refuses font CSS that could close its style element', () => {
    expect(() =>
      buildVisualDocument({ html: '', mode: 'light', tokens: {} }, { ...fake, fontFaceCss: 'a{}</STYLE><script>x</script>' }),
    ).toThrow(/<\/style/);
  });
});

describe('buildVisualDocument standalone', () => {
  const standalone = (html: string, title: string) =>
    buildVisualDocument({ html, mode: 'dark', tokens: { '--card': '0 0% 10%' }, standalone: true, title }, fake);

  it('boxes the visual in a sandboxed frame under a script-free outer page', () => {
    const outer = parse(standalone('<div class="k">x</div><script>window.agent=1</script>', 'Issues'));
    const first = outer.head.firstElementChild!;
    // The frame inherits this policy, so it must be exactly the frame's own.
    expect([first.getAttribute('http-equiv'), first.getAttribute('content')]).toEqual([
      'Content-Security-Policy',
      VISUAL_FRAME_CSP,
    ]);
    expect(outer.querySelectorAll('script')).toHaveLength(0);
    const frames = outer.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frames[0]!.getAttribute('title')).toBe('Issues');
    expect(outer.title).toBe('Issues');

    const inner = parse(frames[0]!.getAttribute('srcdoc')!);
    expect(inner.head.firstElementChild!.getAttribute('content')).toBe(VISUAL_FRAME_CSP);
    expect(inner.querySelector('body .k')?.textContent).toBe('x');
    expect(inner.body.querySelector('script')?.textContent).toBe('window.agent=1');
    expect(inner.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(inner.getElementById('ax-base')?.textContent).toContain('html{overflow:auto');
  });

  it('keeps a hostile title and agent markup out of the outer page', () => {
    const hostile = '"><script>x</script>';
    const raw = standalone('</iframe><script>y</script>"', hostile);
    const outer = parse(raw);
    expect(outer.querySelectorAll('script')).toHaveLength(0);
    expect(outer.querySelectorAll('iframe')).toHaveLength(1);
    expect(outer.body.children).toHaveLength(1);
    expect(outer.querySelector('iframe')!.getAttribute('title')).toBe(hostile);
    expect(outer.title).toBe(hostile);
  });

  it('leaves the in-chat document without the standalone frame styles', () => {
    const inline = parse(buildVisualDocument({ html: '', mode: 'light', tokens: {} }, fake));
    expect(inline.getElementById('ax-base')?.textContent).not.toContain('overflow:auto');
    expect(inline.querySelector('iframe')).toBeNull();
  });
});

describe('inlineScript', () => {
  it('breaks </script and <!-- in any case', () => {
    expect(inlineScript('a</SCRIPT>b</script c<!--d')).toBe('a<\\/SCRIPT>b<\\/script c<\\!--d');
  });
});

describe('sanitizeTokens', () => {
  it('keeps allow-listed names with HSL triplet or length values', () => {
    expect(
      sanitizeTokens({
        '--primary': ' 242.71deg 63.03% 58.63% ',
        '--radius': '9px',
        '--chart-5': '0 0% 100%',
        '--ring': 'hsl(0 0% 0%)',
        '--muted': '0 0% 0%; color: red',
        '--radius-panel': '1rem',
      }),
    ).toEqual({ '--primary': '242.71deg 63.03% 58.63%', '--radius': '9px', '--chart-5': '0 0% 100%' });
  });

  it('lifts --muted 5 points of lightness off --card when they are equal (dark), clamped to 100', () => {
    const dark = '226.67 15.25% 11.57%';
    expect(sanitizeTokens({ '--card': dark, '--muted': dark, '--muted-foreground': '219 11.9% 67.06%' })).toEqual({
      '--card': dark,
      '--muted': '226.67 15.25% 16.57%',
      '--muted-foreground': '219 11.9% 67.06%', // untouched
    });
    // Equal after trimming, any hue unit; never above 100%.
    const out = sanitizeTokens({ '--card': '0deg 0% 98%', '--muted': ' 0deg 0% 98% ' });
    expect(out['--muted']).toBe('0deg 0% 100%');
    for (const v of Object.values(out)) expect(v).toMatch(VISUAL_TOKEN_VALUE);
  });

  it('leaves --muted alone when it differs from --card, or either is missing', () => {
    const light = { '--card': '0 0% 100%', '--muted': '220 14.29% 95.88%' };
    expect(sanitizeTokens(light)).toEqual(light);
    expect(sanitizeTokens({ '--muted': '0 0% 100%' })).toEqual({ '--muted': '0 0% 100%' });
    expect(sanitizeTokens({ '--card': '0 0% 100%', '--muted': 'bogus' })).toEqual({ '--card': '0 0% 100%' });
  });

  it('lists the documented token names', () => {
    expect(VISUAL_TOKEN_NAMES).toContain('--chart-1');
    expect(VISUAL_TOKEN_NAMES).toContain('--chart-5');
    expect(VISUAL_TOKEN_NAMES).toContain('--warning');
    expect(VISUAL_TOKEN_NAMES).toHaveLength(22);
  });
});

describe('readThemeTokens', () => {
  it('reads computed custom properties through the sanitizer', () => {
    const el = document.createElement('div');
    el.style.setProperty('--background', '0 0% 100%');
    el.style.setProperty('--card', 'url(x)');
    document.body.appendChild(el);
    try {
      expect(readThemeTokens(el)).toEqual({ '--background': '0 0% 100%' });
    } finally {
      el.remove();
    }
  });
});

describe('visualFileName', () => {
  it('names downloads from the title', () => {
    expect(visualFileName('Issues per cycle (Q3)', 'png')).toBe('Issues per cycle Q3.png');
    expect(visualFileName('<script>', 'html')).toBe('script.html');
    expect(visualFileName('  ...  ', 'png')).toBe('visual.png');
    expect(visualFileName('x'.repeat(200), 'html')).toBe(`${'x'.repeat(80)}.html`);
    expect(visualFileName('../../etc/passwd', 'html')).toBe('etcpasswd.html');
    expect(visualFileName('. .bashrc', 'html')).toBe('bashrc.html');
    expect(visualFileName('..  ..env', 'png')).toBe('env.png');
  });
});

describe('constants', () => {
  it('sandboxes with scripts only', () => {
    expect(VISUAL_IFRAME_SANDBOX).toBe('allow-scripts');
  });
});

describe('stripChildFrames', () => {
  it('returns markup with nothing to strip as the very same string', () => {
    const html = '<style>.a{color:red}</style><div class="a">x</div><script>1<2</script><template><p>t</p></template>';
    expect(stripChildFrames(html)).toBe(html);
  });

  it('removes every element that can open a child frame', () => {
    for (const tag of ['iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe', 'noscript']) {
      const out = stripChildFrames(`<p>keep</p><div><${tag} src="data:text/html,x"></${tag}></div>`);
      const d = parse(`<!doctype html>${out}`);
      expect(d.querySelector(tag), tag).toBeNull();
      expect(d.querySelector('p')?.textContent, tag).toBe('keep');
    }
  });

  it('removes them inside template contents, nested', () => {
    const out = stripChildFrames('<template><div><template><iframe srcdoc="x"></iframe></template></div></template>');
    expect(out).not.toMatch(/iframe/i);
    expect(out).toMatch(/<template><div><template><\/template><\/div><\/template>/);
  });

  it('drops declarative shadow roots', () => {
    for (const attr of ['shadowrootmode="open"', 'shadowrootmode="closed"', 'shadowroot="open"']) {
      const out = stripChildFrames(`<div><template ${attr}><b>x</b></template></div>`);
      expect(out).not.toMatch(/shadowroot/i);
      expect(out).toContain('<b>x</b>');
    }
  });

  it("closes the noscript smuggle (markup to us, raw text to the frame)", () => {
    // With scripting on (the frame), the noscript body is raw text up to the
    // first </noscript>, so the "attribute" below would become a real iframe.
    for (const html of [
      '<div><noscript><p title="</noscript><iframe srcdoc=x>"></p></noscript></div><i>ok</i>',
      '<noscript><p title="</noscript><iframe srcdoc=x>"></p></noscript><i>ok</i>',
    ]) {
      const out = stripChildFrames(html);
      expect(out).not.toMatch(/<noscript/i);
      const d = parse(`<!doctype html><body>${out}`);
      expect(d.querySelectorAll('noscript,iframe')).toHaveLength(0);
      expect(d.querySelector('i')?.textContent).toBe('ok');
    }
  });

  it('is applied to the agent markup, keeping CSP first and a whole agent document', () => {
    const html =
      '<!doctype html><html><head><style>.k{color:hsl(var(--primary))}</style></head><body><div class="k">x</div><iframe srcdoc="y"></iframe></body></html>';
    const doc = buildVisualDocument({ html, mode: 'light', tokens: {} }, fake);
    const d = parse(doc);
    expect(d.head.firstElementChild!.getAttribute('content')).toBe(VISUAL_FRAME_CSP);
    expect(d.querySelector('iframe')).toBeNull();
    expect(d.documentElement.innerHTML).toContain('.k{color:hsl(var(--primary))}');
    expect(d.querySelector('body .k')?.textContent).toBe('x');
  });
});
