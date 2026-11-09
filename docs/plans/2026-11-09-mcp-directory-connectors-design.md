# MCP directory search for admin connectors — design

**Status:** draft for review · 2026-11-09
**Mock:** https://claude.ai/artifact/G9CKHAdrkko6tXDQg8ZNy9 (clickable; the State tweaks switch dark mode, a stale list, an unreachable registry and hiding community listings)

## Problem

To add a remote MCP connector today, an admin has to already know the server's
address, whether it uses sign-in or a key, and which header the key goes in. That's
plumbing a non-technical admin shouldn't have to dig up. The official MCP Registry
(`registry.modelcontextprotocol.io`) publishes exactly that metadata for thousands
of servers.

## Decisions

1. **Admins only.** Registry search lives in Admin › Connectors ("Find in
   directory"). The agent's Add view doesn't show it. Admins already define every
   connector (slice 2a), so the directory is just a faster way to fill in a
   definition. It adds no new authority.
2. **We mirror the registry; we don't proxy it.** The registry's aggregator guide
   ([registry-aggregators.mdx](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/registry-aggregators.mdx))
   says to sync about hourly with `updated_since` plus cursor paging, and to keep our
   own copy because it promises no uptime or durability. The guide documents no
   search endpoint. So: a host-side sync job writes to our DB, and search runs
   against our copy.

   The details, measured on 2026-11-09. We read the list endpoint
   `GET /v0.1/servers?version=latest`. The checkpoint is the time the sync
   started. The next sync asks for `updated_since` that checkpoint minus a
   10-minute overlap, so a slow write on their side can't slip through. We cap
   stored rows at 100,000. The first 60,000 registry entries held 40,135 remote
   listings, and a 20,000 cap would have cut the crawl off at `io.github.E…`.
3. **Only remote (HTTP) servers.** Our connector schema is `transport: 'http'`
   only. We keep entries with `remotes[]` (streamable-http / sse) and drop
   package-only entries (npm/pypi/oci, which run locally). The UI says so in one
   footnote.
4. **"Set it up" reuses the existing prefill path.** A directory entry maps to
   `ConnectorPrefill` (the same type `prefillFromProposal` produces for agent
   requests) and opens the normal create editor. Nothing is saved until the admin
   presses Save, and the save goes through the same `/admin/connectors` write and
   validation as hand entry.
5. **Show the publisher's proof, rank by it.** The registry checks one thing: that
   the publisher controls the namespace. A reverse-DNS name (`com.linear/…`) means
   they proved control of a domain (DNS/HTTP challenge). An `io.github.<user>/…`
   name means they proved control of a GitHub account. Every `io.github…`
   namespace counts as `account`, whatever follows it. Domain-verified entries rank
   first and show a shield plus the domain. Account-proven entries (every
   `io.github…` namespace, and any namespace that isn't a clean domain) say
   "Community · X" and, in detail, "It isn't checked against any company." The UI
   never says "GitHub": `account` doesn't promise a GitHub account, and a
   subregistry or curated list can have other kinds. This is
   the defense against a lookalike ("Notion Tasks" by a random user ranks below
   Notion's own). A listing whose verified domain contains the query as a whole
   label also ranks first, because Notion's, Stripe's and PayPal's listings have
   no title.

   One note on `auth`. The registry has no sign-in declaration, so we never derive
   `'signin'` from it. `'none'` only means "declares no required key". The editor
   finds out about sign-in from the address.
6. **No list until the admin types.** The directory view opens on the search box
   and the "List updated N min ago" line only. We have no popularity data, so we
   don't pretend to rank by it. Results appear once there is a query.
7. **Self-hosters can hide community listings.** A deployment setting
   (`connectorDirectory.verifiedPublishersOnly`, default `false`) drops
   GitHub-namespace entries from search, at the plugin rather than in the UI. When
   it's on, the view says "Only listings from verified publishers are shown in this
   workspace." Admins can still set up any server by hand.
8. **We remember where a connector came from.** Saving from the directory records
   `{ directoryId, version }` against the new connector's id (where it lives:
   Resolved question 4). This is opaque provenance owned by the directory plugin, not
   registry vocabulary. It lets a
   later change say "a newer version is listed". Editing the address by hand keeps
   the provenance but marks it edited. An address changed in the editor before the
   first save counts too. The mark is best-effort: an address changed while the
   directory is off, or a mark that fails, leaves it unmarked, so whatever reads
   it re-checks the live connector's address before claiming it matches its
   listing.
9. **Honest freshness.** The list shows "List updated N min ago". If sync fails
   while we hold a copy, a warning says how old it is. If no sync has ever
   succeeded (air-gapped install), we show an empty state and point to "New
   connector".

## Shape

- **New plugin `@ax/connector-directory`.** It owns the mirrored table and the sync
  job, and registers one service hook:
  - `connectors:directory-search({ query, limit?, cursor? }) → { enabled, entries, syncedAt, stale, verifiedOnly, nextCursor? }`
  - `entry = { id, title, description, publisher, publisherProof: 'domain' | 'account', url, auth: 'signin' | 'key' | 'none', keyHeader?, version, updatedAt, deprecated? }`
- **Admin route** in the connectors plugin's `admin-routes.ts`
  (`GET /admin/connectors/directory?q=&cursor=`). It's admin-gated like the other admin
  connector reads, and it calls the hook. No cross-plugin import.
- **channel-web:** `ConnectorsTab` gains a "Find in directory" action and a
  directory subview (rows plus a `SettingsDetailRow`-style sheet), then hands a
  `ConnectorPrefill` to `ConnectorEditDialog`.

### Boundary review (draft)

- **Alternate impl:** any subregistry that implements the registry's OpenAPI spec
  (the guide's intended pattern for aggregators), or a static curated list baked
  into the deployment for air-gapped installs.
- **Payload names that might leak:** none intended. `remotes`, `packages`,
  `_meta`, `nextCursor`-as-registry-cursor and the `io.github.*` naming scheme
  stay inside the plugin. `publisherProof` is generic.
- **Subscriber risk:** low. One service hook with no subscriber payload.
- **Wire surface:** an HTTP admin route only. No IPC action, and the sandbox never
  sees the directory.

## Security (to walk with `security-checklist`)

- **Every registry field is untrusted.** Anyone can publish to the registry.
  Title, description and URL are rendered as React text and never as HTML. The
  description becomes the connector's usage note only after the admin saves it in
  the editor, and the editor tells them to rewrite it. That note later reaches the
  model, so it gets whatever fencing usage notes already get.
- **Network reach.** The sync job is the only new egress, to one fixed host, from
  the host and never from the sandbox. Self-hosters can turn it off
  (`connectorDirectory.enabled: false`) or point it at a subregistry URL.
- **No bypass.** A prefilled URL goes through the same `connectors:upsert` path
  as a typed one. That path doesn't check URLs on the server. The directory only
  stores https listings with no credentials or templates, and the connect-time
  guards (mcp-oauth `ssrf.ts`, mcp-client `safe-fetch.ts`) apply as for any
  connector. Header names go through the same reserved-header refine in
  `types.ts`.
- **Moderation.** Entries the registry marks `status: deleted` are hidden on the
  next incremental sync. `deprecated` entries are shown with a note.
- **Sizes.** Cap description and title length at sync time, and cap total rows,
  so a hostile publisher can't bloat our DB.

## Out of scope

- Non-admin discovery, agent-proposed connectors drawn from the directory
  (`tool-connector-propose`), and local-package (stdio) servers.
- Ratings and download counts from third-party subregistries' `_meta`.

## Resolved questions (2026-11-09)

1. Default view before typing: **no list**. Results appear only once the admin
   types (decision 6).
2. Hiding community listings: **yes**, as a deployment setting (decision 7).
3. Recording provenance: **yes** (decision 8). "A newer version is listed" is a
   follow-up, not part of the first PR.

4. Where provenance lives: **a directory-plugin table keyed by connector id**, not
   a column on the connector definition. That keeps one source of truth per concept
   (invariant 4) and keeps directory vocabulary out of the connectors schema. The
   directory plugin learns about a save through the admin route passing the
   `directoryId` it was prefilled with. When a connector is deleted, its
   provenance row goes with it, because the directory plugin subscribes to the
   connectors' existing delete/purge path. It subscribes to `connectors:deleted`
   and drops the row only when no live connector still carries the id
   (`idStillLive: false`): connector ids are unique per owner, not across owners.

## Open questions

None at the moment.
