import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import {
  createConnector,
  patchConnector,
  type Connector,
} from '@/lib/connectors';
import { connectorIdFromName } from '@/lib/connector-form';
import {
  discoverOAuthHosts,
  getOAuthClientMetadata,
  type OAuthDiscovery,
} from '@/lib/connectors-oauth';
import { setDestinationCredential, refForDestination } from '@/lib/credentials';
import {
  remoteDraft,
  remoteCapabilities,
  remoteErrors,
  serverHost,
  type RemoteMcpDraft,
} from '@/lib/remote-mcp-form';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConnectorAccessNotice } from '@/components/credentials/ConnectorAccessNotice';
import type { ConnectorEditDialogProps } from './LegacyConnectorEditDialog';

function Disclosure({
  title,
  summary,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <Separator />
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-12 w-full justify-between gap-2 rounded-none px-0"
        >
          <span className="text-left font-medium">{title}</span>
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span className="truncate font-normal">{summary}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'shrink-0 transition-transform motion-reduce:transition-none',
                open && 'rotate-180',
              )}
            />
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <FieldGroup className="gap-4 pb-5 pt-1">{children}</FieldGroup>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function RemoteMcpConnectorForm({
  connector,
  open,
  onOpenChange,
  onSaved,
  isAdmin = false,
}: ConnectorEditDialogProps & { connector?: Connector }) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(() => remoteDraft(connector));
  const [headersOpen, setHeadersOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const keyMode = connector?.keyMode ?? 'personal';
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [metadata, setMetadata] = useState<
    { clientId: string; redirectUri: string } | 'loading' | 'unavailable'
  >('loading');
  const [copied, setCopied] = useState(false);
  const [editingClientSecret, setEditingClientSecret] = useState(false);
  const [newId] = useState(
    () =>
      `${connectorIdFromName(connector?.name ?? 'remote').slice(0, 48)}-${crypto.randomUUID().slice(0, 8)}`,
  );
  const [retry, setRetry] = useState(0);
  const [discovery, setDiscovery] = useState<
    | { url: string; status: 'loading' | 'failed' }
    | { url: string; status: 'ready'; result: OAuthDiscovery }
    | null
  >(null);
  const [destinationConfirmed, setDestinationConfirmed] = useState(false);
  const fieldId = (name: string) => `${id}-${name}`;
  const update = <K extends keyof typeof draft>(
    key: K,
    value: (typeof draft)[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const url = draft.url.trim();
  const host = serverHost(url);
  const savedUrl = connector?.capabilities.mcpServers[0]?.url ?? '';
  const originalHost = serverHost(savedUrl);
  const changedDestination = Boolean(
    originalHost &&
      host &&
      host !== originalHost &&
      draft.headers.some((h) => h.saved),
  );
  const discovered =
    discovery?.url === url && discovery.status === 'ready'
      ? discovery.result
      : undefined;
  const awaitingDiscovery = Boolean(
    host &&
      (!discovery || discovery.url !== url || discovery.status === 'loading'),
  );
  const discoveryFailed = Boolean(
    host && discovery?.url === url && discovery.status === 'failed',
  );
  // When the saved server can't be reached, its saved sign-in still stands,
  // so the rest of the connector stays editable. A new or changed URL has no
  // saved answer to fall back on.
  const usingSavedSignIn = discoveryFailed && Boolean(connector) && url === savedUrl;
  const signIn: RemoteMcpDraft['signIn'] = discovered
    ? discovered.auth === 'oauth'
      ? 'oauth'
      : 'none'
    : draft.signIn;
  const signInKnown = Boolean(discovered) || usingSavedSignIn;
  // The server picks CIMD over DCR for 'auto'; CIMD also needs AX itself to be
  // reachable at a public HTTPS URL.
  const clientMetadata = typeof metadata === 'object' ? metadata : null;
  const cimdAvailable =
    metadata === 'loading' ||
    (clientMetadata?.clientId.startsWith('https://') ?? false);
  const automaticMethod =
    discovered?.auth === 'oauth'
      ? discovered.clientRegistration.cimd && cimdAvailable
        ? ('cimd' as const)
        : discovered.clientRegistration.dcr
          ? ('dcr' as const)
          : undefined
      : undefined;
  const registration: RemoteMcpDraft['registration'] = !discovered
    ? draft.registration
    : draft.registration === 'custom' || !automaticMethod
      ? 'custom'
      : 'auto';
  const effectiveDraft: RemoteMcpDraft = { ...draft, signIn, registration };
  const addHeader = () =>
    update('headers', [
      ...draft.headers,
      {
        slot: `header-${crypto.randomUUID()}`,
        name: '',
        value: '',
        saved: false,
      },
    ]);
  const addHeaderButton = (
    <Button
      type="button"
      variant="outline"
      className="self-start"
      disabled={draft.headers.length >= 4}
      onClick={addHeader}
    >
      Add header
    </Button>
  );

  useEffect(() => {
    let stale = false;
    void getOAuthClientMetadata().then(
      (value) => {
        if (!stale) setMetadata(value);
      },
      () => {
        if (!stale) setMetadata('unavailable');
      },
    );
    return () => {
      stale = true;
    };
  }, []);
  useEffect(() => {
    setDestinationConfirmed(false);
    if (!host) {
      setDiscovery(null);
      return;
    }
    const controller = new AbortController();
    setDiscovery({ url, status: 'loading' });
    const timer = setTimeout(() => {
      void discoverOAuthHosts(url, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted)
            setDiscovery({ url, status: 'ready', result });
        },
        () => {
          if (!controller.signal.aborted)
            setDiscovery({ url, status: 'failed' });
        },
      );
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, host, retry]);
  useEffect(() => {
    // A server that wants a key but has no OAuth needs the header section.
    if (discovered?.auth === 'other') setHeadersOpen(true);
  }, [discovered?.auth]);

  const blocked = awaitingDiscovery || (discoveryFailed && !usingSavedSignIn);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || blocked) return;
    const nextErrors = remoteErrors(effectiveDraft);
    if (
      signIn === 'oauth' &&
      keyMode === 'workspace' &&
      !(
        connector?.keyMode === 'workspace' &&
        connector.capabilities.credentials.some(
          (slot) =>
            slot.kind === 'oauth' &&
            slot.server === connector.capabilities.mcpServers[0]?.name,
        )
      )
    )
      nextErrors.workspace =
        'This connector uses a workspace key, but this server signs in with OAuth. Create a separate connector for it.';
    if (changedDestination && !destinationConfirmed)
      nextErrors.destination = 'Confirm the destination for saved headers.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      if (
        Object.keys(nextErrors).some(
          (key) => key.startsWith('name-') || key.startsWith('value-'),
        ) ||
        nextErrors.destination
      )
        setHeadersOpen(true);
      requestAnimationFrame(() =>
        formRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus(),
      );
      return;
    }
    setSaving(true);
    setSaveError('');
    const connectorId = connector?.id ?? newId;
    try {
      const scope = {
        scope:
          keyMode === 'workspace' ? ('global' as const) : ('user' as const),
        ownerId: null,
      };
      let clientSecretRef = draft.clientSecretRef;
      if (signIn === 'oauth' && registration === 'custom' && draft.clientSecret) {
        const destination = {
          kind: 'account' as const,
          service: connectorId,
          slot: 'oauth-client-secret',
        };
        await setDestinationCredential({
          destination,
          slot: { kind: 'api-key' },
          scope,
          payload: draft.clientSecret,
        });
        clientSecretRef = refForDestination(destination);
      }
      for (const header of draft.headers) {
        if (header.value)
          await setDestinationCredential({
            destination: {
              kind: 'account',
              service: connectorId,
              slot: header.slot,
            },
            slot: { kind: 'api-key' },
            scope,
            payload: header.value,
          });
      }
      const capabilities = remoteCapabilities(
        { ...effectiveDraft, clientSecretRef },
        connectorId,
        connector,
        discovered?.hosts ?? [],
      );
      const input = {
        connectorId,
        name: draft.name.trim(),
        capabilities,
        keyMode,
      };
      if (connector)
        await patchConnector(
          connectorId,
          input,
          isAdmin ? '/admin/connectors' : '/settings/connectors',
        );
      else
        await createConnector(
          { ...input, visibility: 'shared', defaultAttached: false },
          isAdmin ? '/admin/connectors' : '/settings/connectors',
        );
      update('clientSecret', '');
      onSaved();
      onOpenChange(false);
    } catch {
      setSaveError(
        'We couldn’t save this connector. Check the settings and try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  const textField = (
    name: 'name' | 'url' | 'clientId' | 'scopes',
    label: string,
    placeholder?: string,
  ) => (
    <Field data-invalid={Boolean(errors[name])}>
      <FieldLabel htmlFor={fieldId(name)}>{label}</FieldLabel>
      <Input
        id={fieldId(name)}
        value={draft[name]}
        placeholder={placeholder}
        onChange={(event) => update(name, event.target.value)}
        aria-invalid={Boolean(errors[name])}
        aria-describedby={errors[name] ? fieldId(`${name}-error`) : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {errors[name] && (
        <FieldError id={fieldId(`${name}-error`)}>{errors[name]}</FieldError>
      )}
    </Field>
  );

  const signInDescription =
    signIn === 'none'
      ? discovered?.auth === 'other'
        ? undefined
        : 'This server doesn’t need sign-in. If it expects a key, add it as a request header.'
      : registration === 'custom'
        ? automaticMethod
          ? 'Each person connects with their own account, using the OAuth client you registered with this service.'
          : 'Each person connects with their own account. This server doesn’t support automatic setup, so enter the OAuth client you registered with it.'
        : automaticMethod === 'cimd'
          ? 'Each person connects with their own account. AX identifies itself with its published client details, so there’s nothing to set up.'
          : 'Each person connects with their own account. AX registers itself with this server automatically, so there’s nothing to set up.';

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!saving) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[560px] flex-col gap-0 overflow-hidden rounded-xl border-border p-0 transition-none motion-reduce:animate-none [&>button:last-child]:right-6 [&>button:last-child]:top-6 [&>button:last-child]:flex [&>button:last-child]:size-11 [&>button:last-child]:items-center [&>button:last-child]:justify-center [&>button:last-child]:rounded-md sm:[&>button:last-child]:size-10">
        <DialogHeader className="shrink-0 px-6 pb-6 pt-6 text-left">
          <DialogTitle className="flex h-10 items-center pr-12 leading-6">
            {connector ? 'Edit connector' : 'Add connector'}
          </DialogTitle>
          <DialogDescription className="leading-5">
            {connector
              ? 'Update the remote server and how we connect.'
              : 'Connect AX to a remote MCP server.'}
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 flex-1 flex-col"
          aria-busy={saving}
        >
          <div className="max-h-[660px] min-h-0 overflow-y-auto overscroll-contain px-6">
            <FieldSet disabled={saving} className="min-w-0 pb-6">
              <FieldGroup>
                <FieldGroup>
                  {textField('name', 'Name', 'e.g. Linear')}
                  {textField('url', 'Server URL', 'https://example.com/mcp')}
                </FieldGroup>
                {awaitingDiscovery && (
                  <p
                    role="status"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                    Checking how this server signs in…
                  </p>
                )}
                {discoveryFailed && (
                  <Alert>
                    <AlertDescription className="flex flex-col gap-3">
                      <p>
                        {usingSavedSignIn
                          ? 'We couldn’t reach this server to check how it signs in, so we’ll keep its saved settings.'
                          : 'We couldn’t reach this server to check how it signs in. Check the URL and try again.'}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => setRetry((n) => n + 1)}
                      >
                        Retry
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
                {signInKnown && (
                  <>
                    <Field className="gap-2">
                      <FieldTitle>
                        {signIn === 'oauth'
                          ? 'Sign-in: OAuth'
                          : discovered?.auth === 'other'
                            ? 'Sign-in: request header'
                            : 'Sign-in: none'}
                      </FieldTitle>
                      {signInDescription && (
                        <FieldDescription>{signInDescription}</FieldDescription>
                      )}
                      {discovered?.auth === 'other' && (
                        <Alert>
                          <AlertDescription>
                            This server asks for credentials but doesn’t
                            support OAuth. Add the key it expects as a request
                            header.
                          </AlertDescription>
                        </Alert>
                      )}
                      {signIn === 'oauth' &&
                        discovered &&
                        automaticMethod && (
                          // Field stretches direct children; the wrapper keeps
                          // the link at its natural width, left-aligned.
                          <div>
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="h-auto p-0"
                            onClick={() =>
                              update(
                                'registration',
                                registration === 'custom' ? 'auto' : 'custom',
                              )
                            }
                          >
                            {registration === 'custom'
                              ? 'Use automatic setup instead'
                              : 'Use my own OAuth client instead'}
                          </Button>
                          </div>
                        )}
                    </Field>
                    {signIn === 'oauth' && registration === 'custom' && (
                      <FieldGroup className="gap-4">
                          {textField('clientId', 'Client ID')}
                          <Field>
                            <FieldLabel htmlFor={fieldId('client-secret')}>
                              Client secret{' '}
                              <span className="font-normal text-muted-foreground">
                                (optional)
                              </span>
                            </FieldLabel>
                            {draft.clientSecretRef && !editingClientSecret ? (
                              <div className="flex min-h-10 flex-wrap items-center gap-2">
                                <span className="flex-1 text-sm text-muted-foreground">
                                  Saved securely
                                </span>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setEditingClientSecret(true)}
                                >
                                  Replace
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    update('clientSecretRef', '');
                                    update('clientSecret', '');
                                  }}
                                >
                                  Remove
                                </Button>
                              </div>
                            ) : (
                              <Input
                                id={fieldId('client-secret')}
                                type="password"
                                placeholder="Enter only if the service requires it"
                                autoComplete="new-password"
                                value={draft.clientSecret}
                                onChange={(event) =>
                                  update('clientSecret', event.target.value)
                                }
                              />
                            )}
                          </Field>
                          <Field className="gap-2">
                            <FieldTitle>Redirect URL</FieldTitle>
                            <div className="flex items-center gap-3">
                              <p className="min-w-0 flex-1 break-all text-xs leading-4 text-muted-foreground">
                                {clientMetadata?.redirectUri ??
                                  'OAuth configuration unavailable'}
                              </p>
                              <Button
                                type="button"
                                variant="outline"
                                aria-label="Copy redirect URL"
                                disabled={!clientMetadata}
                                onClick={() => {
                                  void navigator.clipboard
                                    .writeText(clientMetadata!.redirectUri)
                                    .then(
                                      () => setCopied(true),
                                      () => setCopied(false),
                                    );
                                }}
                              >
                                {copied ? 'Copied' : 'Copy'}
                              </Button>
                            </div>
                            <FieldDescription>
                              Register this URL with the service.
                            </FieldDescription>
                          </Field>
                      </FieldGroup>
                    )}
                    <div>
                  <Disclosure
                    title="Request headers"
                    summary={
                      draft.headers.length
                        ? `${draft.headers.length} ${draft.headers.length === 1 ? 'header' : 'headers'}`
                        : 'None'
                    }
                    open={headersOpen}
                    onOpenChange={setHeadersOpen}
                  >
                    <FieldDescription>
                      Sent with requests to this server. Values are hidden after
                      saving.
                    </FieldDescription>
                    {draft.headers.map((header, index) => (
                      <FieldGroup key={header.slot} className="gap-3">
                        <FieldGroup className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,190fr)_minmax(0,310fr)]">
                          <Field
                            data-invalid={Boolean(
                              errors[`name-${header.slot}`],
                            )}
                          >
                            <FieldLabel
                              htmlFor={fieldId(`name-${header.slot}`)}
                            >
                              Header name
                              {draft.headers.length > 1 ? ` ${index + 1}` : ''}
                            </FieldLabel>
                            <Input
                              id={fieldId(`name-${header.slot}`)}
                              value={header.name}
                              placeholder="X-API-Key"
                              aria-invalid={Boolean(
                                errors[`name-${header.slot}`],
                              )}
                              aria-describedby={
                                errors[`name-${header.slot}`]
                                  ? fieldId(`header-${header.slot}-error`)
                                  : undefined
                              }
                              onChange={(event) =>
                                update(
                                  'headers',
                                  draft.headers.map((h) =>
                                    h.slot === header.slot
                                      ? { ...h, name: event.target.value }
                                      : h,
                                  ),
                                )
                              }
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </Field>
                          <Field
                            data-invalid={Boolean(
                              errors[`value-${header.slot}`],
                            )}
                          >
                            <FieldLabel
                              htmlFor={fieldId(`value-${header.slot}`)}
                            >
                              Value
                              {draft.headers.length > 1 ? ` ${index + 1}` : ''}
                            </FieldLabel>
                            {header.saved ? (
                              <Button
                                type="button"
                                variant="outline"
                                className="h-10 justify-between font-normal text-muted-foreground"
                                onClick={() =>
                                  update(
                                    'headers',
                                    draft.headers.map((h) =>
                                      h.slot === header.slot
                                        ? { ...h, saved: false }
                                        : h,
                                    ),
                                  )
                                }
                              >
                                <span className="truncate">Saved securely</span>
                                <span>Replace</span>
                              </Button>
                            ) : (
                              <Input
                                id={fieldId(`value-${header.slot}`)}
                                type="password"
                                value={header.value}
                                autoComplete="new-password"
                                aria-invalid={Boolean(
                                  errors[`value-${header.slot}`],
                                )}
                                aria-describedby={
                                  errors[`value-${header.slot}`]
                                    ? fieldId(`header-${header.slot}-error`)
                                    : undefined
                                }
                                onChange={(event) =>
                                  update(
                                    'headers',
                                    draft.headers.map((h) =>
                                      h.slot === header.slot
                                        ? { ...h, value: event.target.value }
                                        : h,
                                    ),
                                  )
                                }
                              />
                            )}
                          </Field>
                        </FieldGroup>
                        {(errors[`name-${header.slot}`] ||
                          errors[`value-${header.slot}`]) && (
                          <FieldError
                            id={fieldId(`header-${header.slot}-error`)}
                          >
                            {errors[`name-${header.slot}`] ||
                              errors[`value-${header.slot}`]}
                          </FieldError>
                        )}
                        <div className="flex flex-wrap gap-2">
                          {index === draft.headers.length - 1 &&
                            addHeaderButton}
                          <Button
                            type="button"
                            variant="ghost"
                            aria-label={`Remove header ${index + 1}`}
                            onClick={() =>
                              update(
                                'headers',
                                draft.headers.filter(
                                  (h) => h.slot !== header.slot,
                                ),
                              )
                            }
                          >
                            Remove header
                          </Button>
                        </div>
                      </FieldGroup>
                    ))}
                    {draft.headers.length === 0 && addHeaderButton}
                    {draft.headers.length > 0 && (
                      <FieldDescription>
                        Only add a key with the permissions this assistant
                        needs.
                      </FieldDescription>
                    )}
                    {draft.headers.length > 0 && (
                      <ConnectorAccessNotice kind="author" />
                    )}
                    {changedDestination && (
                      <Field
                        orientation="horizontal"
                        className="items-start"
                        data-invalid={Boolean(errors.destination)}
                      >
                        <Checkbox
                          id={fieldId('destination')}
                          checked={destinationConfirmed}
                          aria-invalid={Boolean(errors.destination)}
                          aria-describedby={
                            errors.destination
                              ? fieldId('destination-error')
                              : undefined
                          }
                          onCheckedChange={(checked) =>
                            setDestinationConfirmed(checked === true)
                          }
                        />
                        <div>
                          <FieldLabel htmlFor={fieldId('destination')}>
                            Send saved headers to {host}
                          </FieldLabel>
                          <FieldDescription>
                            The server address has changed. Confirm this
                            destination before saving.
                          </FieldDescription>
                          {errors.destination && (
                            <FieldError id={fieldId('destination-error')}>
                              {errors.destination}
                            </FieldError>
                          )}
                        </div>
                      </Field>
                    )}
                  </Disclosure>
                      {signIn === 'oauth' && (
                        <Disclosure
                          title="Advanced"
                          summary={
                            draft.scopes.trim()
                              ? 'Custom scopes'
                              : 'Default scopes'
                          }
                          open={advancedOpen}
                          onOpenChange={setAdvancedOpen}
                        >
                          {textField(
                            'scopes',
                            'OAuth scopes (optional)',
                            'Use the server’s defaults',
                          )}
                        </Disclosure>
                      )}
                      <Separator />
                    </div>
                  </>
                )}
                {errors.workspace && (
                  <FieldError>{errors.workspace}</FieldError>
                )}
                {saveError && (
                  <Alert variant="destructive">
                    <AlertDescription>{saveError}</AlertDescription>
                  </Alert>
                )}
              </FieldGroup>
            </FieldSet>
          </div>
          <div className="flex shrink-0 justify-end gap-2 px-6 pb-6 pt-4">
            <Button
              type="button"
              variant="ghost"
              className="h-11 sm:h-10"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="h-11 sm:h-10"
              disabled={saving || blocked}
            >
              {saving
                ? 'Saving…'
                : connector
                  ? 'Save changes'
                  : 'Add connector'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
