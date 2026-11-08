---
'@ax/attachments': patch
'@ax/channel-web': patch
'@ax/tool-artifact-publish': patch
---

An HTML artifact opened in the viewer now picks up the app's colors. The viewer asks for light or dark in the signed view token, and the content origin adds one fixed `<style>` block of `--ax-*` color variables to the page after it has been through the frame guard (the page cache is keyed on the page's own bytes, so a theme never changes what is cached). The `artifact_publish` description names the variables. An open artifact's viewer draws its own header (no second "Artifacts" row or close button), and versions move into the ⋯ menu, with a slim "Back to latest / Restore" bar when an older version is on screen.
