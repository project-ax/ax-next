// Shared defense for agent-authored HTML that runs in a sandboxed frame:
//   - the in-page guard script (WebRTC and child-context locks) and the lists
//     of markup that can open a child browsing context (guard.ts), and
//   - the server-side transform that strips that markup from a page and puts
//     the guard first in its <head> (prepare-html.ts).
// Pure library: no plugin manifest, no hooks. The chat visual (channel-web)
// and the artifact content origin (attachments) both consume it, so the two
// can't drift apart.
export { CHILD_FRAME_TAGS, DSD_ATTRS, FRAME_GUARD_SOURCE } from './guard.js';
export { prepareArtifactHtml } from './prepare-html.js';
