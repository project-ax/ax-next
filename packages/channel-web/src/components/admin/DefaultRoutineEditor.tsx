import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
// `@ax/validator-routine/frontmatter` is the pure-function frontmatter
// parser used by the routines plugin server-side. It has no DB / node-only
// deps (js-yaml + croner, both browser-safe). Importing via the `/frontmatter`
// subpath (instead of the package root) keeps the plugin entry point — which
// transitively pulls in `@ax/core`'s node:crypto-using `randomBytes` — out
// of the SPA bundle. Same shape as @ax/skills/manifest used by SkillEditor.
import { parseRoutineFrontmatter } from '@ax/validator-routine/frontmatter';
import {
  getDefaultRoutine,
  upsertDefaultRoutine,
  updateDefaultRoutine,
} from '@/lib/default-routines';

/**
 * Minimal interval routine to seed a brand-new editor. Matches the strict
 * frontmatter shape the validator accepts: required name + description +
 * trigger, plus the two fields the spec calls out explicitly (conversation,
 * silenceToken).
 */
const EMPTY_TEMPLATE = [
  '---',
  'name: my-default',
  'description: Short description of what this default routine does.',
  'trigger:',
  '  kind: interval',
  '  every: 1h',
  'conversation: shared',
  'silenceToken: NOTHING_TO_REPORT',
  '---',
  'Prompt body goes here. The agent receives this text on every fire.',
  '',
].join('\n');

interface Props {
  defaultRoutineId?: string;
  onSaved: () => void;
  onCancel: () => void;
}

export function DefaultRoutineEditor({
  defaultRoutineId,
  onSaved,
  onCancel,
}: Props) {
  const [text, setText] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(
    defaultRoutineId !== undefined,
  );
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    // Reset loading + serverError on every id change so the editor doesn't
    // show stale content (or a stale error) while the new routine's fetch
    // is in flight. Same shape as SkillEditor.tsx.
    setServerError(null);
    setLoading(defaultRoutineId !== undefined);
    if (defaultRoutineId === undefined) {
      setText(EMPTY_TEMPLATE);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const detail = await getDefaultRoutine(defaultRoutineId);
        if (cancelled) return;
        setText(detail.sourceMd);
      } catch (err) {
        if (cancelled) return;
        setServerError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [defaultRoutineId]);

  // Parse the full text (frontmatter fence + body) on every change. The
  // parser owns the fence regex so the SkillEditor's two-step (slice out
  // yaml, then parse) isn't needed here.
  const parsedResult = useMemo(() => parseRoutineFrontmatter(text), [text]);

  // Defaults are interval-only — the routines:upsert-default hook rejects
  // webhook + cron triggers because there's no per-agent owner to anchor
  // those execution shapes to. Surface that at preview time so the user
  // sees the problem before they hit Save.
  const triggerKindError = useMemo(() => {
    if (!parsedResult.ok) return null;
    const k = parsedResult.fields.trigger.kind;
    if (k === 'webhook') {
      return 'Webhook triggers are not allowed on default routines. Use kind: interval.';
    }
    if (k === 'cron') {
      return 'Cron triggers are not allowed on default routines. Use kind: interval.';
    }
    return null;
  }, [parsedResult]);

  async function handleSave() {
    setSaving(true);
    setServerError(null);
    try {
      if (defaultRoutineId === undefined) {
        await upsertDefaultRoutine(text);
      } else {
        await updateDefaultRoutine(defaultRoutineId, text);
      }
      onSaved();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const liveError = !parsedResult.ok ? parsedResult.reason : null;
  const saveDisabled = saving || liveError !== null || triggerKindError !== null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Routine .md
          </label>
          <Textarea
            className="font-mono text-xs min-h-[400px]"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">
            Parsed preview
          </label>
          {parsedResult.ok ? (
            <div className="rounded-md border border-border p-3 space-y-3 bg-muted/30">
              <div>
                <div className="text-xs text-muted-foreground">Name</div>
                <div className="text-sm font-mono">
                  {parsedResult.fields.name}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Description</div>
                <div className="text-sm">{parsedResult.fields.description}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Trigger</div>
                <Badge variant="secondary" className="text-xs mr-1">
                  {parsedResult.fields.trigger.kind}
                </Badge>
                {parsedResult.fields.trigger.kind === 'interval' && (
                  <span className="text-xs font-mono text-muted-foreground">
                    every {parsedResult.fields.trigger.every}
                  </span>
                )}
                {parsedResult.fields.trigger.kind === 'cron' && (
                  <span className="text-xs font-mono text-muted-foreground">
                    {parsedResult.fields.trigger.expr} ({parsedResult.fields.trigger.tz})
                  </span>
                )}
                {parsedResult.fields.trigger.kind === 'webhook' && (
                  <span className="text-xs font-mono text-muted-foreground">
                    {parsedResult.fields.trigger.path}
                  </span>
                )}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Conversation</div>
                <div className="text-sm font-mono">
                  {parsedResult.fields.conversation}
                </div>
              </div>
              {parsedResult.fields.silenceToken !== undefined && (
                <div>
                  <div className="text-xs text-muted-foreground">
                    Silence token
                  </div>
                  <code className="text-xs font-mono">
                    {parsedResult.fields.silenceToken}
                  </code>
                </div>
              )}
            </div>
          ) : (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">{liveError}</AlertDescription>
            </Alert>
          )}

          {triggerKindError !== null && (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">
                {triggerKindError}
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>

      {serverError && (
        <Alert variant="destructive">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void handleSave()} disabled={saveDisabled}>
          {saving
            ? 'Saving…'
            : defaultRoutineId === undefined
              ? 'Create'
              : 'Update'}
        </Button>
      </div>
    </div>
  );
}
