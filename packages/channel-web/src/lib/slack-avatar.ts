/**
 * The Slack bot's picture (TASK-1133). Slack's `apps.icon.set` wants a square
 * raster 512 to 2000 px a side, and the branding logo is often a wide SVG
 * wordmark, so somebody has to draw a square. The browser does, as
 * `lib/favicon.ts` does for the tab icon: no server-side image library. The
 * PNG rides to the host as `iconPng` in the Connect body.
 *
 * Which picture follows BrandMark's white-label rule:
 *   - a light logo is set          -> that logo
 *   - no logo, no product name     -> the AX mark
 *   - no logo, a custom name       -> none (Slack keeps its default picture;
 *                                     that is not a failure)
 *
 * Branding is read fresh here, not from `useBranding()`: the provider falls
 * back to the default branding when its read fails, which would put the AX
 * mark on a branded server.
 *
 * Best effort end to end: `renderSlackAvatar` never rejects, and any failure
 * (read, load, decode, no canvas, a tainted canvas, 5 s overall) means no
 * picture, so Connect goes on without one.
 */
import markLight from '@/assets/design/ax-mark-light.svg';
import { fetchBranding, logoUrl, type Branding } from './branding';
import { drawSlackAvatar, loadAvatarImage } from './slack-avatar-draw';

export const SLACK_AVATAR_TIMEOUT_MS = 5_000;

/** The URL of the image to draw, or null when there is no picture to send. */
export function slackAvatarSource(branding: Branding): string | null {
  if (branding.light) return logoUrl('light', branding.version);
  // BrandMark's own rule: an empty name is the default "ax".
  if ((branding.name.length > 0 ? branding.name : 'ax') === 'ax') return markLight;
  return null;
}

async function render(): Promise<string | null> {
  try {
    const source = slackAvatarSource(await fetchBranding());
    if (source === null) return null;
    const image = await loadAvatarImage(source, SLACK_AVATAR_TIMEOUT_MS);
    return drawSlackAvatar(image);
  } catch {
    return null;
  }
}

/** Base64 PNG for Connect's `iconPng`, or null for "send no picture". Never rejects. */
export function renderSlackAvatar(): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, SLACK_AVATAR_TIMEOUT_MS);
    void render().then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}
