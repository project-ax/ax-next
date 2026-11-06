import { describe, expect, it } from 'vitest';
import {
  VISUAL_FRAME_CSP,
  VISUAL_IFRAME_SANDBOX,
  VISUAL_MAX_HEIGHT,
  VISUAL_TOKEN_NAMES,
  buildVisualDocument,
  inlineScript,
  readThemeTokens,
  sanitizeTokens,
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

  it('adds the standalone page styles only for standalone documents', () => {
    const inline = buildVisualDocument({ html: '', mode: 'light', tokens: {} }, fake);
    const page = buildVisualDocument({ html: '', mode: 'light', tokens: {}, standalone: true }, fake);
    const extra = 'html{overflow:auto;background:hsl(var(--card))}body{max-width:720px;margin:24px auto}';
    expect(inline).not.toContain(extra);
    expect(parse(page).getElementById('ax-base')?.textContent).toContain(extra);
    expect(parse(page).head.firstElementChild!.getAttribute('content')).toBe(VISUAL_FRAME_CSP);
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
  });
});

describe('constants', () => {
  it('sandboxes with scripts only', () => {
    expect(VISUAL_IFRAME_SANDBOX).toBe('allow-scripts');
  });
});
