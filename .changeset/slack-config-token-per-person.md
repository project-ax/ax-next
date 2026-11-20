---
'@ax/channel-slack': patch
'@ax/channel-web': patch
'@ax/cli': patch
---

Slack's configuration token now belongs to a person, not to one Slack app. Slack lets each person hold one configuration token per workspace, and only the token of whoever created a Slack app can change or delete it. So AX keeps one token per person and uses it for every Slack app they made through AX. Whenever any of those apps uses it, the fresh token Slack hands back is saved for all of them.

For admins: **Replace** in Admin › Slack now also fixes every other Slack app the same person made through AX, and the token stays that person's, whoever pastes it ("Added by" keeps their name and shows the new date). Disconnect keeps the token while a Slack app we couldn't delete still needs it.

For whoever runs the deployment: the first start after this update moves the token AX already holds to its new place, and logs only counts. Only the host does that: `ax admin reset-bootstrap` leaves it alone. If you roll back past this change, the older build can't find the token: use **Replace** there, and once more after upgrading again.
