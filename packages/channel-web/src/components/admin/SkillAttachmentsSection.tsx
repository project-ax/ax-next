import { useEffect, useMemo, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { listSkills } from '@/lib/skills';
import { patchAgentSkillAttachments } from '@/lib/admin';
import type { SkillSummary } from '@ax/skills';

interface Attachment {
  skillId: string;
  credentialBindings: Record<string, string>;
}

interface Props {
  agentId: string;
  initialAttachments: Attachment[];
  onSaved?: (attachments: Attachment[]) => void;
}

// TASK-100 — a skill declares no credential slots, so an attachment carries no
// credential bindings (the per-slot buildBindings/refForDestination helper was
// removed). A skill's reach is its connectors, configured under the Connectors
// tab.

export function SkillAttachmentsSection({
  agentId,
  initialAttachments,
  onSaved,
}: Props) {
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);
  const [allSkills, setAllSkills] = useState<SkillSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addingSkillId, setAddingSkillId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const skills = await listSkills();
        setAllSkills(skills);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const skillById = useMemo(
    () => new Map(allSkills.map((s) => [s.id, s])),
    [allSkills],
  );
  const attachedIds = useMemo(
    () => new Set(attachments.map((a) => a.skillId)),
    [attachments],
  );
  const availableToAttach = allSkills.filter((s) => !attachedIds.has(s.id));

  function attachSkill(skillId: string) {
    setAttachments([...attachments, { skillId, credentialBindings: {} }]);
    setAddingSkillId(null);
  }

  function detach(skillId: string) {
    setAttachments(attachments.filter((a) => a.skillId !== skillId));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Guard: if any attachment is missing skill metadata, abort rather than
      // emitting credentialBindings: {} which would silently erase prior bindings.
      const missingIds = attachments
        .filter((a) => !skillById.has(a.skillId))
        .map((a) => a.skillId);
      if (missingIds.length > 0) {
        setError(`Cannot save: missing skill metadata for ${missingIds.join(', ')}`);
        setSaving(false);
        return;
      }
      // TASK-100 — a skill declares no credential slots (its reach is the
      // connectors it references), so an attachment carries no credential
      // bindings; the agent attaches the skill's instruction body only.
      const withBindings = attachments.map((a) => ({
        ...a,
        credentialBindings: {} as Record<string, string>,
      }));
      await patchAgentSkillAttachments(agentId, withBindings);
      onSaved?.(withBindings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Skills</h3>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save attachments'}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {attachments.length === 0 && (
        <p className="text-sm text-muted-foreground">No skills attached.</p>
      )}

      <ul className="space-y-3 list-none m-0 p-0">
        {attachments.map((a) => {
          const skill = skillById.get(a.skillId);
          return (
            <li key={a.skillId} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-sm font-mono">{a.skillId}</div>
                  {skill && (
                    <div className="text-xs text-muted-foreground">
                      {skill.description}
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => detach(a.skillId)}
                  aria-label={`Detach ${a.skillId}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {/* TASK-100 — a skill declares no credential slots; its reach is
                  its connectors, configured under the Connectors tab. No
                  per-skill credential rows here. */}
            </li>
          );
        })}
      </ul>

      {addingSkillId === null ? (
        availableToAttach.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAddingSkillId('')}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Attach skill
          </Button>
        )
      ) : (
        <div className="flex gap-2 items-center">
          <Select
            value={addingSkillId}
            onValueChange={(v) => v && attachSkill(v)}
          >
            <SelectTrigger className="text-xs">
              <SelectValue placeholder="Pick a skill…" />
            </SelectTrigger>
            <SelectContent>
              {availableToAttach.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAddingSkillId(null)}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
