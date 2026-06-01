/**
 * UserSkillsPanel — modal chrome for the per-user "My Skills" view.
 *
 * Dialog overlay around {@link UserSkillsPanelBody} (the shared content; one
 * source of truth — the Settings "Skills" tab renders the same body inline). The
 * body talks to `/settings/skills*`; the server forces scope='user' and
 * ownerUserId from the session.
 *
 * SECURITY NOTE — the access gate is entirely server-side. Hiding admin
 * features here is UX convenience only.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { UserSkillsPanelBody } from './UserSkillsPanelBody';

export function UserSkillsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[900px] font-sans">
        <DialogHeader>
          <DialogTitle>My Skills</DialogTitle>
        </DialogHeader>
        <UserSkillsPanelBody active={open} />
      </DialogContent>
    </Dialog>
  );
}
