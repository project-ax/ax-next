/**
 * SkillsTab — the Settings "Skills" surface as an app-store (TASK-126,
 * settings-unified epic). INSTALLED (active on the current agent) vs
 * NOT INSTALLED · available in your workspace (the catalog you can self-install
 * from). Admin catalog curation + the awaiting-review admit queue fold INLINE,
 * gated on `isAdmin` — there is no separate Catalog / Awaiting-review nav surface
 * anymore (TASK-125 dropped them).
 *
 * The body IS {@link SkillsAppStore} — one source of truth (invariant #4). The
 * tab is just chrome around it; `isAdmin` is passed through from AdminShell to
 * gate the inline curation affordances (UX convenience — every /admin/* route is
 * role-gated server-side regardless).
 */
import { SkillsAppStore } from './SkillsAppStore';

export function SkillsTab({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="font-sans">
      <SkillsAppStore isAdmin={isAdmin} />
    </div>
  );
}
