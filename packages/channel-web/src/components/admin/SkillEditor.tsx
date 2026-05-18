// Stub — replaced in the next commit.
// SkillsTab imports this so commit 2 is standalone-runnable.

interface Props {
  skillId?: string;
  onSaved: () => void;
  onCancel: () => void;
}

export function SkillEditor({ onCancel }: Props) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">Editor coming soon.</p>
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}
