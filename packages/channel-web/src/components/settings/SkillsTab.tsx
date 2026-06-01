/**
 * SkillsTab — the Settings "Skills" surface (connectors-first-class UI/IA
 * reorg). This collapses the audit's "My Skills" + "Catalog" into one **Skills**
 * tab under the single source badge: a catalog-sourced skill wears the calm
 * "Catalog" tag; a private one shows none (see {@link SourceBadge}).
 *
 * The content IS the shared {@link UserSkillsPanelBody} — one source of truth
 * (invariant #4) with the user-menu "My Skills" modal. The tab is always
 * active, so the body fetches on mount.
 */
import { UserSkillsPanelBody } from '@/components/skills/UserSkillsPanelBody';

export function SkillsTab() {
  return (
    <div className="font-sans">
      <UserSkillsPanelBody active />
    </div>
  );
}
