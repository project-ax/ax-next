import { useEffect, useRef, useState } from 'react';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { routines } from '@/lib/routines';
import { parseRoutineFrontmatter, buildRoutineMd } from '@ax/validator-routine/frontmatter';

/** Use the same validator as the saved route, independently of other fields. */
export function validWebhookPath(path: string): boolean {
  return parseRoutineFrontmatter(buildRoutineMd({
    name: 'preview', description: 'preview', trigger: { kind: 'webhook', path },
    conversation: 'per-fire', silenceMaxChars: 300, promptBody: '',
  })).ok;
}

export function WebhookUrlPreview({ agentId, path, editing, active }: {
  agentId: string | null; path: string; editing: boolean; active: boolean;
}) {
  const requests = useRef(new Map<string, Promise<{ token: string }>>());
  const [receiver, setReceiver] = useState<{ agentId: string; token?: string; error?: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyGeneration = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { copyGeneration.current++; clearTimeout(timer.current); }, []);
  useEffect(() => {
    copyGeneration.current++;
    clearTimeout(timer.current);
    setCopied(null); setCopyError(null);
  }, [agentId, path, active]);
  useEffect(() => {
    if (!active || !agentId) return;
    let cancelled = false;
    let request = requests.current.get(agentId);
    if (!request) {
      request = routines.webhookToken(agentId);
      requests.current.set(agentId, request);
    }
    request.then(({ token }) => {
      if (cancelled) return;
      if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('Unavailable receiver token');
      setReceiver({ agentId, token });
    }).catch(() => {
      if (!cancelled) setReceiver({ agentId, error: 'The webhook URL is unavailable. Only the agent owner or a workspace admin can access its receiver. Reopen the form to retry.' });
    });
    return () => { cancelled = true; };
  }, [agentId, active]);
  if (!active) return null;
  const valid = validWebhookPath(path);
  const token = receiver?.agentId === agentId ? receiver.token : undefined;
  const url = token && valid ? `${window.location.origin}/webhooks/${token}${path}` : '';
  const status = !agentId ? 'Select an agent to see its webhook URL.'
    : receiver?.agentId === agentId && receiver.error ? receiver.error
    : !token ? 'Loading webhook URL…'
    : !valid ? 'Enter a valid webhook path to preview the URL.' : null;
  async function copy(): Promise<void> {
    const generation = ++copyGeneration.current;
    try {
      await navigator.clipboard.writeText(url);
      if (generation !== copyGeneration.current) return;
      setCopyError(null); setCopied(url);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 2000);
    } catch {
      if (generation === copyGeneration.current) setCopyError('Couldn’t copy the URL. Select the URL and copy it manually.');
    }
  }
  return <Field className="gap-1.5">
    <FieldLabel htmlFor="routine-webhook-url">Webhook URL</FieldLabel>
    <div className="flex min-w-0 gap-2">
      <Input id="routine-webhook-url" readOnly value={url} aria-describedby="webhook-url-help" className="min-w-0 flex-1" />
      <Button type="button" variant="outline" disabled={!url} onClick={() => void copy()}>{copied === url && url ? 'Copied' : 'Copy URL'}</Button>
    </div>
    <FieldDescription id="webhook-url-help">
      {status ?? (editing ? 'Updates as you edit. Save to apply path changes.' : 'Create this routine before using the URL in the external service.')}
    </FieldDescription>
    <p role="status" className="text-xs text-muted-foreground">{copyError ?? (copied ? 'URL copied.' : '')}</p>
  </Field>;
}
