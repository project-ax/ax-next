/**
 * A project file's history (W3d, W3 spec §7.3): the History sheet, a version's
 * preview, Restore this version, and Undo the last change.
 *
 * Everyone who can open the file can read its history. Restore and Undo are
 * offered only to editors, and `@ax/projects` checks again, so a stale page
 * can at worst show a button whose answer is a clear refusal.
 *
 * Nothing here names a person by id: the server sends "you", a display name,
 * or nobody, and an agent's name only when it's on this person's own list.
 * Every name and every preview is fenced by the server before it gets here.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { History, Undo2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { fenceLine } from '@/lib/fence-line';
import { logRequestFailure } from '@/lib/http';
import { ProjectFileChangeError, workspaceApi, WorkspaceApiError } from '@/lib/workspace-api';
import { isPlainClick, workspaceRoutePath } from '@/lib/workspace-route';
import { localDayKey, localTime, shortDay, timeAgo } from '@/lib/workspace-time';
import type { ProjectFileHistoryResponse, ProjectFileVersion, ProjectFileVersionPreview } from '@/wire/projects';
import { FileBodyView } from './FileBrowser';
import { changeFailureMessage } from './ProjectFileEditing';

export const RESTORE_CONFIRM_TITLE = 'Restore this version?';
export const UNDO_CONFIRM_TITLE = 'Undo the last change?';
const RESTORE_CONFIRM_BODY = 'The current file stays in history, so you can undo this too.';
export const NOT_RESTORABLE = 'This version can’t be restored.';

/** Can this version's bytes be written back? */
export function isRestorable(v: ProjectFileVersion): boolean {
  return v.kind === 'write' && !v.tooLarge;
}

/**
 * The version Undo restores: the one just before the newest. When the newest
 * is a delete, that's the last write before it (Undo brings the file back).
 * `null` when there's no such version, or it can't be restored: Undo is then
 * not offered, rather than quietly reaching further back.
 */
export function undoTarget(versions: readonly ProjectFileVersion[]): ProjectFileVersion | null {
  const newest = versions[0];
  if (newest === undefined) return null;
  const before = newest.kind === 'delete' ? versions.slice(1).find((v) => v.kind === 'write') : versions[1];
  return before !== undefined && isRestorable(before) ? before : null;
}

function agentName(v: ProjectFileVersion): string {
  if (v.author.kind !== 'agent') return 'an agent';
  return v.author.displayName ?? (v.author.removed ? 'a removed agent' : 'an agent');
}

/** Who, in a few words, or `null` when the title already says. */
function whoOf(v: ProjectFileVersion): string | null {
  switch (v.author.kind) {
    case 'you':
      return 'You';
    case 'person':
      return v.author.displayName ?? 'Someone';
    case 'agent':
      // "Changed by Scout" already names the agent.
      if (v.label === 'agent' && v.kind === 'write') return null;
      return capitalize(agentName(v));
    case 'none':
      return null;
  }
}

/** What happened, as the row's title. */
function whatOf(v: ProjectFileVersion): string {
  if (v.kind === 'delete') return 'Deleted';
  switch (v.label) {
    case 'edit':
      return 'Edited';
    case 'agent':
      return `Changed by ${agentName(v)}`;
    case 'restore':
      return 'Restored';
    case 'seed':
      return 'Created with the project';
    case 'outside':
      return 'Changed outside history';
    case 'baseline':
      return 'Before history started';
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** "10:42", or "7 Oct, 10:42" on another day. */
function clockOf(iso: string): string {
  const time = localTime(iso);
  if (time === null) return 'a while ago';
  const d = new Date(iso);
  return localDayKey(d) === localDayKey(new Date()) ? time : `${shortDay(iso)}, ${time}`;
}

function absoluteOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** What a refused restore says. */
export function restoreFailureMessage(e: unknown): string {
  if (e instanceof ProjectFileChangeError && e.code === 'not-restorable') return NOT_RESTORABLE;
  if (e instanceof WorkspaceApiError && e.status === 409) return NOT_RESTORABLE;
  if (e instanceof WorkspaceApiError && e.status === 404) return 'That version isn’t here anymore.';
  return changeFailureMessage(e, 'save');
}

type Row = { kind: 'version'; version: ProjectFileVersion } | { kind: 'gap'; at: string };

/**
 * The versions with the gaps that fall in their span (from the oldest
 * version to now), newest first.
 */
export function historyRows(data: ProjectFileHistoryResponse): Row[] {
  const oldest = data.versions[data.versions.length - 1];
  if (oldest === undefined) return [];
  const from = Date.parse(oldest.createdAt);
  const rows: Array<Row & { t: number }> = [
    ...data.versions.map((v) => ({ kind: 'version' as const, version: v, t: Date.parse(v.createdAt) })),
    ...data.gaps
      .map((g) => ({ kind: 'gap' as const, at: g.at, t: Date.parse(g.at) }))
      .filter((g) => !Number.isNaN(g.t) && g.t >= from),
  ];
  // Stable: versions keep the server's order among equal times.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.t - a.r.t || a.i - b.i)
    .map(({ r }) => (r.kind === 'gap' ? { kind: 'gap', at: r.at } : { kind: 'version', version: r.version }));
}

type Load =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'unavailable' }
  | { status: 'ready'; data: ProjectFileHistoryResponse };

type PreviewState =
  | { versionId: string; status: 'loading' }
  | { versionId: string; status: 'failed' }
  | { versionId: string; status: 'ready'; preview: ProjectFileVersionPreview };

export function FileHistorySheet({
  projectId,
  path,
  label,
  open,
  canEdit,
  onOpenChange,
  onRestored,
  onOpenChat,
}: {
  projectId: string;
  /** The file's raw key. Never drawn. */
  path: string;
  /** The file's fenced name, for the title. */
  label: string;
  open: boolean;
  /** Offer Restore and Undo (an editor). */
  canEdit: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a restore: re-read whatever shows the file. */
  onRestored: () => void;
  onOpenChat?: (agentId: string, conversationId: string) => void;
}) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [confirm, setConfirm] = useState<{ version: ProjectFileVersion; undo: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoad((prev) => (prev.status === 'ready' && attempt > 0 ? prev : { status: 'loading' }));
    void (async () => {
      try {
        const data = await workspaceApi.projectFileHistory(projectId, path);
        if (!cancelled) setLoad({ status: 'ready', data });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof WorkspaceApiError && e.status === 503) {
          setLoad({ status: 'unavailable' });
          return;
        }
        logRequestFailure(e, 'project-file-history');
        setLoad({ status: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, path, attempt]);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setConfirm(null);
      setError(null);
    }
  }, [open]);

  const showPreview = useCallback(
    async (versionId: string) => {
      if (preview?.versionId === versionId) {
        setPreview(null);
        return;
      }
      setPreview({ versionId, status: 'loading' });
      try {
        const got = await workspaceApi.projectFileVersion(projectId, versionId);
        setPreview((p) => (p?.versionId === versionId ? { versionId, status: 'ready', preview: got } : p));
      } catch (e) {
        logRequestFailure(e, 'project-file-version');
        setPreview((p) => (p?.versionId === versionId ? { versionId, status: 'failed' } : p));
      }
    },
    [projectId, preview],
  );

  async function restore() {
    if (confirm === null) return;
    setBusy(true);
    setError(null);
    try {
      await workspaceApi.restoreProjectFileVersion(projectId, confirm.version.versionId);
      setConfirm(null);
      setPreview(null);
      setAttempt((n) => n + 1);
      onRestored();
    } catch (e) {
      setError(restoreFailureMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const data = load.status === 'ready' ? load.data : null;
  const undo = canEdit && data !== null ? undoTarget(data.versions) : null;
  const rows = data !== null ? historyRows(data) : [];

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>History</SheetTitle>
            <SheetDescription className="truncate" title={label}>
              {label}
            </SheetDescription>
          </SheetHeader>

          {confirm?.undo === true && (
            <RestoreConfirm
              undo
              busy={busy}
              error={error}
              onConfirm={() => void restore()}
              onCancel={() => {
                setConfirm(null);
                setError(null);
              }}
            />
          )}

          {undo !== null && confirm === null && (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() => {
                setError(null);
                setConfirm({ version: undo, undo: true });
              }}
            >
              <Undo2 data-icon="inline-start" />
              Undo the last change
            </Button>
          )}

          {load.status === 'loading' ? (
            <div className="flex flex-col gap-2" aria-label="Loading history">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : load.status === 'unavailable' ? (
            <p className="text-[13px] text-muted-foreground">History isn’t available on this server.</p>
          ) : load.status === 'failed' ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-col items-start gap-2">
                <span>We couldn’t load this file’s history just now.</span>
                <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : rows.length === 0 ? (
            <Empty className="p-3 md:p-3">
              <EmptyHeader>
                <EmptyDescription>No history for this file yet. Changes show up here once they happen.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ol className="flex flex-col" aria-label="Versions">
              {rows.map((row, i) => (
                <li key={row.kind === 'gap' ? `gap:${row.at}:${i}` : row.version.versionId}>
                  {i > 0 && <Separator />}
                  {row.kind === 'gap' ? (
                    <p className="py-3 text-[12.5px] italic text-muted-foreground">
                      History may be missing changes from around {clockOf(row.at)}.
                    </p>
                  ) : (
                    <VersionRow
                      version={row.version}
                      path={path}
                      canEdit={canEdit}
                      preview={preview?.versionId === row.version.versionId ? preview : null}
                      onPreview={() => void showPreview(row.version.versionId)}
                      onRestore={() => {
                        setError(null);
                        setConfirm({ version: row.version, undo: false });
                      }}
                      confirm={
                        confirm !== null && !confirm.undo && confirm.version.versionId === row.version.versionId ? (
                          <RestoreConfirm
                            undo={false}
                            busy={busy}
                            error={error}
                            onConfirm={() => void restore()}
                            onCancel={() => {
                              setConfirm(null);
                              setError(null);
                            }}
                          />
                        ) : null
                      }
                      onOpenChat={onOpenChat}
                    />
                  )}
                </li>
              ))}
            </ol>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * Restore and Undo confirm INLINE, inside the Sheet, never as a second modal.
 * An AlertDialog stacked over the Sheet left the page unclickable once it
 * closed (Cancel or Restore), and the restore never reached the server: two
 * modal layers tearing down together leave `pointer-events: none` behind.
 * Found on the production smoke test, 2026-10-19.
 */
function RestoreConfirm({
  undo,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  undo: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    confirmRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const title = undo ? UNDO_CONFIRM_TITLE : RESTORE_CONFIRM_TITLE;
  return (
    <Alert role="group" aria-label={title}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>{RESTORE_CONFIRM_BODY}</span>
        {error !== null && <span className="text-destructive">{error}</span>}
        <span className="flex gap-2">
          <Button ref={confirmRef} size="sm" disabled={busy} onClick={onConfirm}>
            {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
            {undo ? 'Undo' : 'Restore'}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}

function VersionRow({
  version: v,
  path,
  canEdit,
  preview,
  onPreview,
  onRestore,
  onOpenChat,
  confirm,
}: {
  version: ProjectFileVersion;
  path: string;
  canEdit: boolean;
  preview: PreviewState | null;
  onPreview: () => void;
  onRestore: () => void;
  onOpenChat?: ((agentId: string, conversationId: string) => void) | undefined;
  /** This row's restore confirmation, when it's the one being restored. */
  confirm: ReactNode;
}) {
  const who = whoOf(v);
  const restorable = isRestorable(v);
  const chat = v.chat;
  return (
    <div className="flex flex-col gap-2 py-3" data-testid={`version-${v.versionId}`}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="break-words text-[13px] font-medium">{whatOf(v)}</span>
          <span className="text-[12px] text-muted-foreground">
            {who !== null && <>{who} · </>}
            <time dateTime={v.createdAt} title={absoluteOf(v.createdAt)}>
              {timeAgo(v.createdAt)}
            </time>
            {chat !== null && (
              <>
                {' · '}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href={workspaceRoutePath({ kind: 'agent', id: chat.agentId, tab: 'chat' })}
                  onClick={(e: MouseEvent) => {
                    if (onOpenChat === undefined || !isPlainClick(e)) return;
                    e.preventDefault();
                    onOpenChat(chat.agentId, chat.conversationId);
                  }}
                >
                  Open the chat
                </a>
              </>
            )}
          </span>
          {v.tooLarge && (
            <Badge variant="secondary" className="mt-1 self-start">
              Too large to keep history
            </Badge>
          )}
        </div>
        {restorable && (
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" aria-expanded={preview !== null} onClick={onPreview}>
              {preview !== null ? 'Hide' : 'Preview'}
            </Button>
            {canEdit && confirm === null && (
              <Button variant="outline" size="sm" onClick={onRestore}>
                <History data-icon="inline-start" />
                Restore
              </Button>
            )}
          </div>
        )}
      </div>
      {confirm}
      {preview !== null && (
        <div className="max-h-80 overflow-y-auto rounded-md border border-border bg-card p-4" aria-label="Version preview">
          {preview.status === 'loading' ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner aria-hidden="true" className="size-3.5" />
              Opening&hellip;
            </div>
          ) : preview.status === 'failed' ? (
            <p className="text-[13px] text-muted-foreground">We couldn’t open this version just now.</p>
          ) : (
            <FileBodyView
              file={{
                kind: 'file',
                path,
                name: fenceLine(path, 120) ?? '',
                body: preview.preview.body,
                clipped: preview.preview.clipped,
                size: preview.preview.size,
              }}
              binaryCopy={
                canEdit
                  ? 'This version isn’t text, so there’s no preview. You can still restore it.'
                  : 'This version isn’t text, so there’s no preview.'
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
