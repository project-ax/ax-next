import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
// `@ax/skills/manifest` is a pure-function SKILL.md parser (yaml +
// shape validation) exported via a subpath so the heavy bits of
// @ax/skills (kysely db, http routes, node:crypto via @ax/core) stay
// out of the browser bundle. Same library-not-plugin shape as
// @ax/validator-routine — the parser IS the boundary contract that
// the admin editor's live-preview pane consumes. Disable applies to
// THIS LINE ONLY; component-level eslint posture is unchanged.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { parseSkillManifest } from '@ax/skills/manifest';
import { getSkill, upsertSkill, updateSkill } from '@/lib/skills';

const EMPTY_TEMPLATE = [
  '---',
  'name: example',
  'description: Short description of what this skill does.',
  'capabilities:',
  '  allowedHosts:',
  '    - api.example.com',
  '  credentials:',
  '    - slot: EXAMPLE_TOKEN',
  '      kind: api-key',
  '      description: API token for example.com.',
  '---',
  '# Body',
  '',
  'Markdown body. This becomes the SKILL.md the SDK indexes.',
  '',
].join('\n');

interface Props {
  skillId?: string;
  onSaved: () => void;
  onCancel: () => void;
}

export function SkillEditor({ skillId, onSaved, onCancel }: Props) {
  const [text, setText] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(skillId !== undefined);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (skillId === undefined) {
      setText(EMPTY_TEMPLATE);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const detail = await getSkill(skillId);
        if (cancelled) return;
        const md =
          '---\n' +
          detail.manifestYaml +
          (detail.manifestYaml.endsWith('\n') ? '' : '\n') +
          '---\n' +
          detail.bodyMd;
        setText(md);
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
  }, [skillId]);

  // Parse the manifest yaml between the first two `---` fences on every change.
  const parsedResult = useMemo(() => {
    const re = /^---\n([\s\S]*?)\n---/;
    const m = re.exec(text);
    if (m === null) {
      return {
        ok: false as const,
        code: 'no-fence' as const,
        message: 'Missing frontmatter fence (--- yaml ---)',
      };
    }
    return parseSkillManifest(m[1] ?? '');
  }, [text]);

  async function handleSave() {
    setSaving(true);
    setServerError(null);
    try {
      if (skillId === undefined) {
        await upsertSkill(text);
      } else {
        await updateSkill(skillId, text);
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

  const liveError = !parsedResult.ok
    ? `${'code' in parsedResult ? parsedResult.code : ''}: ${parsedResult.message}`
    : null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            SKILL.md
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
                <div className="text-sm font-mono">{parsedResult.value.id}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Description</div>
                <div className="text-sm">{parsedResult.value.description}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">
                  Allowed hosts
                </div>
                {parsedResult.value.capabilities.allowedHosts.length === 0 ? (
                  <span className="text-xs text-muted-foreground">none</span>
                ) : (
                  parsedResult.value.capabilities.allowedHosts.map((h) => (
                    <Badge key={h} variant="secondary" className="text-xs mr-1">
                      {h}
                    </Badge>
                  ))
                )}
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">
                  Credential slots
                </div>
                {parsedResult.value.capabilities.credentials.length === 0 ? (
                  <span className="text-xs text-muted-foreground">none</span>
                ) : (
                  <ul className="space-y-1 text-xs list-none m-0 p-0">
                    {parsedResult.value.capabilities.credentials.map((c) => (
                      <li key={c.slot}>
                        <code className="font-mono">{c.slot}</code>
                        <span className="text-muted-foreground">
                          {' '}
                          ({c.kind})
                        </span>
                        {c.description && (
                          <span className="text-muted-foreground">
                            {' '}
                            &mdash; {c.description}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">{liveError}</AlertDescription>
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
        <Button
          onClick={() => void handleSave()}
          disabled={saving || liveError !== null}
        >
          {saving ? 'Saving…' : skillId === undefined ? 'Install' : 'Update'}
        </Button>
      </div>
    </div>
  );
}
