/**
 * The drawing half of the Slack bot's picture (TASK-1133): load an image,
 * contain it in an opaque white 512 px square, export a PNG.
 *
 * IMPORT-FREE on purpose. `__tests__/slack-avatar.browser.test.ts` transpiles
 * this file and loads it into real Chromium, the way `visual-hostile.browser
 * .test.ts` loads `visual-doc.ts`; an import here would break that load.
 */

/** Slack's `apps.icon.set` takes 512 to 2000 px a side; we send the minimum. */
export const SLACK_AVATAR_PX = 512;

/** White margin on every side, so a wide wordmark isn't cropped by Slack's rounded mask. */
export const SLACK_AVATAR_INSET_PX = 64;

/**
 * Mirrors @ax/channel-slack's SLACK_ICON_MAX_BYTES (limits.ts). Duplicated,
 * not imported: channel-web never imports a host plugin. If one changes,
 * change the other.
 */
export const SLACK_AVATAR_MAX_BYTES = 1_048_576;

const PNG_PREFIX = 'data:image/png;base64,';

/** Resolves once the image has decoded; rejects on a load error or after `timeoutMs`. */
export function loadAvatarImage(url: string, timeoutMs: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => {
      reject(new Error('avatar image load timed out'));
    }, timeoutMs);
    image.addEventListener('load', () => {
      clearTimeout(timer);
      resolve(image);
    });
    image.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('avatar image failed to load'));
    });
    image.src = url;
  });
}

/**
 * Draws `image` (aspect kept, centred) into the box inset from a 512 px opaque
 * white square and returns the PNG as bare base64 (no `data:` prefix), or null
 * when anything goes wrong (no 2d context, a tainted canvas, a PNG over the cap).
 */
export function drawSlackAvatar(image: HTMLImageElement): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = SLACK_AVATAR_PX;
  canvas.height = SLACK_AVATAR_PX;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  // Image content, not a UI colour. The light logo variant is made for light
  // backgrounds, and Slack shows one picture in both of its themes.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SLACK_AVATAR_PX, SLACK_AVATAR_PX);

  // contain: the largest fit in the inset box, centred in the whole square. A
  // zero natural size (an SVG with only a viewBox) reads as the box; the SVG's
  // own preserveAspectRatio then letterboxes it.
  const box = SLACK_AVATAR_PX - 2 * SLACK_AVATAR_INSET_PX;
  const iw = image.naturalWidth || image.width || box;
  const ih = image.naturalHeight || image.height || box;
  const scale = Math.min(box / iw, box / ih);
  const dw = Math.max(1, Math.round(iw * scale));
  const dh = Math.max(1, Math.round(ih * scale));
  const dx = Math.round((SLACK_AVATAR_PX - dw) / 2);
  const dy = Math.round((SLACK_AVATAR_PX - dh) / 2);

  let dataUrl: string;
  try {
    ctx.drawImage(image, dx, dy, dw, dh);
    dataUrl = canvas.toDataURL('image/png');
  } catch {
    return null; // decode or taint failure
  }
  if (!dataUrl.startsWith(PNG_PREFIX)) return null;
  const base64 = dataUrl.slice(PNG_PREFIX.length);
  if (Math.floor((base64.length * 3) / 4) > SLACK_AVATAR_MAX_BYTES) return null;
  return base64;
}
