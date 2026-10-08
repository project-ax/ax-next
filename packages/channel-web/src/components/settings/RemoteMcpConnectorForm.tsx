import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import {
  createConnector,
  patchConnector,
  isToolPermissionsResetFailure,
  TOOL_PERMISSIONS_RESET_FAILED_MESSAGE,
  isOwnerOnlyChange,
  OWNER_ONLY_CHANGE_MESSAGE,
  isConnectorIdTaken,
  CONNECTOR_ID_TAKEN_MESSAGE,
  CONNECTOR_ID_TAKEN_REQUEST_MESSAGE,
  type Connector,
} from '@/lib/connectors';
import { connectorIdFromName } from '@/lib/connector-form';
import {
  putToolPermissions,
  ToolPermissionsError,
} from '@/lib/connector-tool-permissions';
import { useToolPermissions } from '@/lib/use-tool-permissions';
import {
  discoverOAuthHosts,
  getOAuthClientMetadata,
  type OAuthDiscovery,
} from '@/lib/connectors-oauth';
import {
  adminCredentials,
  setDestinationCredential,
  refForDestination,
} from '@/lib/credentials';
import {
  OAUTH_CLIENT_SECRET_SLOT,
  newHeaderSlot,
} from '@/lib/connector-credential-slots';
import {
  remoteDraft,
  remoteDraftFromProposal,
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
import { Textarea } from '@/components/ui/textarea';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldSet,
  FieldTitle,
  FieldContent,
  FieldLegend,
} from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConnectorAccessNotice } from '@/components/credentials/ConnectorAccessNotice';
import { ConnectorToolPermissions } from './ConnectorToolPermissions';
import { RequestLeftOutNotice } from './RequestLeftOutNotice';
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
  prefill: prefillProp,
}: ConnectorEditDialogProps & { connector?: Connector }) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  // Slice 2c — "Set it up" on a connector request. Only ever for a new one.
  const prefill = connector ? undefined : prefillProp;
  const [draft, setDraft] = useState(() =>
    prefill
      ? remoteDraftFromProposal(prefill.name, prefill.capabilities)
      : remoteDraft(connector),
  );
  // The request's note for the assistant. Agent-written, so it's shown and
  // editable here rather than saved unseen.
  const [usageNote, setUsageNote] = useState(prefill?.usageNote ?? '');
  const [headersOpen, setHeadersOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // TASK-827 — an admin adding a connector that doesn't sign in with OAuth
  // picks whose key it uses. Fixed once created (the server refuses a change).
  // A request's suggestion is only the starting choice; the admin decides.
  const [keyModeChoice, setKeyModeChoice] = useState<'personal' | 'workspace'>(
    prefill?.keyMode ?? 'personal',
  );
  // Slice 2a: only admins define connectors, and this form opens only from
  // Admin › Connectors, so every read and write is the admin bundle. (The
  // `/settings/connectors` write routes are gone.)
  const base = '/admin/connectors';
  // TASK-809 — a new connector that doesn't sign in with OAuth is added in two
  // steps in this one dialog: Add creates it, then its tools are listed here
  // so Save gives every one an admin default. `created` is that new connector.
  const [created, setCreated] = useState<Connector | null>(null);
  const toolsStepRef = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [metadata, setMetadata] = useState<
    { clientId: string; redirectUri: string } | 'loading' | 'unavailable'
  >('loading');
  const [copied, setCopied] = useState(false);
  const [editingClientSecret, setEditingClientSecret] = useState(false);
  // What the connector pointed at when this form opened. Stays put while the
  // draft's own reference changes (Remove clears it).
  const [savedClientSecretRef] = useState(draft.clientSecretRef);
  // Slice 5 — the connector names a secret the workspace doesn't have (an
  // admin's old per-person copy was removed at boot). Then the box is simply
  // empty, ready to fill in, rather than claiming it's saved.
  const [clientSecretMissing, setClientSecretMissing] = useState(false);
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
  // TASK-755 — the server's tool permissions belong to its address. Saving a
  // new one drops them (the server resets them to Ask first), so say so before
  // Save, and don't write choices that were made for the old address.
  const addressChanged = Boolean(connector) && url !== savedUrl;
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
  // A server that offers OAuth may still take an API key in a request header;
  // the admin picks which. Without OAuth on offer there is nothing to choose.
  const offersOAuth = discovered?.auth === 'oauth';
  const useKey = discovered
    ? offersOAuth && draft.useKey
    : usingSavedSignIn && draft.useKey && draft.signIn === 'none';
  const signIn: RemoteMcpDraft['signIn'] = discovered
    ? offersOAuth && !draft.useKey
      ? 'oauth'
      : 'none'
    : draft.signIn;
  const signInKnown = Boolean(discovered) || usingSavedSignIn;
  // TASK-827 — only a new connector, never OAuth. (Only admins open this form.)
  const offerKeyModeChoice = !connector && signInKnown && signIn !== 'oauth';
  const keyMode: 'personal' | 'workspace' = connector
    ? connector.keyMode
    : offerKeyModeChoice
      ? keyModeChoice
      : 'personal';
  // TASK-809 — an OAuth connector has no admin tool permissions: each person
  // chooses per agent in the rail. So it never loads, shows or writes them.
  // (`signIn` falls back to the saved choice while discovery runs, so an
  // API-key connector's section doesn't flicker away on open.)
  const toolPermissions = useToolPermissions(
    created ? created.id : signIn === 'oauth' ? undefined : connector?.id,
    base,
  );
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
  const effectiveDraft: RemoteMcpDraft = {
    ...draft,
    signIn,
    registration,
    useKey,
  };
  const newHeader = (name = '') => ({
    slot: newHeaderSlot(),
    name,
    value: '',
    saved: false,
  });
  const addHeader = () => update('headers', [...draft.headers, newHeader()]);
  const chooseSignIn = (choice: string) => {
    const nextUseKey = choice === 'key';
    setDraft((current) => ({
      ...current,
      useKey: nextUseKey,
      headers:
        nextUseKey && current.headers.length === 0
          ? [newHeader('Authorization')]
          : current.headers,
    }));
    if (nextUseKey) setHeadersOpen(true);
  };
  const addHeaderButton = (
    <Button
      type="button"
      variant="outline"
      className="self-start"
      disabled={draft.headers.length >= 4}
      onClick={addHeader}
      aria-invalid={draft.headers.length === 0 && Boolean(errors.keyHeader)}
      aria-describedby={
        draft.headers.length === 0 && errors.keyHeader
          ? fieldId('key-header-error')
          : undefined
      }
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
    if (!connector || !savedClientSecretRef) return;
    let stale = false;
    // A convenience, never a gate: if we can't tell, say nothing and keep
    // showing the saved state. Only a workspace (global) copy counts — the
    // host never reads anyone's own.
    void adminCredentials.list().then(
      (rows) => {
        if (stale || !Array.isArray(rows)) return;
        if (
          !rows.some(
            (row) =>
              typeof row === 'object' &&
              row !== null &&
              row.scope === 'global' &&
              row.ref === savedClientSecretRef,
          )
        )
          setClientSecretMissing(true);
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [connector, savedClientSecretRef]);
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
    // So does one that sends its API key there instead of OAuth.
    if (discovered?.auth === 'other' || useKey) setHeadersOpen(true);
  }, [discovered?.auth, useKey]);

  const blocked = awaitingDiscovery || (discoveryFailed && !usingSavedSignIn);
  // Step two waits for the tool list (it resolves or errors), so Save never
  // races past rows that are about to appear.
  const toolsLoading = toolPermissions.load.kind === 'loading';

  useEffect(() => {
    if (created) toolsStepRef.current?.focus();
  }, [created]);

  // The connector already exists once step two is showing, so any way out of
  // the dialog refreshes the list (the parents' onSaved also closes it).
  function close() {
    if (created) onSaved();
    onOpenChange(false);
  }

  function toolPermissionsSaveError(err: unknown): string {
    const status = err instanceof ToolPermissionsError ? err.status : 0;
    return status === 503
      ? 'We saved the connector, but tool permissions can’t be saved right now. Try again in a little while.'
      : status === 400
        ? 'We saved the connector, but these tool permissions didn’t look right to us. Reopen the connector and try again.'
        : status === 403
          ? // Saving again cannot help here, so don't suggest it.
            'We saved the connector, but your account can’t change its tool permissions. Ask a workspace admin to set them.'
          : 'We saved the connector, but not its tool permissions. Try saving again.';
  }

  /** Step two of adding a connector: write its tools' defaults, nothing else. */
  async function saveCreatedTools(createdId: string) {
    if (saving || toolsLoading) return;
    setSaving(true);
    setSaveError('');
    try {
      // Nothing is saved yet, so `changes` holds every row on screen,
      // untouched suggestions included. A list that couldn't load has none.
      if (toolPermissions.changes.length)
        await putToolPermissions(createdId, base, toolPermissions.changes);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setSaveError(toolPermissionsSaveError(err));
    } finally {
      setSaving(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (created) {
      await saveCreatedTools(created.id);
      return;
    }
    if (saving || blocked) return;
    const nextErrors = remoteErrors(effectiveDraft, keyMode);
    // A secret of only spaces is no secret.
    const writesClientSecret =
      signIn === 'oauth' && registration === 'custom' && draft.clientSecret.trim().length > 0;
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
        nextErrors.destination ||
        nextErrors.keyHeader
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
    // A request is created under its own id: that is what clears it.
    const connectorId = connector?.id ?? prefill?.connectorId ?? newId;
    try {
      // Every secret this editor writes is the workspace's. Nothing is ever
      // stored per person (slice 5).
      const workspace = { scope: 'global' as const, ownerId: null };
      let clientSecretRef = draft.clientSecretRef;
      if (writesClientSecret) {
        const destination = {
          kind: 'account' as const,
          service: connectorId,
          slot: OAUTH_CLIENT_SECRET_SLOT,
        };
        await setDestinationCredential({
          destination,
          slot: { kind: 'api-key' },
          scope: workspace,
          payload: draft.clientSecret,
        });
        clientSecretRef = refForDestination(destination);
      }
      // A per-agent key's header values are each agent's own, added when it
      // adds the connector — so only a shared key's are written here. (A
      // value typed before switching to per-agent keys is dropped.)
      if (keyMode === 'workspace')
        for (const header of draft.headers) {
          if (header.value)
            await setDestinationCredential({
              destination: {
                kind: 'account',
                service: connectorId,
                slot: header.slot,
              },
              slot: { kind: 'api-key' },
              scope: workspace,
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
        ...(prefill ? { usageNote } : {}),
      };
      let added: Connector | undefined;
      if (connector) await patchConnector(connectorId, input, base);
      else
        added = await createConnector(input, base);
      update('clientSecret', '');
      // The connector now names the stored copy. A retry (say, of tool
      // permissions below) must not point it back at the one it replaced.
      update('clientSecretRef', clientSecretRef);
      if (writesClientSecret) setClientSecretMissing(false);
      if (added && signIn !== 'oauth') {
        // TASK-809 — stay open on the new connector for step two (its tools).
        setCreated(added);
        return;
      }
      const toolChanges =
        addressChanged || signIn === 'oauth' ? [] : toolPermissions.changes;
      if (connector && toolChanges.length) {
        try {
          await putToolPermissions(connectorId, base, toolChanges);
        } catch (err) {
          // The connector itself is saved; stay open so Save can retry this.
          setSaveError(toolPermissionsSaveError(err));
          return;
        }
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setSaveError(
        isToolPermissionsResetFailure(err)
          ? TOOL_PERMISSIONS_RESET_FAILED_MESSAGE
          : isOwnerOnlyChange(err)
            ? OWNER_ONLY_CHANGE_MESSAGE
            : isConnectorIdTaken(err)
              ? prefill
                ? CONNECTOR_ID_TAKEN_REQUEST_MESSAGE
                : CONNECTOR_ID_TAKEN_MESSAGE
              : 'We couldn’t save this connector. Check the settings and try again.',
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

  const signInDescription = useKey
    ? 'Add the key this server expects as a request header — usually Authorization, with a value like “Bearer <key>”.'
    : signIn === 'none'
      ? discovered?.auth === 'other'
        ? undefined
        : 'This server doesn’t need sign-in. If it expects a key, add it as a request header.'
      : registration === 'custom'
        ? automaticMethod
          ? 'Each agent connects with its own account, using the OAuth client you registered with this service.'
          : 'Each agent connects with its own account. This server doesn’t support automatic setup, so enter the OAuth client you registered with it.'
        : automaticMethod === 'cimd'
          ? 'Each agent connects with its own account. AX identifies itself with its published client details, so there’s nothing to set up.'
          : 'Each agent connects with its own account. AX registers itself with this server automatically, so there’s nothing to set up.';

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (saving) return;
        if (nextOpen) onOpenChange(true);
        else close();
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
              : created
                ? `${created.name} is added. Now choose what agents may do with its tools.`
                : prefill
                  ? 'Filled in from the request. Check each field before you add it.'
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
                {!created && (
                <>
                {prefill && <RequestLeftOutNotice items={prefill.leftOut ?? []} />}
                <FieldGroup>
                  {textField('name', 'Name', 'e.g. Linear')}
                  {textField('url', 'Server URL', 'https://example.com/mcp')}
                  {prefill && (
                    <Field>
                      <FieldLabel htmlFor={fieldId('usage-note')}>
                        How to use it
                      </FieldLabel>
                      <Textarea
                        id={fieldId('usage-note')}
                        rows={3}
                        value={usageNote}
                        onChange={(event) => setUsageNote(event.target.value)}
                      />
                      <FieldDescription>
                        Every assistant that uses this connector reads this note.
                      </FieldDescription>
                    </Field>
                  )}
                </FieldGroup>
                {addressChanged && (
                  // TASK-790 — advice beside a field being typed in, not an
                  // interruption: the shared Alert defaults to role="alert".
                  <Alert data-testid="address-change-resets-tools" role="note">
                    <AlertDescription>
                      Changing the address resets this server’s tool permissions.
                      Every tool goes back to asking first, and choices people made
                      for their own agents are cleared too. Once it’s saved, you can
                      choose again.
                    </AlertDescription>
                  </Alert>
                )}
                {awaitingDiscovery && (
                  <p
                    role="status"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Spinner aria-hidden="true" />
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
                          : useKey
                            ? 'Sign-in: API key'
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
                    {offersOAuth && (
                      <FieldSet>
                        <FieldLegend variant="label" className="sr-only">
                          How people sign in
                        </FieldLegend>
                        <RadioGroup
                          value={useKey ? 'key' : 'oauth'}
                          onValueChange={chooseSignIn}
                        >
                          <Field orientation="horizontal">
                            <RadioGroupItem
                              value="oauth"
                              id={fieldId('sign-in-oauth')}
                            />
                            <FieldContent>
                              <FieldLabel htmlFor={fieldId('sign-in-oauth')}>
                                Each agent signs in (OAuth)
                              </FieldLabel>
                            </FieldContent>
                          </Field>
                          <Field orientation="horizontal">
                            <RadioGroupItem
                              value="key"
                              id={fieldId('sign-in-key')}
                            />
                            <FieldContent>
                              <FieldLabel htmlFor={fieldId('sign-in-key')}>
                                API key in a request header
                              </FieldLabel>
                            </FieldContent>
                          </Field>
                        </RadioGroup>
                      </FieldSet>
                    )}
                    {signIn === 'oauth' && registration === 'custom' && (
                      <FieldGroup className="gap-4">
                          {textField('clientId', 'Client ID')}
                          <Field data-invalid={Boolean(errors.clientSecret)}>
                            <FieldLabel htmlFor={fieldId('client-secret')}>
                              Client secret{' '}
                              <span className="font-normal text-muted-foreground">
                                (optional)
                              </span>
                            </FieldLabel>
                            {draft.clientSecretRef &&
                            !editingClientSecret &&
                            !clientSecretMissing ? (
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
                                aria-invalid={Boolean(errors.clientSecret)}
                                aria-describedby={
                                  errors.clientSecret
                                    ? fieldId('client-secret-error')
                                    : undefined
                                }
                                onChange={(event) =>
                                  update('clientSecret', event.target.value)
                                }
                              />
                            )}
                            {clientSecretMissing &&
                              draft.clientId.trim() !== '' &&
                              draft.clientSecretRef !== '' &&
                              !errors.clientSecret && (
                                // SIGNINS-7 — the connector names a secret the
                                // workspace doesn't have, so sign-ins fail
                                // until it's entered again.
                                <FieldDescription data-testid="client-secret-missing">
                                  The client secret is missing. Enter it again so agents can sign in.
                                </FieldDescription>
                              )}
                            {errors.clientSecret && (
                              <FieldError id={fieldId('client-secret-error')}>
                                {errors.clientSecret}
                              </FieldError>
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
                    {offerKeyModeChoice && (
                      <FieldSet>
                        <FieldLegend variant="label">Whose key</FieldLegend>
                        <RadioGroup
                          value={keyModeChoice}
                          onValueChange={(value) =>
                            setKeyModeChoice(
                              value === 'workspace' ? 'workspace' : 'personal',
                            )
                          }
                        >
                          <Field orientation="horizontal">
                            <RadioGroupItem
                              value="workspace"
                              id={fieldId('key-mode-workspace')}
                            />
                            <FieldContent>
                              <FieldLabel htmlFor={fieldId('key-mode-workspace')}>
                                One shared key for everyone
                              </FieldLabel>
                              <FieldDescription>
                                You add the key once. Anyone can add this
                                connector to their agent without a key.
                              </FieldDescription>
                            </FieldContent>
                          </Field>
                          <Field orientation="horizontal">
                            <RadioGroupItem
                              value="personal"
                              id={fieldId('key-mode-personal')}
                            />
                            <FieldContent>
                              <FieldLabel htmlFor={fieldId('key-mode-personal')}>
                                Each agent adds its own key
                              </FieldLabel>
                            </FieldContent>
                          </Field>
                        </RadioGroup>
                      </FieldSet>
                    )}
                    {connector && signIn !== 'oauth' && (
                      <FieldDescription>
                        {keyMode === 'workspace'
                          ? 'Everyone uses one shared key. To change this, create a new connector.'
                          : 'Each agent adds its own key. To change this, create a new connector.'}
                      </FieldDescription>
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
                    {keyMode === 'workspace' ? (
                      <FieldDescription>
                        Sent with requests to this server. Values are hidden
                        after saving.
                      </FieldDescription>
                    ) : (
                      <>
                        <FieldDescription>
                          Sent with requests to this server.
                        </FieldDescription>
                        <FieldDescription>
                          Each agent adds its own value when it adds this
                          connector.
                        </FieldDescription>
                      </>
                    )}
                    {draft.headers.map((header, index) => (
                      <FieldGroup key={header.slot} className="gap-3">
                        <FieldGroup
                          className={cn(
                            'grid min-w-0 gap-3',
                            keyMode === 'workspace' &&
                              'sm:grid-cols-[minmax(0,190fr)_minmax(0,310fr)]',
                          )}
                        >
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
                          {keyMode === 'workspace' && (
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
                          )}
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
                    {draft.headers.length === 0 && errors.keyHeader && (
                      <FieldError id={fieldId('key-header-error')}>
                        {errors.keyHeader}
                      </FieldError>
                    )}
                    {/* Only a shared key is typed here, so only then is there a
                        key to warn about. */}
                    {keyMode === 'workspace' && draft.headers.length > 0 && (
                      <FieldDescription>
                        Only add a key with the permissions this assistant
                        needs.
                      </FieldDescription>
                    )}
                    {keyMode === 'workspace' && draft.headers.length > 0 && (
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
                </>
                )}
                {created ? (
                  <div ref={toolsStepRef} tabIndex={-1} className="outline-none">
                    <ConnectorToolPermissions
                      state={toolPermissions}
                      connectorName={created.name}
                      isNew={false}
                    />
                  </div>
                ) : (
                  !addressChanged &&
                  // TASK-809 — no admin tool permissions for OAuth; for a new
                  // connector, only once we know it won't sign in that way.
                  (connector ? signIn !== 'oauth' : signInKnown && signIn !== 'oauth') && (
                    <ConnectorToolPermissions
                      state={toolPermissions}
                      connectorName={connector?.name ?? draft.name}
                      isNew={!connector}
                    />
                  )
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
              onClick={close}
            >
              {/* Step two: the connector already exists, so this only skips
                  its tools (they ask first). "Cancel" would promise an undo, and the
                  dialog's X is already named "Close". */}
              {created ? 'Skip for now' : 'Cancel'}
            </Button>
            <Button
              type="submit"
              className="h-11 sm:h-10"
              disabled={saving || (created ? toolsLoading : blocked)}
            >
              {saving
                ? 'Saving…'
                : connector
                  ? 'Save changes'
                  : created
                    ? 'Save'
                    : 'Add connector'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
