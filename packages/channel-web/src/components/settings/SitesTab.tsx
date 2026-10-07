/**
 * SitesTab — Settings › Sites: the two per-person site lists.
 *
 * They used to sit at the bottom of Settings › Connectors. Slice 2a made
 * Connectors an admin page (only admins define connectors), and these lists
 * belong to everyone, so they got a page of their own. The panels are reused
 * exactly as they were; this tab only stacks them, under the pane title's `h1`
 * ("Sites"), each still opening at `h2`.
 *
 * The two are deliberately separate stores (see each panel): Allowed sites is
 * which hosts an agent's sandbox may open network connections to (per agent);
 * Sites we read without asking is which hosts `web_extract` may fetch a page
 * from without stopping to ask (per person). Folding them together would mean
 * approving one page read also opened raw sockets to that host.
 */
import { AllowedSitesPanel } from './AllowedSitesPanel';
import { RememberedSitesPanel } from './RememberedSitesPanel';

export function SitesTab() {
  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <AllowedSitesPanel />
      <RememberedSitesPanel />
    </div>
  );
}
