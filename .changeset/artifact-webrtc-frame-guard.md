---
'@ax/frame-guard': patch
'@ax/attachments': patch
'@ax/channel-web': patch
'@ax/tool-artifact-publish': patch
---

Add `@ax/frame-guard`, a leaf library holding the in-page WebRTC and child-frame guard that chat visuals use, so artifact HTML can get the same lock from one shared implementation. The content origin now rewrites artifact HTML through it (frames and declarative shadow roots cut, the guard first in `<head>`) on a worker thread of its own (a heap limit, a deadline, a short line of waiting pages, a busy rule), never on the thread that serves requests. The rewrite bounds its own work too: parse depth, node, attribute, call and escaped-character counts, a result of at most 1.5 times the page, strings read flat as they arrive so that the heap follows the biggest token, and a CPU-time budget. It decodes a UTF-16 page with a byte order mark, and answers a page it will not serve (or one over 4 MiB) with a 422 and one of three fixed lines (too large to preview, can't show it right now, or can't show it safely) instead of the 404 a bad token gets; the reason is logged at warn as a code. A refusal about the page is remembered by content hash in a cache of its own, so refusals never push a served page out (a worker timeout, a wall-clock deadline, for a minute only). The `artifact_publish` descriptor names the limits.
