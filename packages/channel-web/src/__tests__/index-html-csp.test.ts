// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_FRAME_CSP } from '../components/workspace/visual/visual-doc';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('index.html CSP', () => {
  it("the app shell carries exactly one CSP, frame-src 'none', inside head", () => {
    const html = readFileSync(join(PKG_DIR, 'index.html'), 'utf8');
    const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi)];
    expect(metas.map((m) => m[1])).toEqual([APP_FRAME_CSP]);
    expect(html.indexOf(metas[0]![0])).toBeLessThan(html.indexOf('</head>'));
  });
});
