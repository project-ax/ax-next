---
'@ax/frame-guard': patch
'@ax/attachments': patch
'@ax/channel-web': patch
---

Add `@ax/frame-guard`, a leaf library holding the in-page WebRTC and child-frame guard that chat visuals use, so artifact HTML can get the same lock from one shared implementation. The content origin now rewrites artifact HTML through it (frames and declarative shadow roots cut, the guard first in `<head>`), bounds that work (parse depth, node, attribute and call counts, a CPU-time budget), decodes a UTF-16 page with a byte order mark, and answers a page it will not serve (or one over 4 MiB) with a 422 and one fixed line instead of the 404 a bad token gets; the reason is logged at warn as a code.
