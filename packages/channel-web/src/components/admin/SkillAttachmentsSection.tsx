import { useEffect, useMemo, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { listSkills, listUserSkills } from '@/lib/skills';
import { humanizeId } from '@/lib/humanize';
import { patchAgentSkillAttachments } from '@/lib/admin';
import type { SkillSummary } from '@ax/skills';
import { List, ListRow, Notice } from '@project-ax/ui';

interface Attachment {
  skillId: string;
  credentialBindings: Record<string, string>;
}

interface Props {
  agentId: string;
  initialAttachments: Attachment[];
  /**
   * Admins pick from the workspace catalog (`/admin/skills`); a non-admin can't
   * reach that, so they pick from THEIR OWN user-scoped skills (`/settings/skills`).
   * The server's owner-scoped attachment guard rejects any skill that would pull
   * in a workspace/shared connector either way.
   */
  isAdmin: boolean;
  onSaved?: (attachments: Attachment[]) => void;
}

// TASK-100 — a skill declares no credential slots, so an attachment carries no
// credential bindings (the per-slot buildBindings/refForDestination helper was
// removed). A skill's reach is its connectors, configured under the Connectors
// tab.

export function SkillAttachmentsSection({
  agentId,
  initialAttachments,
  isAdmin,
  onSaved,
}: Props) {
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);
  const [allSkills, setAllSkills] = useState<SkillSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [readTick, setReadTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [addingSkillId, setAddingSkillId] = useState<string | null>(null);

  useEffect(() => {
    setReadError(null);
    void (async () => {
      try {
        const skills = isAdmin ? await listSkills() : await listUserSkills();
        setAllSkills(skills);
      } catch (err) {
        setReadError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [isAdmin, readTick]);

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
        // (D9) "Cannot save: missing skill metadata for x,y" names our own
        // internal shortfall and leaves the reader with no move. The ids go to
        // the console; the message says what to do.
        console.warn('[skill-attachments] missing skill metadata for', missingIds);
        setError(
          missingIds.length === 1
            ? `We couldn’t load the details for “${humanizeId(missingIds[0]!)}”, so we can’t save yet. Remove it from the list and try again.`
            : 'We couldn’t load the details for some of these skills, so we can’t save yet. Remove the ones that show only an id, and try again.',
        );
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

      {readError && (
        <Notice tone="danger" action={{ label: 'Try again', onClick: () => setReadTick((n) => n + 1) }}>
          {readError}
        </Notice>
      )}
      {error && (
        <Notice tone="danger">{error}</Notice>
      )}

      {/* (TASK-343 / audit D9) "No skills attached." states a fact and teaches
          nothing — least of all to the reader most likely to see it, who has
          never attached one and does not know what it would do. */}
      {attachments.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No skills attached. Attaching a skill teaches this agent a specific
          job — how to file a ticket, or read your calendar — and it can use it
          from then on.
        </p>
      )}

      {attachments.length > 0 && <List label="Attached skills">
        {attachments.map((a) => {
          const skill = skillById.get(a.skillId);
          return (
            <ListRow
              key={a.skillId}
              title={humanizeId(a.skillId)}
              description={skill ? skill.description : a.skillId}
              trailing={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => detach(a.skillId)}
                  aria-label={`Detach ${a.skillId}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              }
            />
          );
        })}
      </List>}

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
