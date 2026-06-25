/**
 * Favicon generation. The browser-tab icon is derived from the current logo
 * client-side — no separate favicon upload, no server-side image library. We
 * draw the (already-loaded, same-origin) logo image into a 64×64 transparent
 * square (object-fit *contain*), optionally inverting for a light-only logo in
 * dark mode, then swap `<link rel="icon">` to the PNG data URL.
 *
 * Same-origin image ⇒ the canvas is not tainted ⇒ toDataURL succeeds.
 */

const FAVICON_ID = 'ax-favicon';
const FAVICON_SIZE = 64;
const INVERT_FILTER = 'invert(1) hue-rotate(180deg)';

function setFaviconHref(href: string): void {
  let link = document.getElementById(FAVICON_ID) as HTMLLinkElement | null;
  if (link === null) {
    link = document.createElement('link');
    link.id = FAVICON_ID;
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/png';
  link.href = href;
}

export function applyFaviconFromImage(
  image: HTMLImageElement,
  opts: { invert: boolean },
): void {
  const canvas = document.createElement('canvas');
  canvas.width = FAVICON_SIZE;
  canvas.height = FAVICON_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return; // no 2d backend (e.g. jsdom) — leave the favicon as-is

  // contain: largest fit that preserves aspect ratio, centered.
  const iw = image.naturalWidth || image.width || FAVICON_SIZE;
  const ih = image.naturalHeight || image.height || FAVICON_SIZE;
  const scale = Math.min(FAVICON_SIZE / iw, FAVICON_SIZE / ih);
  const dw = Math.max(1, Math.round(iw * scale));
  const dh = Math.max(1, Math.round(ih * scale));
  const dx = Math.round((FAVICON_SIZE - dw) / 2);
  const dy = Math.round((FAVICON_SIZE - dh) / 2);

  if (opts.invert) ctx.filter = INVERT_FILTER;

  try {
    ctx.drawImage(image, dx, dy, dw, dh);
  } catch {
    return; // decode/taint failure — keep the existing favicon
  }

  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch {
    return; // tainted canvas — keep the existing favicon
  }
  setFaviconHref(dataUrl);
}

/** Remove our injected favicon link, restoring the browser default. */
export function resetFaviconToDefault(): void {
  document.getElementById(FAVICON_ID)?.remove();
}
