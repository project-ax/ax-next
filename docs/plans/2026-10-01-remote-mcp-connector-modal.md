# Remote MCP connector editor

Refined against the [Figma connector design, node 14-468](https://www.figma.com/design/NrQ1AjWE6L2Op9NlsV3mOP/AX-Components?node-id=14-468), using the existing channel-web shadcn components and semantic tokens. The shared UI primitives, `src/index.css`, and `tailwind.config.ts` remain the design source of truth, including IBM Plex Sans typography; this refinement introduces no design-system changes.

The editor starts with name, server URL, and sign-in. OAuth client settings, request headers, connection details, and admin workspace settings expand on demand. Selecting a custom client reveals its fields; Change method returns to the method choices. The body scrolls while the actions remain visible on small screens.

Request headers use visible Add header and Remove header text actions. Selecting CIMD or DCR keeps an explanation beneath the OAuth client summary: CIMD shares AX's published client details without credentials to enter, while DCR registers a client when an account connects.

Connection details list known server, saved, and discovered hosts separately from the blank Additional allowed hosts (optional) input. Saving unions added hosts with retained original permissions, discovered hosts, and the server hostname.

New connectors are remote HTTPS MCP servers. Existing remote connectors use the new form. Existing connectors whose first server is not HTTP retain their original editor. Loading an existing connector must succeed before editing is allowed, so a failed request cannot replace full capabilities with a summary.

## Authentication and headers

- No sign-in supports public servers and API keys supplied as headers.
- OAuth supports Automatic, AX's published identity (CIMD), automatic registration (DCR), and a registered client ID with an optional secret. Automatic uses existing registered client details first, otherwise CIMD when supported and configured, then DCR.
- CIMD requires AX's configured public HTTPS origin. The public client metadata document lives at `/api/connectors/oauth/client-metadata` and lists the actual callback URL. A request's Host header cannot change this identity. Explicit methods fail clearly when unsupported.
- Up to four headers per remote server can supplement either sign-in mode. Header values and client secrets go to the credential vault. Connector data contains bindings and references only. Header references always include their slot; adding headers preserves existing OAuth token references.
- Saved credentials are never returned to the form. Replacing a saved client secret with an empty input preserves it; removal is explicit. Changing the credential scope requires header values to be supplied again. Changing the resource hostname requires confirmation before saved headers can be reused.

Full capability data is merged rather than rebuilt. Unedited descriptions, usage instructions, additional servers, packages, services, other credential slots, and pinned OAuth endpoints survive. Personal routes do not submit admin sharing or default controls. Existing workspace OAuth settings remain editable without silently changing their credential scope.

At runtime, the orchestrator binds OAuth tokens and headers to the resource hostname and stamps opaque placeholders into HTTP MCP configuration. Both runner and subprocess materializers retain those headers. The proxy substitutes vault values only for the approved destination. Authorization and discovery hosts retain their network permissions without receiving resource credentials.

## Verification

The web package and affected backend packages have regression coverage for preservation, permissions, OAuth registration, header validation and materialization, vault references, runtime stamping, and proxy control-byte rejection. The root build, web production build, ESLint rule tests, and script tests were also checked.

Browser verification uses the actual settings UI with intercepted test APIs. It covers desktop, mobile, short viewports, light and dark themes, reduced motion, disclosures, all client choices, custom credentials and headers, saving, reopening, closing, and keyboard behavior. It does not perform a live third-party OAuth authorization.

The browser check that lived in `scripts/test-remote-mcp-modal.mjs` was deleted in SIGNINS-7 (agent-owned sign-ins, slice 5): it set up a private connector with a per-person key and two secret writes, which the editor no longer allows.

No deployment is part of this change.

## Security review

- **Sandbox:** Secrets remain in the vault; sandbox configuration carries strict placeholders. Credentials are bound to the MCP resource hostname. No additional process, filesystem, or network capabilities are granted by the editor.
- **Injection:** Reserved header names, duplicate names, malformed bindings, and raw values are rejected by host and wire validators. The proxy refuses control bytes in substituted HTTP values. React escapes form content. Existing OAuth state, PKCE, ownership checks, and pinned discovery safeguards remain in force.
- **Supply chain:** No repository dependency or lockfile changes. Playwright was installed outside the repository solely for verification.

No new service hooks were introduced. HTTP header placeholders extend the existing opaque MCP configuration consumed by subprocess and runner implementations; both materializers and the shared wire validator are covered by tests.
