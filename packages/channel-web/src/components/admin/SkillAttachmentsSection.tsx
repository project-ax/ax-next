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
import { Label } from '@/components/ui/label';
import { listSkills } from '@/lib/skills';
import { adminCredentials, type CredentialMeta } from '@/lib/credentials';
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

export function SkillAttachmentsSection({
  agentId,
  initialAttachments,
  onSaved,
}: Props) {
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);
  const [allSkills, setAllSkills] = useState<SkillSummary[]>([]);
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addingSkillId, setAddingSkillId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [skills, creds] = await Promise.all([
          listSkills(),
          adminCredentials.list(),
        ]);
        setAllSkills(skills);
        setCredentials(creds);
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

  function updateBinding(skillId: string, slot: string, ref: string) {
    setAttachments(
      attachments.map((a) =>
        a.skillId === skillId
          ? { ...a, credentialBindings: { ...a.credentialBindings, [slot]: ref } }
          : a,
      ),
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await patchAgentSkillAttachments(agentId, attachments);
      onSaved?.(attachments);
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
              {skill && skill.capabilities.credentials.length > 0 && (
                <div className="space-y-2">
                  {skill.capabilities.credentials.map((slot) => {
                    const matching = credentials.filter(
                      (c) => c.kind === slot.kind,
                    );
                    return (
                      <div
                        key={slot.slot}
                        className="grid grid-cols-3 gap-2 items-center"
                      >
                        <Label className="text-xs font-mono">{slot.slot}</Label>
                        <Select
                          value={a.credentialBindings[slot.slot] ?? ''}
                          onValueChange={(v) =>
                            updateBinding(a.skillId, slot.slot, v)
                          }
                        >
                          <SelectTrigger className="col-span-2 text-xs">
                            <SelectValue placeholder="Select credential…" />
                          </SelectTrigger>
                          <SelectContent>
                            {matching.length === 0 ? (
                              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                No matching credentials
                              </div>
                            ) : (
                              matching.map((c) => (
                                <SelectItem
                                  key={`${c.scope}-${c.ownerId ?? '_'}-${c.ref}`}
                                  value={c.ref}
                                >
                                  {c.ref}{' '}
                                  <span className="text-muted-foreground">
                                    ({c.scope})
                                  </span>
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              )}
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
