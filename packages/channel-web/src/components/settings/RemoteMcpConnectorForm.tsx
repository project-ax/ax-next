import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import {
  createConnector,
  patchConnector,
  type Connector,
  type ConnectorKeyMode,
  type ConnectorVisibility,
} from '@/lib/connectors';
import { connectorIdFromName } from '@/lib/connector-form';
import {
  discoverOAuthHosts,
  getOAuthClientMetadata,
} from '@/lib/connectors-oauth';
import { setDestinationCredential, refForDestination } from '@/lib/credentials';
import {
  remoteDraft,
  remoteCapabilities,
  remoteErrors,
  serverHost,
  type ClientRegistration,
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
  FieldLegend,
  FieldTitle,
} from '@/components/ui/field';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConnectorAccessNotice } from '@/components/credentials/ConnectorAccessNotice';
import type { ConnectorEditDialogProps } from './LegacyConnectorEditDialog';

const methods: {
  value: ClientRegistration;
  label: string;
  description: string;
  summary: string;
}[] = [
  {
    value: 'auto',
    label: 'Automatic (recommended)',
    description: 'Use the method supported by this server.',
    summary: 'Automatic',
  },
  {
    value: 'cimd',
    label: 'AX’s published identity (CIMD)',
    description: 'Use AX’s hosted client details. No setup needed.',
    summary: 'Published identity',
  },
  {
    value: 'dcr',
    label: 'Register automatically (DCR)',
    description: 'Create an OAuth client with this server.',
    summary: 'Automatic registration',
  },
  {
    value: 'custom',
    label: 'Use my own client',
    description: 'Enter the client details registered with this service.',
    summary: 'Custom client',
  },
];

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
          className="h-12 w-full justify-between gap-3 rounded-none px-0 hover:bg-transparent"
        >
          <span className="text-left font-medium">{title}</span>
          <span className="flex min-w-0 items-center gap-3 text-muted-foreground">
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
        <FieldGroup className="pb-5 pt-1">{children}</FieldGroup>
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
  const [choosingClient, setChoosingClient] = useState(
    draft.registration !== 'custom',
  );
  const [clientOpen, setClientOpen] = useState(false);
  const [headersOpen, setHeadersOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [keyMode, setKeyMode] = useState<ConnectorKeyMode>(
    connector?.keyMode ?? 'personal',
  );
  const [visibility, setVisibility] = useState<ConnectorVisibility>(
    connector?.visibility ?? 'private',
  );
  const [defaultAttached, setDefaultAttached] = useState(
    connector?.defaultAttached ?? false,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [metadata, setMetadata] = useState<{
    clientId: string;
    redirectUri: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingClientSecret, setEditingClientSecret] = useState(false);
  const [newId] = useState(
    () =>
      `${connectorIdFromName(connector?.name ?? 'remote').slice(0, 48)}-${crypto.randomUUID().slice(0, 8)}`,
  );
  const [retry, setRetry] = useState(0);
  const [discovery, setDiscovery] = useState<{
    url: string;
    status: 'loading' | 'ready' | 'failed';
    hosts: string[];
  } | null>(null);
  const [manualHosts, setManualHosts] = useState(false);
  const [destinationConfirmed, setDestinationConfirmed] = useState(false);
  const fieldId = (name: string) => `${id}-${name}`;
  const update = <K extends keyof typeof draft>(
    key: K,
    value: (typeof draft)[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const url = draft.url.trim();
  const host = serverHost(url);
  const originalHost = serverHost(
    connector?.capabilities.mcpServers[0]?.url ?? '',
  );
  const changedDestination = Boolean(
    originalHost &&
    host &&
    host !== originalHost &&
    draft.headers.some((h) => h.saved),
  );
  const awaitingDiscovery = Boolean(
    draft.signIn === 'oauth' &&
    host &&
    !manualHosts &&
    (!discovery || discovery.url !== url || discovery.status === 'loading'),
  );
  const discoveryFailed = Boolean(
    draft.signIn === 'oauth' &&
    !manualHosts &&
    discovery?.url === url &&
    discovery.status === 'failed',
  );
  const cimdAvailable = metadata?.clientId.startsWith('https://') ?? false;

  useEffect(() => {
    let stale = false;
    void getOAuthClientMetadata().then(
      (value) => {
        if (!stale) setMetadata(value);
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, []);
  useEffect(() => {
    setDestinationConfirmed(false);
    setManualHosts(false);
    if (!host || draft.signIn !== 'oauth') {
      setDiscovery(null);
      return;
    }
    const controller = new AbortController();
    setDiscovery({ url, status: 'loading', hosts: [] });
    const timer = setTimeout(() => {
      void discoverOAuthHosts(url, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted)
            setDiscovery({ url, status: 'ready', hosts: result.hosts });
        },
        () => {
          if (!controller.signal.aborted)
            setDiscovery({ url, status: 'failed', hosts: [] });
        },
      );
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, host, draft.signIn, retry]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || awaitingDiscovery || discoveryFailed) return;
    const nextErrors = remoteErrors(draft);
    if (
      draft.signIn === 'oauth' &&
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
        'OAuth requires each user’s account. Choose that option in Workspace settings.';
    if (
      draft.signIn === 'oauth' &&
      draft.registration === 'cimd' &&
      !cimdAvailable
    )
      nextErrors.clientId =
        'Published identity requires AX to have a public HTTPS URL.';
    if (changedDestination && !destinationConfirmed)
      nextErrors.destination = 'Confirm the destination for saved headers.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      if (nextErrors.clientId) setClientOpen(true);
      if (nextErrors.workspace) setWorkspaceOpen(true);
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
      if (
        draft.signIn === 'oauth' &&
        draft.registration === 'custom' &&
        draft.clientSecret
      ) {
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
        { ...draft, clientSecretRef },
        connectorId,
        connector,
        discovery?.url === url && discovery.status === 'ready'
          ? discovery.hosts
          : [],
      );
      const input = {
        connectorId,
        name: draft.name.trim(),
        capabilities,
        keyMode,
        ...(isAdmin ? { visibility, defaultAttached } : {}),
      };
      if (connector)
        await patchConnector(
          connectorId,
          input,
          isAdmin ? '/admin/connectors' : '/settings/connectors',
        );
      else
        await createConnector(
          { ...input, visibility: isAdmin ? visibility : 'private' },
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
    name: 'name' | 'url' | 'clientId' | 'hosts' | 'scopes',
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

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!saving) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[560px] flex-col gap-0 overflow-hidden rounded-xl border-border p-0 transition-none motion-reduce:animate-none [&>button:last-child]:right-5 [&>button:last-child]:top-6 [&>button:last-child]:flex [&>button:last-child]:size-11 [&>button:last-child]:items-center [&>button:last-child]:justify-center [&>button:last-child]:rounded-md sm:[&>button:last-child]:size-10">
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
          <div
            className="min-h-0 overflow-y-auto overscroll-contain px-6"
            style={{ maxHeight: 660 }}
          >
            <FieldSet disabled={saving} className="min-w-0 pb-6">
              <FieldGroup>
                <FieldGroup>
                  {textField('name', 'Name', 'e.g. Linear')}
                  {textField('url', 'Server URL', 'https://example.com/mcp')}
                </FieldGroup>
                <Field>
                  <FieldLabel id={fieldId('sign-in-label')}>Sign-in</FieldLabel>
                  <ToggleGroup
                    type="single"
                    value={draft.signIn}
                    onValueChange={(value) => {
                      if (value === 'none' || value === 'oauth')
                        update('signIn', value);
                    }}
                    variant="outline"
                    className="grid grid-cols-2 gap-1"
                    aria-labelledby={fieldId('sign-in-label')}
                  >
                    <ToggleGroupItem
                      value="none"
                      className="h-11 px-3 text-sm sm:h-10"
                    >
                      No sign-in
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="oauth"
                      className="h-11 px-3 text-sm sm:h-10"
                    >
                      OAuth
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <FieldDescription>
                    {draft.signIn === 'oauth'
                      ? 'Each user connects with their own account.'
                      : 'Connect without an account. Add headers below if the server needs an API key.'}
                  </FieldDescription>
                </Field>
                <div>
                  {draft.signIn === 'oauth' && (
                    <Disclosure
                      title="OAuth client"
                      summary={
                        methods.find((m) => m.value === draft.registration)!
                          .summary
                      }
                      open={clientOpen}
                      onOpenChange={setClientOpen}
                    >
                      {(draft.registration !== 'custom' || choosingClient) && (
                        <FieldSet className="gap-0">
                          <FieldLegend className="sr-only">
                            OAuth client method
                          </FieldLegend>
                          <RadioGroup
                            value={draft.registration}
                            onValueChange={(value) => {
                              update(
                                'registration',
                                value as ClientRegistration,
                              );
                              setChoosingClient(value !== 'custom');
                            }}
                            aria-label="OAuth client method"
                            className="gap-4"
                          >
                            {methods.map((method) => (
                              <Field
                                key={method.value}
                                orientation="horizontal"
                                className="items-start gap-3"
                                data-disabled={
                                  method.value === 'cimd' && !cimdAvailable
                                }
                              >
                                <RadioGroupItem
                                  id={fieldId(method.value)}
                                  value={method.value}
                                  className="mt-1 shrink-0"
                                  disabled={
                                    method.value === 'cimd' && !cimdAvailable
                                  }
                                />
                                <div className="flex min-w-0 flex-col gap-1">
                                  <FieldLabel htmlFor={fieldId(method.value)}>
                                    {method.label}
                                  </FieldLabel>
                                  <FieldDescription>
                                    {method.value === 'cimd' && !cimdAvailable
                                      ? 'Available when AX has a public HTTPS URL.'
                                      : method.description}
                                  </FieldDescription>
                                </div>
                              </Field>
                            ))}
                          </RadioGroup>
                        </FieldSet>
                      )}
                      {draft.registration === 'custom' && !choosingClient && (
                        <FieldGroup className="gap-4">
                          <div className="flex items-start justify-between gap-3">
                            <FieldDescription>
                              Enter the client registered with this service.
                            </FieldDescription>
                            <Button
                              type="button"
                              variant="link"
                              size="sm"
                              className="h-auto shrink-0 p-0"
                              onClick={() => setChoosingClient(true)}
                            >
                              Change method
                            </Button>
                          </div>
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
                                autoComplete="new-password"
                                value={draft.clientSecret}
                                onChange={(event) =>
                                  update('clientSecret', event.target.value)
                                }
                              />
                            )}
                            <FieldDescription>
                              Leave blank unless the service requires a secret.
                            </FieldDescription>
                          </Field>
                          <Field>
                            <FieldTitle>Redirect URL</FieldTitle>
                            <div className="flex items-center gap-3">
                              <p className="min-w-0 flex-1 break-all text-xs leading-5">
                                {metadata?.redirectUri ??
                                  'OAuth configuration unavailable'}
                              </p>
                              <Button
                                type="button"
                                variant="outline"
                                aria-label="Copy redirect URL"
                                disabled={!metadata}
                                onClick={() => {
                                  void navigator.clipboard
                                    .writeText(metadata!.redirectUri)
                                    .then(
                                      () => setCopied(true),
                                      () => setCopied(false),
                                    );
                                }}
                              >
                                <Copy data-icon="inline-start" />
                                {copied ? 'Copied' : 'Copy'}
                              </Button>
                            </div>
                            <FieldDescription>
                              Register this URL with the service.
                            </FieldDescription>
                          </Field>
                        </FieldGroup>
                      )}
                    </Disclosure>
                  )}
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
                      Sent with every request to this server. Values are stored
                      securely and never shown again.
                    </FieldDescription>
                    {draft.headers.map((header, index) => (
                      <FieldGroup key={header.slot} className="gap-3">
                        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                          <Field
                            className="col-span-2 sm:col-span-1"
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
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
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
                            <Trash2 />
                          </Button>
                        </div>
                        {(errors[`name-${header.slot}`] ||
                          errors[`value-${header.slot}`]) && (
                          <FieldError
                            id={fieldId(`header-${header.slot}-error`)}
                          >
                            {errors[`name-${header.slot}`] ||
                              errors[`value-${header.slot}`]}
                          </FieldError>
                        )}
                      </FieldGroup>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      className="self-start"
                      disabled={draft.headers.length >= 4}
                      onClick={() =>
                        update('headers', [
                          ...draft.headers,
                          {
                            slot: `header-${crypto.randomUUID()}`,
                            name: '',
                            value: '',
                            saved: false,
                          },
                        ])
                      }
                    >
                      <Plus data-icon="inline-start" />
                      Add header
                    </Button>
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
                  <Disclosure
                    title="Connection details"
                    summary={`${new Set([...draft.hosts.split(/[\s,]+/).filter(Boolean), ...(discovery?.url === url ? discovery.hosts : []), ...(host ? [host] : [])]).size} hosts`}
                    open={detailsOpen}
                    onOpenChange={setDetailsOpen}
                  >
                    <FieldDescription>
                      AX can connect only to these hosts. Saved headers and
                      OAuth tokens are sent only to the server host.
                    </FieldDescription>
                    {host && (
                      <p className="break-all text-sm">
                        {[
                          ...new Set([
                            host,
                            ...(discovery?.url === url ? discovery.hosts : []),
                          ]),
                        ].join(', ')}
                      </p>
                    )}
                    {textField(
                      'hosts',
                      'Additional allowed hosts',
                      'api.example.com, auth.example.com',
                    )}
                    {draft.signIn === 'oauth' && (
                      <>
                        {textField('scopes', 'OAuth scopes', 'e.g. read write')}
                        <FieldDescription>
                          Optional. Separate scopes with spaces or commas.
                        </FieldDescription>
                      </>
                    )}
                  </Disclosure>
                  {isAdmin && (
                    <Disclosure
                      title="Workspace settings"
                      summary={visibility === 'shared' ? 'Shared' : 'Private'}
                      open={workspaceOpen}
                      onOpenChange={setWorkspaceOpen}
                    >
                      <Field>
                        <FieldLabel id={fieldId('sharing')}>Sharing</FieldLabel>
                        <ToggleGroup
                          type="single"
                          value={visibility}
                          onValueChange={(value) => {
                            if (value === 'shared' || value === 'private')
                              setVisibility(value);
                          }}
                          aria-labelledby={fieldId('sharing')}
                          variant="outline"
                        >
                          <ToggleGroupItem value="private" className="flex-1">
                            Private
                          </ToggleGroupItem>
                          <ToggleGroupItem value="shared" className="flex-1">
                            Shared
                          </ToggleGroupItem>
                        </ToggleGroup>
                      </Field>
                      <Field>
                        <FieldLabel id={fieldId('credentials')}>
                          Credentials
                        </FieldLabel>
                        <ToggleGroup
                          type="single"
                          value={keyMode}
                          onValueChange={(value) => {
                            if (value === 'personal' || value === 'workspace') {
                              setKeyMode(value);
                              update(
                                'headers',
                                draft.headers.map((header) => ({
                                  ...header,
                                  saved:
                                    value === connector?.keyMode &&
                                    Boolean(
                                      connector?.capabilities.credentials.some(
                                        (slot) =>
                                          slot.kind === 'api-key' &&
                                          slot.headerName &&
                                          slot.slot === header.slot,
                                      ),
                                    ),
                                })),
                              );
                              setHeadersOpen(draft.headers.length > 0);
                            }
                          }}
                          aria-labelledby={fieldId('credentials')}
                          variant="outline"
                        >
                          <ToggleGroupItem value="personal" className="flex-1">
                            Each user’s account
                          </ToggleGroupItem>
                          <ToggleGroupItem
                            value="workspace"
                            className="flex-1"
                            disabled={draft.signIn === 'oauth'}
                          >
                            Workspace key
                          </ToggleGroupItem>
                        </ToggleGroup>
                        <FieldDescription>
                          {keyMode === 'workspace'
                            ? 'Credentials are shared across the workspace.'
                            : 'Each user supplies their own credentials.'}
                        </FieldDescription>
                      </Field>
                      <Field orientation="horizontal">
                        <Checkbox
                          id={fieldId('default')}
                          checked={defaultAttached}
                          onCheckedChange={(checked) =>
                            setDefaultAttached(checked === true)
                          }
                        />
                        <FieldLabel htmlFor={fieldId('default')}>
                          Enabled by default for all agents
                        </FieldLabel>
                      </Field>
                    </Disclosure>
                  )}
                  <Separator />
                </div>
                {awaitingDiscovery && (
                  <p
                    role="status"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                    Checking OAuth connection details…
                  </p>
                )}
                {discoveryFailed && (
                  <Alert>
                    <AlertDescription className="flex flex-col gap-3">
                      <p>
                        We couldn’t discover OAuth hosts. Retry, or enter the
                        required hosts in Connection details.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setRetry((n) => n + 1)}
                        >
                          Retry
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setManualHosts(true);
                            setDetailsOpen(true);
                          }}
                        >
                          Enter hosts manually
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
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
              disabled={saving || awaitingDiscovery || discoveryFailed}
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
