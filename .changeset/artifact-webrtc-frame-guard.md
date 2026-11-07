---
'@ax/frame-guard': patch
'@ax/attachments': patch
'@ax/channel-web': patch
---

Add `@ax/frame-guard`, a leaf library holding the in-page WebRTC and child-frame guard that chat visuals use, so artifact HTML can get the same lock from one shared implementation.
