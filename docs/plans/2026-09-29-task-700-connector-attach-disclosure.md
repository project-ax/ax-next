# TASK-700 — say plainly what an attached key lets the agent do

Launch disclosure for TASK-328. Vinay chose "accept and disclose" on 2026-09-29:
connector tools run without a per-call approval, so at every place a person hands
an agent a key we say what that means, in words a non-technical person can act on.

## What is true today (re-read from code, not from the card)

| Claim we make | Where it is true |
| --- | --- |
| The assistant gets the access the key has | `chat-orchestrator/src/connector-union.ts` folds defaults + per-agent attachments + **every connector the owner owns** into the session; the credential proxy substitutes the stored key on requests to the connector's bound hosts (TASK-687). |
| It can read or change things without asking each time | `tool-policy/src/evaluate.ts`: a connector tool (`mcp.<id>.<tool>`) matches no rule, and "no rule matching is `allow`". `Bash` is `allow` (`rules.ts`). The known hole is documented there (TASK-263) and the durable per-tool grant (TASK-328) is what would close it. |
| Something it reads can steer it | Prompt injection is the standing threat model; `web_extract` is the one input path that already asks (`hold`), the rest do not. |
| Narrow keys are better | Advice, not a claim about the product. |

We do **not** claim: that the agent cannot see the key (the neighbouring `KEY_SAFETY` line already says it never does, and
that stays untouched), that anything is logged, or that a protection exists which does not.

## Approach

One canonical copy, one component, rendered inline where the decision is made.

- `src/lib/connector-access-copy.ts` — React-free, like `lib/grant-copy.ts`. Four kinds
  (`key`, `sign-in`, `attach`, `author`) that differ only in the first sentence (and the last for
  sign-in, where there is no key to narrow). Two or three short sentences each; no "MCP", "scope" or "token".
- `src/components/credentials/ConnectorAccessNotice.tsx` — the installed shadcn `Alert` with the
  `TriangleAlert` icon `GrantRow` already uses for its authored warning; `role="note"` (a standing
  disclosure, not an interrupting live region). Semantic tokens only.

## Surfaces (where a key, sign-in or attachment gives an agent access)

| # | Surface | Kind | Rule |
| --- | --- | --- | --- |
| 1 | `ConnectorConnectDialog` (Settings › Connectors › Connect / Update key) | `key` | above the key forms, once, when any slot is an API key |
| 2 | `ConnectorOAuthConnect` (dialog + team-agent connect in `AgentForm`) | `sign-in` | above the Connect button; `showAccessNotice={false}` where a wider notice already sits (AgentForm) |
| 3 | `AgentForm` connector attach list | `attach` | above the checkbox list, whenever there is something to attach |
| 4 | `ConnectorEditDialog` (New / Edit connector) | `author` | above the key rows, when at least one key row exists |
| 5 | `GrantRow` (agent thread + Today: the assistant proposed a connector/skill and asks for its key) | `key` | after the key fields, when the grant has key slots |
| 6 | `ProposedConnectorApproveDialog` (Settings twin of 5) | `key` | after the key fields, when the draft has key slots |

Deliberately not changed (no key is entered or attached there): `SkillInstallConsentDialog`,
`SkillAttachmentsSection`, `SkillEditor` connector picker (a skill's reach is its connectors; the
key is attached in #1), the LLM-provider key forms (`ProvidersPanel`, `AddProviderForm`, `KeyForm`,
setup `StepModel`: the host spends those, the agent does not act with them) and routine HMAC
secrets (`RoutinesList`).

## Tests

- `connector-access-copy.test.ts`: every kind is 2–3 sentences, the four required ideas are present, the banned words are absent.
- `ConnectorAccessNotice.test.tsx`: renders inside the `Alert`, `role="note"`, no raw colour classes.
- one test per surface asserting the notice renders where the credential is attached and does **not** render where no credential is (no-key connector, non-admin shared connector, zero key rows).
- `__tests__/connector-access-coverage.test.ts` (added after the UX review): a source scan that fails when a `components/` file calls `setDestinationCredential(`, renders `<CredentialSlotForm` or `<ConnectorOAuthConnect` without rendering `<ConnectorAccessNotice`, so the next key-entry surface cannot ship without it. The two exemptions (`CredentialSlotForm`, `CredentialSlotRow`: shared with model-provider keys and routine webhook secrets) are checked both ways so they cannot go stale.

## YAGNI

No blocking checkbox (the card says not unless the UX review argues for it; the consent gates that already exist stay as they are),
no server change, no new hook, no dismiss/"don't show again" (a disclosure you can dismiss is a disclosure that stops being one).
