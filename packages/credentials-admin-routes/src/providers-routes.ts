import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import {
  parseRequestBody,
  requireAdmin,
  writeServiceError,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';
import { validateProviderKey } from './provider-validator.js';

// ---------------------------------------------------------------------------
// Provider registry + /admin/credentials/providers* handlers.
//
// Routes:
//   GET  /admin/credentials/providers                   → list providers with configured status
//   POST /admin/credentials/providers/:id/validate      → validate + save a key
//
// Bus services registered:
//   credentials:list-providers  → ProviderEntry[]
//
// MVP static list: Anthropic only. The service hook is the extension point
// for future multi-provider support — call `credentials:list-providers` to
// get the list rather than hardcoding it anywhere else.
//
// Key safety invariant: raw key bytes are NEVER logged or returned to the
// client. The validate handler accepts a base64-encoded key, decodes it to
// bytes, validates against the provider API, and immediately stores the
// bytes via `credentials:set`. The bytes are not retained in any variable
// after the `credentials:set` call.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/credentials-admin-routes/providers';

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export interface ProviderEntry {
  id: string;
  name: string;
  ref: string;
  models: string[];
}

const STATIC_PROVIDERS: ProviderEntry[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    // Must match the ref the chat-orchestrator looks up at proxy:open-session
    // (and the wizard's completion-tx writes), or the Provider keys tab
    // shows "Not configured" right after a successful wizard run.
    ref: 'provider:anthropic',
    models: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ],
  },
];

/**
 * Register the `credentials:list-providers` service on the bus. This service
 * returns the static provider list for MVP. Plugins that want to add providers
 * can call `credentials:list-providers` themselves and merge, or extend this
 * list in future work.
 */
export function registerProviderService(bus: HookBus): () => void {
  bus.registerService(
    'credentials:list-providers',
    PLUGIN_NAME,
    async (_ctx, _input: Record<string, never>) => {
      return { providers: STATIC_PROVIDERS };
    },
  );
  return () => {};  // services don't have an unregister mechanism
}

// ---------------------------------------------------------------------------
// Validate-body schema
// ---------------------------------------------------------------------------

const validateBodySchema = z
  .object({
    key: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export interface ProviderRouteDeps {
  bus: HookBus;
}

export function createProviderHandlers(deps: ProviderRouteDeps): {
  list: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  validate: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  const ctx = makeAgentContext({
    sessionId: 'credentials-providers',
    agentId: PLUGIN_NAME,
    userId: 'admin',
  });

  return {
    /** GET /admin/credentials/providers */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;

      try {
        const [providersOut, credsOut] = await Promise.all([
          deps.bus.call<Record<string, never>, { providers: ProviderEntry[] }>(
            'credentials:list-providers',
            ctx,
            {},
          ),
          deps.bus.call<
            Record<string, never>,
            {
              credentials: Array<{
                scope: string;
                ownerId: string | null;
                ref: string;
                kind: string;
              }>;
            }
          >('credentials:list', ctx, {}),
        ]);

        const configuredRefs = new Set<string>(
          credsOut.credentials
            .filter((c) => c.scope === 'global')
            .map((c) => c.ref),
        );

        const providers = providersOut.providers.map((p) => ({
          id: p.id,
          name: p.name,
          ref: p.ref,
          models: p.models,
          configured: configuredRefs.has(p.ref),
        }));

        res.status(200).json({ providers });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** POST /admin/credentials/providers/:id/validate */
    async validate(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;

      // Look up provider
      const providerId = req.params.id;
      let providerEntry: ProviderEntry | undefined;
      try {
        const { providers } = await deps.bus.call<
          Record<string, never>,
          { providers: ProviderEntry[] }
        >('credentials:list-providers', ctx, {});
        providerEntry = providers.find((p) => p.id === providerId);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }

      if (providerEntry === undefined) {
        res.status(404).json({ error: 'provider-not-found' });
        return;
      }

      // Parse body
      const parsedBody = parseRequestBody(req.body);
      if (!parsedBody.ok) {
        res.status(parsedBody.status).json({ error: parsedBody.message });
        return;
      }
      const schemaResult = validateBodySchema.safeParse(parsedBody.value);
      if (!schemaResult.success) {
        const first = schemaResult.error.issues[0];
        res.status(400).json({
          error:
            first?.message !== undefined && first.message.length > 0
              ? first.message
              : 'invalid-payload',
        });
        return;
      }

      // Decode base64 key → bytes.
      let keyBytes: Uint8Array;
      try {
        keyBytes = new Uint8Array(Buffer.from(schemaResult.data.key, 'base64'));
      } catch {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }
      if (keyBytes.length === 0) {
        res.status(400).json({ error: 'key must decode to non-empty bytes' });
        return;
      }

      const validationResult = await validateProviderKey({
        bus: deps.bus,
        ctx,
        providerId: providerEntry.id,
        keyBytes,
      });
      if (!validationResult.ok) {
        res.status(422).json({ error: validationResult.error });
        return;
      }

      // On success: save the credential.
      try {
        await deps.bus.call('credentials:set', ctx, {
          scope: 'global',
          ownerId: null,
          ref: providerEntry.ref,
          kind: 'api-key',
          payload: keyBytes,
        });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }

      res.status(200).json({
        provider: {
          id: providerEntry.id,
          name: providerEntry.name,
          ref: providerEntry.ref,
          configured: true,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerProviderRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createProviderHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'POST';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    {
      method: 'GET',
      path: '/admin/credentials/providers',
      handler: handlers.list,
    },
    {
      method: 'POST',
      path: '/admin/credentials/providers/:id/validate',
      handler: handlers.validate,
    },
  ];
  const unregisters: Array<() => void> = [];
  for (const route of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>(
      'http:register-route',
      initCtx,
      route,
    );
    unregisters.push(result.unregister);
  }
  return unregisters;
}
