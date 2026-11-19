---
'@ax/channel-slack': patch
'@ax/channel-web': patch
'@ax/preset-k8s': patch
---

The Slack bot gets a real picture when you connect a workspace. Before, we pointed Slack at our logo's web address, and Slack turned it down every time (it needs an image file at least 512 pixels on each side, and a missing logo or a wide SVG wordmark isn't one), so every new bot wore Slack's default face. Now your browser draws the bot's picture from your logo, centred on a white square, and Connect uploads it. A server with no logo and no product name gets the default mark; one with a product name but no logo keeps Slack's default picture. A bot connected before this update keeps its current picture until it's connected again.
