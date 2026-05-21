import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
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
import type { SkillDetail } from '@ax/skills';

/** Minimal API surface the editor needs — injectable for user vs admin routes. */
export interface SkillEditorApi {
  getSkill: (skillId: string) => Promise<SkillDetail>;
  upsertSkill: (
    skillMd: string,
    opts?: { defaultAttached?: boolean },
  ) => Promise<{ skillId: string; created: boolean }>;
  updateSkill: (
    skillId: string,
    skillMd: string,
    opts?: { defaultAttached?: boolean },
  ) => Promise<{ skillId: string; created: boolean }>;
}

const defaultApi: SkillEditorApi = { getSkill, upsertSkill, updateSkill };

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
  /** Override the API client (defaults to admin `/admin/skills*` functions). */
  api?: SkillEditorApi;
}

export function SkillEditor({ skillId, onSaved, onCancel, api = defaultApi }: Props) {
  const [text, setText] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(skillId !== undefined);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [defaultAttached, setDefaultAttached] = useState<boolean>(false);

  useEffect(() => {
    // Reset loading + serverError on every skillId change so the editor
    // doesn't show stale content (or a stale error) while the new skill's
    // fetch is in flight. Without this, an editor that was just open on
    // skill A can briefly be saved as skill B before A's bytes are
    // replaced.
    setServerError(null);
    setLoading(skillId !== undefined);
    if (skillId === undefined) {
      setText(EMPTY_TEMPLATE);
      setDefaultAttached(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const detail = await api.getSkill(skillId);
        if (cancelled) return;
        const md =
          '---\n' +
          detail.manifestYaml +
          (detail.manifestYaml.endsWith('\n') ? '' : '\n') +
          '---\n' +
          detail.bodyMd;
        setText(md);
        setDefaultAttached(detail.defaultAttached);
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
  // `api` is an object reference; listing it as a dep is correct but
  // callers that inline the object literal would re-run on every render.
  // The intent is that callers pass a stable (module-level) constant.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillId, api]);

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

  // Only the confirmed-credentials case should auto-clear the flag. A
  // transient parse error (parsedResult.ok === false) leaves the flag
  // alone so the box doesn't silently un-check while the user is mid-
  // typing — they fix the YAML and the checked state survives.
  const hasCredentialSlots =
    parsedResult.ok && parsedResult.value.capabilities.credentials.length > 0;
  const canBeDefault = parsedResult.ok && !hasCredentialSlots;
  useEffect(() => {
    if (hasCredentialSlots && defaultAttached) setDefaultAttached(false);
  }, [hasCredentialSlots, defaultAttached]);

  async function handleSave() {
    setSaving(true);
    setServerError(null);
    try {
      if (skillId === undefined) {
        await api.upsertSkill(text, { defaultAttached });
      } else {
        await api.updateSkill(skillId, text, { defaultAttached });
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

      <div className="flex items-start gap-2">
        <Checkbox
          id="default-attached"
          checked={defaultAttached}
          disabled={!canBeDefault}
          onCheckedChange={(v) => setDefaultAttached(v === true)}
        />
        <div className="space-y-1 leading-none">
          <label
            htmlFor="default-attached"
            className="text-sm font-medium"
          >
            Default-attached to all agents
          </label>
          <p className="text-xs text-muted-foreground">
            {canBeDefault
              ? "Adds this skill to every agent at session start, without per-agent setup."
              : "Capability-bearing skills must be attached per agent."}
          </p>
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
