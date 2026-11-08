import { describe, expect, it } from 'vitest';
import { FRAME_GUARD_SOURCE, prepareArtifactHtml } from '@ax/frame-guard';
import { injectTheme, themeStyleElement } from '../artifacts/theme.js';

// The theme block goes onto a page that has already been through the frame guard. The guard's output is the
// page re-serialized, so the author's text can sit in places a regex for "<head>" would find first: an attribute
// of <html>, or the doctype name. A block put there can close the tag early and turn the rest of the author's
// attribute into live markup AHEAD of the guard, where its script runs before the WebRTC locks exist.

function themed(page: string, theme: 'light' | 'dark' = 'dark'): string {
  const prepared = prepareArtifactHtml(page);
  if (!prepared.ok) throw new Error(`refused: ${prepared.reason}`);
  return Buffer.from(injectTheme(Buffer.from(prepared.html, 'utf8'), theme)).toString('utf8');
}

/** The end of the guard's own <script> element: the first one after the guard's text that the REWRITE put first in <head>. */
function guardEnd(out: string): number {
  const open = out.lastIndexOf('<head><script>' + FRAME_GUARD_SOURCE);
  expect(open).toBeGreaterThan(-1);
  return out.indexOf('</script>', open) + '</script>'.length;
}

describe('the theme block cannot be used to run page script ahead of the frame guard', () => {
  const SMUGGLED = '<script>window.__ahead=1</script>';
  const pages: Array<[string, string]> = [
    ['an <html> attribute that holds a <head> tag', `<html a='<head>${SMUGGLED}'><body>x</body></html>`],
    ['an <html> attribute that holds <head> then a quote', `<html a='<head>"${SMUGGLED}'><body>x</body></html>`],
    ['a doctype name that looks like a <head> tag', `<!DOCTYPE <head>${SMUGGLED}><html><body>x</body></html>`],
    ['an <html> attribute NAME that looks like a <head> tag', `<html <head>${SMUGGLED}=1><body>x</body></html>`],
  ];

  it.each(pages)('%s', (_name, page) => {
    const out = themed(page);
    const style = themeStyleElement('dark');
    // The block is there, exactly once, straight after the guard's script element and nowhere else.
    expect(out.split(style)).toHaveLength(2);
    expect(out.slice(guardEnd(out))).toMatch(/^<style>/);
    // Nothing the page wrote can have been opened into markup before the guard.
    expect(out.slice(0, guardEnd(out))).not.toContain('<style');
  });

  it('a copy of the guard text inside an <html> attribute is not mistaken for the real one', () => {
    const asValue = FRAME_GUARD_SOURCE.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const out = themed(`<html a="<head><script>${asValue}</script>${SMUGGLED}"><body>x</body></html>`);
    expect(out).toContain('<head><script>' + FRAME_GUARD_SOURCE.replace(/&/g, '&amp;').replace(/"/g, '&quot;'));
    expect(out.split(themeStyleElement('dark'))).toHaveLength(2);
    expect(out.slice(guardEnd(out))).toMatch(/^<style>/);
    expect(out.slice(0, guardEnd(out))).not.toContain('<style');
  });

  it('comments before the doctype and before <html> do not stop the block being added', () => {
    const out = themed('<!-- a --><!DOCTYPE html><!-- b --><html lang="en"><body>x</body></html>');
    expect(out).toContain(themeStyleElement('dark'));
    expect(out.slice(guardEnd(out))).toMatch(/^<style>/);
  });

  it('a page with no <head> tag of its own still gets the block after the guard', () => {
    const out = themed('<p>hello</p>');
    expect(out).toContain(themeStyleElement('dark'));
    expect(guardEnd(out)).toBeLessThanOrEqual(out.indexOf(themeStyleElement('dark')));
  });

  it('the block carries no attribute, so it cannot close a quote it was dropped into', () => {
    expect(themeStyleElement('light')).toMatch(/^<style>[^"<>]*<\/style>$/);
    expect(themeStyleElement('dark')).toMatch(/^<style>[^"<>]*<\/style>$/);
  });

  it('output the scanner does not recognise is served without the block, never with it somewhere else', () => {
    for (const odd of [
      '<!DOCTYPE html><html><head><title>t</title></head><body>no guard here</body></html>',
      '<p>not even a document</p>',
      '<html a=unquoted><head><script>x</script></head></html>',
    ]) {
      expect(Buffer.from(injectTheme(Buffer.from(odd), 'dark')).toString('utf8')).toBe(odd);
    }
  });
});
