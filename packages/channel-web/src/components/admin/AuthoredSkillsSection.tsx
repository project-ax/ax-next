/**
 * AuthoredSkillsSection — shows skills an agent has written in its workspace
 * and lets an admin promote one to an installed skill with admin-chosen
 * capability grants.
 *
 * Key constraint (half-trust): if the skill file declares its own
 * capabilities (hasForbiddenCapabilities = true), it cannot be promoted until
 * the agent removes the capabilities block from SKILL.md. The admin always
 * chooses the grants; the file cannot grant itself reach.
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  listAuthoredSkills,
  promoteAuthoredSkill,
  type AuthoredSkill,
  type PromoteGrants,
} from '@/lib/admin';

// ── PromoteDialog ────────────────────────────────────────────────────────────

interface PromoteDialogProps {
  agentId: string;
  skill: AuthoredSkill;
  onClose: () => void;
  onPromoted: () => void;
}

function PromoteDialog({ agentId, skill, onClose, onPromoted }: PromoteDialogProps) {
  const [targetScope, setTargetScope] = useState<'global' | 'user'>('global');
  const [allowedHosts, setAllowedHosts] = useState<string[]>([]);
  const [credentials, setCredentials] = useState<Array<{ slot: string; kind: 'api-key' }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addHost() {
    setAllowedHosts((h) => [...h, '']);
  }

  function updateHost(idx: number, value: string) {
    setAllowedHosts((h) => h.map((v, i) => (i === idx ? value : v)));
  }

  function removeHost(idx: number) {
    setAllowedHosts((h) => h.filter((_, i) => i !== idx));
  }

  function addCredential() {
    setCredentials((c) => [...c, { slot: '', kind: 'api-key' }]);
  }

  function updateCredentialSlot(idx: number, slot: string) {
    setCredentials((c) => c.map((v, i) => (i === idx ? { ...v, slot } : v)));
  }

  function removeCredential(idx: number) {
    setCredentials((c) => c.filter((_, i) => i !== idx));
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    const grants: PromoteGrants = {
      allowedHosts: allowedHosts.filter((h) => h.trim() !== ''),
      // Filter out credential rows whose slot is empty/whitespace — these are
      // blank entries the admin clicked "Add credential" for but never filled in.
      // Sending them to the server causes 400s (slot fails SLOT_RE validation).
      credentials: credentials.filter((c) => c.slot.trim() !== '').map((c) => ({ ...c, slot: c.slot.trim() })),
      mcpServers: [],
    };
    try {
      await promoteAuthoredSkill(agentId, {
        skillId: skill.id,
        targetScope,
        grants,
      });
      onPromoted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Promote skill</DialogTitle>
          <DialogDescription>
            Install <span className="font-mono text-xs">{skill.id}</span> (v{skill.version})
            as a managed skill. Choose the scope and the capabilities the skill will be
            granted — the skill file itself cannot self-grant reach.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* Target scope */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="promote-scope">Target scope</Label>
            <Select
              value={targetScope}
              onValueChange={(v) => setTargetScope(v as 'global' | 'user')}
            >
              <SelectTrigger id="promote-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global (available to all agents)</SelectItem>
                <SelectItem value="user">User (agent owner's private skills)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Allowed hosts */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label>Allowed hosts</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addHost}
              >
                <Plus data-icon="inline-start" />
                Add host
              </Button>
            </div>
            {allowedHosts.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No hosts granted — the skill won't make outbound requests.
              </p>
            )}
            {allowedHosts.map((host, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  placeholder="e.g. api.example.com"
                  value={host}
                  onChange={(e) => updateHost(idx, e.target.value)}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeHost(idx)}
                  aria-label="Remove host"
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>

          {/* Credential slots */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label>Credentials</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addCredential}
              >
                <Plus data-icon="inline-start" />
                Add credential
              </Button>
            </div>
            {credentials.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No credentials granted.
              </p>
            )}
            {credentials.map((cred, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  placeholder="SLOT_NAME (SCREAMING_SNAKE)"
                  value={cred.slot}
                  onChange={(e) => updateCredentialSlot(idx, e.target.value)}
                  className="font-mono text-xs flex-1"
                />
                <span className="text-xs text-muted-foreground shrink-0">api-key</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeCredential(idx)}
                  aria-label="Remove credential"
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>

          {/* MCP servers — deferred */}
          <p className="text-xs text-muted-foreground">
            MCP server grants aren&apos;t editable here yet — promote, then add them
            via Admin &rarr; Skills if needed.
          </p>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? 'Promoting…' : 'Promote'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── AuthoredSkillsSection ─────────────────────────────────────────────────────

interface AuthoredSkillsSectionProps {
  agentId: string;
}

export function AuthoredSkillsSection({ agentId }: AuthoredSkillsSectionProps) {
  const [skills, setSkills] = useState<AuthoredSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<AuthoredSkill | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listAuthoredSkills(agentId);
      setSkills(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <Card className="p-5">
        <CardHeader className="p-0 pb-4">
          <CardTitle className="text-base">Authored Skills</CardTitle>
          <CardDescription>
            Skills this agent wrote in its workspace. Promote one to an installed
            skill, choosing the capabilities to grant.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}

          {!loading && error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {!loading && !error && skills.length === 0 && (
            <p className="text-sm text-muted-foreground">No authored skills.</p>
          )}

          {!loading && !error && skills.length > 0 && (
            <ul className="flex flex-col gap-3 list-none m-0 p-0">
              {skills.map((skill) => (
                <li
                  key={skill.id}
                  className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-mono truncate">{skill.id}</span>
                      <span className="text-xs text-muted-foreground">v{skill.version}</span>
                      {skill.hasForbiddenCapabilities && (
                        <Badge variant="destructive">
                          declares capabilities — remove from SKILL.md before promoting
                        </Badge>
                      )}
                    </div>
                    {skill.description && (
                      <span className="text-xs text-muted-foreground">
                        {skill.description}
                      </span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={skill.hasForbiddenCapabilities}
                    onClick={() => setPromoting(skill)}
                  >
                    Promote
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {promoting && (
        <PromoteDialog
          agentId={agentId}
          skill={promoting}
          onClose={() => setPromoting(null)}
          onPromoted={() => void load()}
        />
      )}
    </>
  );
}
