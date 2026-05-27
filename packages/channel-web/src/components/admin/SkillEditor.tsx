import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
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
import type { BundleFile, SkillDetail } from '@ax/skills';

/** Minimal API surface the editor needs — injectable for user vs admin routes. */
export interface SkillEditorApi {
  getSkill: (skillId: string) => Promise<SkillDetail>;
  upsertSkill: (
    skillMd: string,
    opts?: { defaultAttached?: boolean; files?: BundleFile[] },
  ) => Promise<{ skillId: string; created: boolean }>;
  updateSkill: (
    skillId: string,
    skillMd: string,
    opts?: { defaultAttached?: boolean; files?: BundleFile[] },
  ) => Promise<{ skillId: string; created: boolean }>;
}

// Client-side bundle-file path hints — a UX mirror of the server's
// validateBundleFiles rules (path-safety + reserved-name veto). The SERVER
// stays the source of truth; this only gives instant feedback and gates the
// Save button so we don't round-trip an obviously-bad path. Keep these in sync
// with `bundle-files.ts` in @ax/skills.
const BUNDLE_PATH_RE = /^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/;
const RESERVED_BUNDLE_NAMES = ['skill.md', '.mcp.json', '.claude', '.git'];

/**
 * Returns a human hint string when `path` is invalid for a bundle file, or
 * null when it's acceptable. `reserved` is matched case-insensitively for
 * SKILL.md (the server reserves the exact `SKILL.md`, but the path charset is
 * lowercase, so a lowercased compare catches the user's likely typo).
 */
function bundlePathHint(path: string): string | null {
  const p = path.trim();
  if (p.length === 0) return 'Path is required.';
  if (p.length > 256) return 'Path is too long (max 256 chars).';
  if (p.startsWith('/')) return 'Path must be relative (no leading "/").';
  if (p.includes('..')) return 'Path may not contain "..".';
  if (p.split('/').some((seg) => seg === '.' || seg === '..')) {
    return 'Path may not contain "." or ".." segments.';
  }
  if (!BUNDLE_PATH_RE.test(p)) {
    return 'Use lowercase letters, digits, dot, dash, underscore, and "/" only.';
  }
  const lower = p.toLowerCase();
  if (
    RESERVED_BUNDLE_NAMES.some(
      (r) => lower === r || lower.startsWith(r + '/'),
    )
  ) {
    return 'Reserved path (SKILL.md / .mcp.json / .claude / .git are generated).';
  }
  return null;
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
  const [files, setFiles] = useState<BundleFile[]>([]);
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
      setFiles([]);
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
        // The editor OWNS the full file set it displays: on save it round-trips
        // exactly these files (a body-only edit therefore preserves them rather
        // than wiping the bundle, and a removed file is actually removed).
        setFiles(detail.files.map((f) => ({ path: f.path, contents: f.contents })));
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
  // `api` is an object reference and is correctly listed as a dep below;
  // callers are expected to pass a stable (module-level) constant so this
  // effect doesn't re-run every render (the admin default and the user
  // panel's `userSkillsApi` are both module-level constants).
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

  // ── Bundle-file list helpers ──────────────────────────────────────────────
  const addFile = () =>
    setFiles((prev) => [...prev, { path: '', contents: '' }]);
  const setFilePath = (idx: number, path: string) =>
    setFiles((prev) => prev.map((f, i) => (i === idx ? { ...f, path } : f)));
  const setFileContents = (idx: number, contents: string) =>
    setFiles((prev) => prev.map((f, i) => (i === idx ? { ...f, contents } : f)));
  const removeFile = (idx: number) =>
    setFiles((prev) => prev.filter((_, i) => i !== idx));

  // Per-file hint: invalid path OR a duplicate of an earlier file's path. A
  // duplicate is flagged on the LATER occurrence so the first stays "valid".
  const fileHints = useMemo(() => {
    const seen = new Set<string>();
    return files.map((f) => {
      const hint = bundlePathHint(f.path);
      if (hint !== null) return hint;
      const key = f.path.trim();
      if (seen.has(key)) return 'Duplicate path.';
      seen.add(key);
      return null;
    });
  }, [files]);
  const filesInvalid = fileHints.some((h) => h !== null);

  async function handleSave() {
    setSaving(true);
    setServerError(null);
    // Always send the displayed file set (WYSIWYG): the server replaces the
    // bundle with exactly these files. Trim paths to match what the user sees.
    const filesPayload: BundleFile[] = files.map((f) => ({
      path: f.path.trim(),
      contents: f.contents,
    }));
    try {
      if (skillId === undefined) {
        await api.upsertSkill(text, { defaultAttached, files: filesPayload });
      } else {
        await api.updateSkill(skillId, text, {
          defaultAttached,
          files: filesPayload,
        });
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

      <Separator />

      {/* Bundle files — the extra (non-SKILL.md) files shipped alongside the
          manifest. Contents render in text-only controls (Input/Textarea);
          never via dangerouslySetInnerHTML. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <Label className="text-xs font-medium text-muted-foreground">
              Bundle files
            </Label>
            <p className="text-xs text-muted-foreground">
              Extra files packaged with this skill (scripts, references). SKILL.md
              is authored above.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addFile}
            disabled={files.length >= 16}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add file
          </Button>
        </div>

        {files.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No extra files. This is a single-file (SKILL.md-only) skill.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {files.map((f, idx) => {
              const hint = fileHints[idx];
              return (
                <div
                  key={idx}
                  className="rounded-md border border-border p-3 flex flex-col gap-2 bg-muted/30"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={`Bundle file path ${idx + 1}`}
                      className="h-8 text-xs font-mono"
                      placeholder="scripts/run.py"
                      value={f.path}
                      aria-invalid={hint !== null}
                      onChange={(e) => setFilePath(idx, e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeFile(idx)}
                      aria-label={`Remove bundle file ${f.path || idx + 1}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {hint !== null && (
                    <p className="text-xs text-destructive">{hint}</p>
                  )}
                  <Textarea
                    aria-label={`Bundle file contents ${idx + 1}`}
                    className="font-mono text-xs min-h-[120px]"
                    placeholder="File contents…"
                    value={f.contents}
                    onChange={(e) => setFileContents(idx, e.target.value)}
                  />
                </div>
              );
            })}
          </div>
        )}
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
          disabled={saving || liveError !== null || filesInvalid}
        >
          {saving ? 'Saving…' : skillId === undefined ? 'Install' : 'Update'}
        </Button>
      </div>
    </div>
  );
}
