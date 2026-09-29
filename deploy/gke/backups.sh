#!/usr/bin/env bash
#
# deploy/gke/backups.sh — snapshot schedule, health check and restore drill for
# the two disks that hold users' data on GKE.
#
#   bash deploy/gke/backups.sh enable        [--dry-run] [--snapshot-now]
#   bash deploy/gke/backups.sh status
#   bash deploy/gke/backups.sh drill         [--dry-run] [--keep]
#   bash deploy/gke/backups.sh drill-cleanup [--dry-run]
#
# The runbook is deploy/GKE.md ("Backups and disaster recovery"). Read it first:
# it says what these commands protect, what they do not, and how much data a bad
# day can still cost.
#
# WHAT IT TOUCHES, AND WHAT IT NEVER DOES
#
#   enable        Creates ONE snapshot schedule (a Compute Engine resource
#                 policy), attaches it to the workspace disk and the facts disk,
#                 and turns on Cloud SQL deletion protection. Nothing else. It
#                 never detaches, resizes, deletes or writes to a disk, and it
#                 never changes Cloud SQL backup or point-in-time-recovery
#                 settings (it only reports them).
#   status        Read-only.
#   drill         Creates SCRATCH disks from the newest snapshots, mounts them in
#                 a throwaway pod in its own namespace, runs the checks in
#                 restore-drill-verify.sh, then deletes everything it made. The
#                 production disks are never attached to the drill pod.
#   drill-cleanup Deletes leftovers of a drill that died half way. It only
#                 touches objects carrying the label `ax-restore-drill` (disks:
#                 `ax_restore_drill`) AND named ax-restore-drill-*.
#
# HOW IT FINDS THINGS. Nothing about a particular deployment is written in this
# file (the repo is public). The disks come from the cluster at run time:
#   PVC -> PersistentVolume -> spec.csi.volumeHandle = projects/<p>/zones/<z>/disks/<d>
# so the project, zone and disk name are always the ones the pods really use.
# The PVC names, namespace and Cloud SQL instance name default to what
# deploy/GKE.md creates; override them with the flags below if yours differ.
#
# SAFETY
#   --dry-run     changes nothing. It still READS from the cluster and from GCP
#                 (it has to, to know what to plan), and it prints every write it
#                 would have made.
#   Re-running    is safe. Every step checks before it writes.
#   --project     is an ASSERTION, not a selector: if you pass it and the disks
#                 live in a different project, the script stops before writing.
#   --context     defaults to your CURRENT kubectl context; the script prints it
#                 first, and every kubectl call after that names it explicitly,
#                 so switching context in another terminal cannot redirect it.
#
# Works with the bash 3.2 that ships on macOS (no associative arrays, no
# mapfile, no ${var,,}). Exit status: 0 fine, 1 a check or step failed,
# 2 refused to run (bad arguments, or the target is not what we expected).

set -euo pipefail

# ── The numbers GKE.md quotes. scripts/__tests__/gke-backups-docs.test.js fails
#    if the runbook and these ever disagree. ──────────────────────────────────
DEFAULT_SCHEDULE_NAME="ax-next-daily"
DEFAULT_RETENTION_DAYS=14
DEFAULT_START_TIME="09:00" # UTC. Overnight in the Americas.
# A daily schedule that has not produced a snapshot for this long is broken.
# 24h plus 12h of slack for a slow snapshot or a skipped night.
STALE_AFTER="PT36H"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_SCRIPT="$SELF_DIR/restore-drill-verify.sh"

CMD=""
DRY_RUN=0
CONTEXT=""
ASSERT_PROJECT=""
NAMESPACE="ax-next"
WORKSPACE_PVC="ax-next-workspace"
FACTS_PVC="ax-next-memory-facts"
SQL_INSTANCE="ax-next-db"
SCHEDULE_NAME="$DEFAULT_SCHEDULE_NAME"
RETENTION_DAYS="$DEFAULT_RETENTION_DAYS"
START_TIME="$DEFAULT_START_TIME"
SNAPSHOT_NOW=0
HOST_DEPLOYMENT="ax-next-host"
IMAGE=""
DRILL_NAMESPACE="ax-restore-drill"
DRILL_TIMEOUT=1200
KEEP=0
OPT_workspace_snapshot=""
OPT_facts_snapshot=""

PROJECT=""
RUN_ID=""
PROBLEMS=0
STAGES=""
# Tests set this to 0 so the stubbed cluster does not make them sleep.
POLL_SECONDS="${AX_BACKUPS_POLL_SECONDS:-5}"

KINDS="workspace facts"
TAB="$(printf '\t')"

NAME_RE='^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$'
K8S_NAME_RE='^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$'
ZONE_RE='^[a-z]+-[a-z]+[0-9]+-[a-z]$'
PROJECT_RE='^[a-z][-a-z0-9.:]{2,60}[a-z0-9]$'
IMAGE_RE='^[A-Za-z0-9][-A-Za-z0-9._/:@]*$'

# ── Output ───────────────────────────────────────────────────────────────────
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  exit 1
}
problem() {
  PROBLEMS=$((PROBLEMS + 1))
  printf 'PROBLEM: %s\n' "$*" >&2
}

usage() {
  cat <<'USAGE'
Usage: bash deploy/gke/backups.sh <command> [options]

Commands
  enable          Create the daily snapshot schedule, attach it to the workspace
                  and facts disks, and turn on Cloud SQL deletion protection.
                  Safe to re-run.
  status          Read-only health check: is the schedule attached, is it
                  producing snapshots, are Cloud SQL backups on. Exits 1 if not.
  drill           Restore the newest snapshot of each disk to scratch disks,
                  mount them in a throwaway pod, check the git repos and
                  facts.db open, then delete everything it made.
  drill-cleanup   Remove anything a drill left behind.

Options
  --dry-run              Change nothing; print every write that would happen.
                         (Reads from the cluster and GCP still run.)
  --context NAME         kubectl context (default: the current one).
  --project ID           Refuse to run unless the disks are in this project.
  --namespace NS         Namespace of the host and its PVCs (default: ax-next).
  --workspace-pvc NAME   (default: ax-next-workspace)
  --facts-pvc NAME       (default: ax-next-memory-facts)
  --sql-instance NAME    Cloud SQL instance (default: ax-next-db).

enable only
  --schedule-name NAME   Snapshot schedule name (default: ax-next-daily).
  --retention-days N     Days to keep each snapshot (default: 14).
  --start-time HH:00     UTC start hour (default: 09:00).
  --snapshot-now         Also take one on-demand snapshot of each disk now, so
                         there is a restore point today rather than tomorrow.
                         On-demand snapshots are NOT expired by the schedule.

drill only
  --keep                 Leave the scratch disks, volumes and pod in place.
  --workspace-snapshot NAME   Restore this snapshot instead of the newest.
  --facts-snapshot NAME       Same, for the facts disk.
  --host-deployment NAME Deployment whose image runs the checks (default:
                         ax-next-host).
  --image REF            Run the checks with this image instead.
  --drill-namespace NS   (default: ax-restore-drill)
  --timeout SECONDS      How long to wait for the checks (default: 1200).
USAGE
}

# ── Argument parsing ─────────────────────────────────────────────────────────
need_value() {
  [ "$2" -ge 2 ] || {
    usage >&2
    die "$1 needs a value"
  }
}

parse_args() {
  local var
  if [ "$#" -eq 0 ]; then
    usage >&2
    exit 2
  fi
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    enable | status | drill | drill-cleanup) CMD="$1" ;;
    *)
      usage >&2
      die "unknown command: $1"
      ;;
  esac
  shift
  while [ "$#" -gt 0 ]; do
    var=""
    case "$1" in
      -h | --help)
        usage
        exit 0
        ;;
      --dry-run) DRY_RUN=1 ;;
      --keep) KEEP=1 ;;
      --snapshot-now) SNAPSHOT_NOW=1 ;;
      --context) var=CONTEXT ;;
      --project) var=ASSERT_PROJECT ;;
      --namespace) var=NAMESPACE ;;
      --workspace-pvc) var=WORKSPACE_PVC ;;
      --facts-pvc) var=FACTS_PVC ;;
      --sql-instance) var=SQL_INSTANCE ;;
      --schedule-name) var=SCHEDULE_NAME ;;
      --retention-days) var=RETENTION_DAYS ;;
      --start-time) var=START_TIME ;;
      --host-deployment) var=HOST_DEPLOYMENT ;;
      --image) var=IMAGE ;;
      --drill-namespace) var=DRILL_NAMESPACE ;;
      --timeout) var=DRILL_TIMEOUT ;;
      --workspace-snapshot) var=OPT_workspace_snapshot ;;
      --facts-snapshot) var=OPT_facts_snapshot ;;
      *)
        usage >&2
        die "unknown option: $1"
        ;;
    esac
    if [ -n "$var" ]; then
      need_value "$1" "$#"
      setv "$var" "$2"
      shift
    fi
    shift
  done
}

validate_args() {
  local re
  for v in "$NAMESPACE" "$WORKSPACE_PVC" "$FACTS_PVC" "$HOST_DEPLOYMENT" "$DRILL_NAMESPACE"; do
    re="$K8S_NAME_RE"
    [[ $v =~ $re ]] || die "not a valid Kubernetes name: $v"
  done
  for v in "$SQL_INSTANCE" "$SCHEDULE_NAME"; do
    re="$NAME_RE"
    [[ $v =~ $re ]] || die "not a valid Google Cloud resource name: '$v'"
  done
  for v in "$OPT_workspace_snapshot" "$OPT_facts_snapshot"; do
    [ -n "$v" ] || continue
    re="$NAME_RE"
    [[ $v =~ $re ]] || die "not a valid snapshot name: '$v'"
  done
  re='^([1-9][0-9]{0,2})$'
  [[ $RETENTION_DAYS =~ $re ]] || die "--retention-days must be a whole number of days (1-999), got: $RETENTION_DAYS"
  re='^([01][0-9]|2[0-3]):00$'
  [[ $START_TIME =~ $re ]] || die "--start-time must be on the hour, in UTC, as HH:00 (for example 09:00), got: $START_TIME"
  re='^[1-9][0-9]*$'
  [[ $DRILL_TIMEOUT =~ $re ]] || die "--timeout must be a number of seconds, got: $DRILL_TIMEOUT"
  if [ -n "$IMAGE" ]; then
    re="$IMAGE_RE"
    [[ $IMAGE =~ $re ]] || die "--image does not look like an image reference: $IMAGE"
  fi
  if [ -n "$ASSERT_PROJECT" ]; then
    re="$PROJECT_RE"
    [[ $ASSERT_PROJECT =~ $re ]] || die "--project does not look like a project id: $ASSERT_PROJECT"
  fi
}

# ── Running things ───────────────────────────────────────────────────────────
# KC / GC are argv arrays, not functions, so run_write can print exactly the
# command it runs. GC gets its --project once discovery has said which project.
KC=(kubectl)
GC=(gcloud)

# Show a command the way you could paste it into a shell: plain words as they
# are, anything with spaces or shell-special characters in single quotes.
fmt_cmd() {
  local word out="" plain='^[A-Za-z0-9_./:=@%+,-]+$' quote="'" escaped
  for word in "$@"; do
    if [[ $word =~ $plain ]]; then
      out="$out $word"
    else
      escaped="${word//$quote/$quote\\$quote$quote}"
      out="$out '$escaped'"
    fi
  done
  printf '%s' "${out# }"
}

# Execute one write (or, under --dry-run, only say so). Returns the command's
# own status; run_write is the fatal wrapper, run_soft leaves the decision to
# the caller (cleanup keeps going after one failure).
run_soft() {
  local rc=0
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] would run: $(fmt_cmd "$@")"
    return 0
  fi
  note "\$ $(fmt_cmd "$@")"
  "$@" || rc=$?
  return "$rc"
}
run_write() {
  local rc=0
  run_soft "$@" || rc=$?
  [ "$rc" -eq 0 ] || fail "command failed (exit $rc): $(fmt_cmd "$@")"
}

# Apply the manifest on stdin. Under --dry-run the manifest is printed, so a
# reviewer can read exactly what would be created.
apply_manifest() {
  local what="$1" manifest rc=0
  manifest="$(cat)"
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] would apply $what:"
    printf '%s\n' "$manifest" | sed 's/^/          /'
    return 0
  fi
  note "\$ kubectl apply -f -   # $what"
  printf '%s\n' "$manifest" | "${KC[@]}" apply -f - >/dev/null || rc=$?
  [ "$rc" -eq 0 ] || fail "kubectl apply failed for $what (exit $rc)"
}

now() { date +%s; }
stage_done() { STAGES="${STAGES}$1=$(($(now) - $2));"; }
fmt_dur() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }

is_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    true) return 0 ;;
    *) return 1 ;;
  esac
}

setv() { printf -v "$1" '%s' "$2"; }
getv() { printf '%s' "${!1}"; }

# ── Discovery ────────────────────────────────────────────────────────────────
pvc_for() {
  case "$1" in
    workspace) printf '%s' "$WORKSPACE_PVC" ;;
    facts) printf '%s' "$FACTS_PVC" ;;
  esac
}

# discover <kind>: PVC -> PV -> the Compute Engine disk behind it.
discover() {
  local kind="$1" pvc vol info driver handle rest project zone disk re
  pvc="$(pvc_for "$kind")"
  vol="$("${KC[@]}" -n "$NAMESPACE" get pvc "$pvc" -o 'jsonpath={.spec.volumeName}')" ||
    die "cannot read PVC $NAMESPACE/$pvc on context '$CONTEXT'. Wrong --context or --namespace, or that PVC name is not yours (--${kind}-pvc)?"
  [ -n "$vol" ] || die "PVC $NAMESPACE/$pvc is not bound to a volume yet"
  info="$("${KC[@]}" get pv "$vol" -o 'jsonpath={.spec.csi.driver}|{.spec.csi.volumeHandle}')" ||
    die "cannot read PersistentVolume $vol"
  driver="${info%%|*}"
  handle="${info#*|}"
  [ "$driver" = "pd.csi.storage.gke.io" ] ||
    die "PV $vol is not a GKE persistent disk (CSI driver '${driver:-none}'). This script only knows GKE PD volumes; is context '$CONTEXT' really your GKE cluster?"
  case "$handle" in
    projects/*/zones/*/disks/*) : ;;
    projects/*/regions/*/disks/*)
      die "PV $vol is a REGIONAL disk ($handle). This script handles zonal disks only, which is what the GKE overlay creates."
      ;;
    *) die "PV $vol has a volumeHandle this script does not recognise: $handle" ;;
  esac
  rest="${handle#projects/}"
  project="${rest%%/*}"
  rest="${rest#*/zones/}"
  zone="${rest%%/*}"
  disk="${rest#*/disks/}"
  re="$PROJECT_RE"
  [[ $project =~ $re ]] || die "unexpected project in volumeHandle: $handle"
  re="$ZONE_RE"
  [[ $zone =~ $re ]] || die "unexpected zone in volumeHandle: $handle"
  re="$NAME_RE"
  [[ $disk =~ $re ]] || die "unexpected disk name in volumeHandle: $handle"
  setv "V_${kind}_pv" "$vol"
  setv "V_${kind}_project" "$project"
  setv "V_${kind}_zone" "$zone"
  setv "V_${kind}_disk" "$disk"
}

resolve_context() {
  if [ -z "$CONTEXT" ]; then
    CONTEXT="$(kubectl config current-context 2>/dev/null)" ||
      die "no current kubectl context. Point kubectl at the GKE cluster (deploy/GKE.md Step 0) or pass --context."
  fi
  KC=(kubectl --context "$CONTEXT")
}

# Fill in the V_<kind>_* variables for both disks and pin the project.
discover_all() {
  local kind p size dtype
  resolve_context
  for kind in $KINDS; do discover "$kind"; done
  # shellcheck disable=SC2154 # set by discover() through setv
  PROJECT="$V_workspace_project"
  for kind in $KINDS; do
    p="$(getv "V_${kind}_project")"
    [ "$p" = "$PROJECT" ] ||
      die "the workspace and facts disks are in different projects ($PROJECT and $p). This script assumes one project."
  done
  if [ -n "$ASSERT_PROJECT" ] && [ "$ASSERT_PROJECT" != "$PROJECT" ]; then
    die "you passed --project $ASSERT_PROJECT but the disks behind context '$CONTEXT' live in project $PROJECT. Refusing to touch anything."
  fi
  GC=(gcloud --project "$PROJECT")
  for kind in $KINDS; do
    size="$("${GC[@]}" compute disks describe "$(getv "V_${kind}_disk")" --zone "$(getv "V_${kind}_zone")" --format='value(sizeGb)')" ||
      die "cannot describe disk $(getv "V_${kind}_disk"): check your gcloud login and permissions"
    dtype="$("${GC[@]}" compute disks describe "$(getv "V_${kind}_disk")" --zone "$(getv "V_${kind}_zone")" --format='value(type.basename())')" ||
      die "cannot describe disk $(getv "V_${kind}_disk")"
    setv "V_${kind}_size" "$size"
    setv "V_${kind}_type" "$dtype"
  done
}

kv() { printf '    %-16s: %s\n' "$1" "$2"; }

banner() {
  local account kind mode=""
  account="$(gcloud config get-value account 2>/dev/null || true)"
  if [ "$DRY_RUN" = 1 ]; then mode=" (DRY RUN: nothing will change)"; fi
  step "ax-next backups: ${CMD}${mode}"
  kv "kubectl context" "$CONTEXT"
  kv "namespace" "$NAMESPACE"
  kv "gcloud account" "${account:-unknown}"
  kv "gcloud project" "$PROJECT"
  for kind in $KINDS; do
    kv "$kind disk" "$(getv "V_${kind}_disk")  ($(getv "V_${kind}_zone"), $(getv "V_${kind}_size") GB, $(getv "V_${kind}_type"))  <- PVC $NAMESPACE/$(pvc_for "$kind")"
  done
  kv "Cloud SQL" "$SQL_INSTANCE"
}

region_of() { printf '%s' "${1%-*}"; }

# ── Snapshot schedule ────────────────────────────────────────────────────────
ENSURED_REGIONS=" "

ensure_policy() {
  local region="$1" out err errfile rc=0 got_days got_time
  case "$ENSURED_REGIONS" in *" $region "*) return 0 ;; esac
  ENSURED_REGIONS="$ENSURED_REGIONS$region "
  # stdout and stderr apart: on success gcloud may still add an "update available"
  # notice on stderr, and that must not end up in the values we compare.
  errfile="$(mktemp)"
  out="$("${GC[@]}" compute resource-policies describe "$SCHEDULE_NAME" --region "$region" --format='value(snapshotSchedulePolicy.retentionPolicy.maxRetentionDays,snapshotSchedulePolicy.schedule.dailySchedule.startTime)' 2>"$errfile")" || rc=$?
  err="$(cat "$errfile")"
  rm -f "$errfile"
  if [ "$rc" -eq 0 ]; then
    # Tab-separated: days, then start time.
    got_days="${out%%"$TAB"*}"
    got_time="${out#*"$TAB"}"
    note "schedule $SCHEDULE_NAME already exists in $region (keeps ${got_days:-?} days, daily at ${got_time:-?} UTC): leaving it alone"
    if [ "$got_days" != "$RETENTION_DAYS" ] || [ "$got_time" != "$START_TIME" ]; then
      warn "the existing schedule differs from what was asked for ($RETENTION_DAYS days at $START_TIME UTC). A schedule cannot be edited in place: create one under another --schedule-name, attach it, and delete the old one."
    fi
    return 0
  fi
  case "$err" in
    *"was not found"* | *"not found"*) : ;;
    *) die "could not look up schedule $SCHEDULE_NAME in $region: $err" ;;
  esac
  note "creating schedule $SCHEDULE_NAME in $region: daily at $START_TIME UTC, keep $RETENTION_DAYS days"
  run_write "${GC[@]}" compute resource-policies create snapshot-schedule "$SCHEDULE_NAME" \
    --region "$region" \
    --daily-schedule --start-time "$START_TIME" \
    --max-retention-days "$RETENTION_DAYS" \
    --on-source-disk-delete keep-auto-snapshots \
    --snapshot-labels ax-next-backup=daily \
    --description "ax-next: daily snapshots of the workspace and facts disks (deploy/GKE.md)" \
    --quiet
}

attach_policy() {
  local kind="$1" disk zone attached
  disk="$(getv "V_${kind}_disk")"
  zone="$(getv "V_${kind}_zone")"
  attached="$("${GC[@]}" compute disks describe "$disk" --zone "$zone" --format='value(resourcePolicies)')" ||
    die "cannot read the resource policies of disk $disk"
  case ";$attached;" in
    *"/resourcePolicies/$SCHEDULE_NAME;"*)
      note "$kind disk $disk: $SCHEDULE_NAME already attached"
      ;;
    ";;")
      note "$kind disk $disk: attaching $SCHEDULE_NAME"
      run_write "${GC[@]}" compute disks add-resource-policies "$disk" --zone "$zone" --resource-policies "$SCHEDULE_NAME" --quiet
      ;;
    *)
      # A disk takes at most one snapshot schedule. Someone else's is doing the
      # job (or a person wants it there); replacing it is not ours to decide.
      warn "$kind disk $disk already has a different resource policy ($attached). Not touching it. Check that it is a snapshot schedule you trust: gcloud compute resource-policies describe <name> --region $(region_of "$zone")"
      ;;
  esac
}

snapshot_now() {
  local kind="$1" disk zone snap
  disk="$(getv "V_${kind}_disk")"
  zone="$(getv "V_${kind}_zone")"
  snap="ax-next-${kind}-manual-$(date -u +%Y%m%d-%H%M%S)"
  note "$kind disk $disk: taking an on-demand snapshot $snap"
  run_write "${GC[@]}" compute disks snapshot "$disk" --zone "$zone" --snapshot-names "$snap" --labels ax-next-backup=manual --quiet
}

# ── Cloud SQL ────────────────────────────────────────────────────────────────
sql_get() { "${GC[@]}" sql instances describe "$SQL_INSTANCE" --format="value($1)" 2>/dev/null || true; }

sql_report() {
  local state dp bk pitr start keep avail
  state="$("${GC[@]}" sql instances describe "$SQL_INSTANCE" --format='value(state)')" ||
    die "cannot read Cloud SQL instance $SQL_INSTANCE in project $PROJECT (wrong --sql-instance, or no permission?)"
  dp="$(sql_get settings.deletionProtectionEnabled)"
  bk="$(sql_get settings.backupConfiguration.enabled)"
  pitr="$(sql_get settings.backupConfiguration.pointInTimeRecoveryEnabled)"
  start="$(sql_get settings.backupConfiguration.startTime)"
  keep="$(sql_get settings.backupConfiguration.backupRetentionSettings.retainedBackups)"
  avail="$(sql_get settings.availabilityType)"
  note "Cloud SQL $SQL_INSTANCE: state ${state:-unknown}, availability ${avail:-unknown}"
  if is_true "$dp"; then
    note "  deletion protection : ON"
  else
    note "  deletion protection : OFF"
    SQL_DP_OFF=1
  fi
  if is_true "$bk"; then
    note "  automated backups   : ON (start ${start:-?} UTC, ${keep:-?} kept)"
  else
    problem "Cloud SQL automated backups are OFF. Turn them on: gcloud sql instances patch $SQL_INSTANCE --backup-start-time=HH:MM --project $PROJECT (we have not checked whether that restarts the instance, so pick a quiet hour)."
  fi
  if is_true "$pitr"; then
    note "  point-in-time recov.: ON"
  else
    problem "Cloud SQL point-in-time recovery is OFF, so the worst-case data loss is a full day instead of minutes. Turn it on: gcloud sql instances patch $SQL_INSTANCE --enable-point-in-time-recovery --project $PROJECT (we have not checked whether that restarts the instance, so pick a quiet hour)."
  fi
}

sql_enable() {
  SQL_DP_OFF=0
  sql_report
  if [ "$SQL_DP_OFF" = 1 ]; then
    run_write "${GC[@]}" sql instances patch "$SQL_INSTANCE" --deletion-protection --quiet
    if [ "$DRY_RUN" != 1 ]; then
      is_true "$(sql_get settings.deletionProtectionEnabled)" ||
        fail "asked Cloud SQL to turn deletion protection on, but it still reads back as off"
      note "  deletion protection : now ON"
    fi
  fi
}

# ── enable ───────────────────────────────────────────────────────────────────
cmd_enable() {
  local kind
  discover_all
  banner
  kv "schedule" "$SCHEDULE_NAME (daily at $START_TIME UTC, keep $RETENTION_DAYS days)"

  step "Snapshot schedule"
  for kind in $KINDS; do ensure_policy "$(region_of "$(getv "V_${kind}_zone")")"; done
  for kind in $KINDS; do attach_policy "$kind"; done
  if [ "$SNAPSHOT_NOW" = 1 ]; then
    step "On-demand snapshots (--snapshot-now)"
    for kind in $KINDS; do snapshot_now "$kind"; done
    note "These are outside the schedule's retention and will not expire on their own."
    note "Delete them once you no longer need them: gcloud compute snapshots delete <name> --project $PROJECT"
  fi

  step "Cloud SQL"
  PROBLEMS=0
  sql_enable

  if [ "$DRY_RUN" = 1 ]; then
    step "Dry run finished: nothing was changed."
    [ "$PROBLEMS" -eq 0 ] || exit 1
    return 0
  fi
  step "Done"
  note "The first scheduled snapshot lands at the next $START_TIME UTC (up to a day from now)."
  note "Check on it with: bash deploy/gke/backups.sh status"
  [ "$PROBLEMS" -eq 0 ] || exit 1
}

# ── status ───────────────────────────────────────────────────────────────────
# Newest READY snapshot of a disk (exact source-disk match), or nothing.
# Output: "<name><TAB><creationTimestamp>".
latest_snapshot() {
  local disk="$1" out n t d
  out="$("${GC[@]}" compute snapshots list --filter="sourceDisk:${disk} AND status=READY" --sort-by=~creationTimestamp --format='value(name,creationTimestamp,sourceDisk.basename())')" ||
    die "cannot list snapshots in project $PROJECT"
  while IFS="$TAB" read -r n t d; do
    if [ "$d" = "$disk" ]; then
      printf '%s\t%s' "$n" "$t"
      return 0
    fi
  done <<<"$out"
  return 0
}

has_fresh_snapshot() {
  local disk="$1" out n t d
  out="$("${GC[@]}" compute snapshots list --filter="sourceDisk:${disk} AND status=READY AND creationTimestamp>-${STALE_AFTER}" --format='value(name,creationTimestamp,sourceDisk.basename())')" ||
    die "cannot list snapshots in project $PROJECT"
  while IFS="$TAB" read -r n t d; do
    [ "$d" = "$disk" ] && return 0
  done <<<"$out"
  return 1
}

cmd_status() {
  local kind disk zone attached latest recent_policy
  discover_all
  banner
  step "Snapshots"
  for kind in $KINDS; do
    disk="$(getv "V_${kind}_disk")"
    zone="$(getv "V_${kind}_zone")"
    attached="$("${GC[@]}" compute disks describe "$disk" --zone "$zone" --format='value(resourcePolicies)')" ||
      die "cannot read the resource policies of disk $disk"
    if [ -z "$attached" ]; then
      problem "$kind disk $disk has NO snapshot schedule attached. Run: bash deploy/gke/backups.sh enable"
      continue
    fi
    case ";$attached;" in
      *"/resourcePolicies/$SCHEDULE_NAME;"*) note "$kind disk $disk: schedule $SCHEDULE_NAME attached" ;;
      *) note "$kind disk $disk: has a different schedule attached ($attached); not ours, but it counts if it is producing snapshots" ;;
    esac
    latest="$(latest_snapshot "$disk")"
    if [ -z "$latest" ]; then
      recent_policy="$("${GC[@]}" compute resource-policies list --filter="name=${SCHEDULE_NAME} AND creationTimestamp>-PT26H" --format='value(name)')" || recent_policy=""
      if [ -n "$recent_policy" ]; then
        note "  no snapshot yet: the schedule is less than a day old, so the first one is still due at $START_TIME UTC"
      else
        problem "$kind disk $disk has a schedule but no snapshot at all. It should have produced one by now: look at the schedule in the Compute Engine console."
      fi
    elif has_fresh_snapshot "$disk"; then
      note "  newest snapshot: ${latest%%"$TAB"*} taken ${latest#*"$TAB"}"
    else
      problem "$kind disk $disk: the newest snapshot (${latest%%"$TAB"*}, ${latest#*"$TAB"}) is older than 36 hours, so the schedule has stopped producing them."
    fi
  done
  step "Cloud SQL"
  SQL_DP_OFF=0
  sql_report
  if [ "$SQL_DP_OFF" = 1 ]; then
    problem "Cloud SQL deletion protection is OFF. Run: bash deploy/gke/backups.sh enable"
  fi
  if [ "$PROBLEMS" -eq 0 ]; then
    step "Healthy"
    return 0
  fi
  step "$PROBLEMS problem(s) found"
  exit 1
}

# ── drill ────────────────────────────────────────────────────────────────────
resolve_image() {
  if [ -z "$IMAGE" ]; then
    IMAGE="$("${KC[@]}" -n "$NAMESPACE" get deployment "$HOST_DEPLOYMENT" -o 'jsonpath={.spec.template.spec.containers[0].image}')" ||
      die "cannot read deployment $NAMESPACE/$HOST_DEPLOYMENT to find the image to run the checks with (pass --image or --host-deployment)"
    local re="$IMAGE_RE"
    [[ $IMAGE =~ $re ]] || die "the image on $HOST_DEPLOYMENT does not look like an image reference: '$IMAGE'"
  fi
}

pick_snapshot() {
  local kind="$1" latest chosen info n t st src disk
  disk="$(getv "V_${kind}_disk")"
  chosen="$(getv "OPT_${kind}_snapshot")"
  if [ -n "$chosen" ]; then
    # A snapshot the operator named. It only ever feeds a SCRATCH disk, so the
    # worst a wrong one can do is waste a drill, but say so if it looks wrong.
    info="$("${GC[@]}" compute snapshots describe "$chosen" --format='value(name,creationTimestamp,status,sourceDisk.basename())')" ||
      die "cannot find snapshot '$chosen' in project $PROJECT"
    IFS="$TAB" read -r n t st src <<<"$info"
    [ "$st" = READY ] || die "snapshot '$chosen' is $st, not READY: it cannot be restored yet"
    if [ "$src" != "$disk" ]; then
      warn "snapshot '$chosen' was taken of disk '$src', not of the current $kind disk '$disk'. That is expected if the claim was re-created since; if not, you have named the wrong snapshot."
    fi
    setv "V_${kind}_snap" "$chosen"
    setv "V_${kind}_snap_at" "$t"
    return 0
  fi
  latest="$(latest_snapshot "$disk")"
  [ -n "$latest" ] ||
    die "no READY snapshot of the $kind disk exists yet, so there is nothing to restore. Run 'enable --snapshot-now', or wait for the first scheduled snapshot ($START_TIME UTC)."
  setv "V_${kind}_snap" "${latest%%"$TAB"*}"
  setv "V_${kind}_snap_at" "${latest#*"$TAB"}"
}

scratch_disk() { printf 'ax-restore-drill-%s-%s' "$1" "$RUN_ID"; }
scratch_pv() { printf 'ax-restore-drill-%s-%s' "$1" "$RUN_ID"; }
scratch_pvc() { printf 'ax-restore-drill-%s' "$1"; }

manifest_namespace() {
  cat <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${DRILL_NAMESPACE}
  labels:
    ax-restore-drill-home: "true"
EOF
}

manifest_configmap() {
  cat <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: ax-restore-drill-verify
  namespace: ${DRILL_NAMESPACE}
  labels:
    ax-restore-drill: "${RUN_ID}"
data:
  verify.sh: |
EOF
  sed 's/^/    /' "$VERIFY_SCRIPT"
}

manifest_pv() {
  local kind="$1" size zone
  size="$(getv "V_${kind}_size")"
  zone="$(getv "V_${kind}_zone")"
  cat <<EOF
apiVersion: v1
kind: PersistentVolume
metadata:
  name: $(scratch_pv "$kind")
  labels:
    ax-restore-drill: "${RUN_ID}"
spec:
  capacity:
    storage: ${size}Gi
  accessModes: ["ReadWriteOnce"]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""
  claimRef:
    namespace: ${DRILL_NAMESPACE}
    name: $(scratch_pvc "$kind")
  csi:
    driver: pd.csi.storage.gke.io
    volumeHandle: projects/${PROJECT}/zones/${zone}/disks/$(scratch_disk "$kind")
    fsType: ext4
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: topology.gke.io/zone
              operator: In
              values: ["${zone}"]
EOF
}

manifest_pvc() {
  local kind="$1" size
  size="$(getv "V_${kind}_size")"
  cat <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $(scratch_pvc "$kind")
  namespace: ${DRILL_NAMESPACE}
  labels:
    ax-restore-drill: "${RUN_ID}"
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: ""
  volumeName: $(scratch_pv "$kind")
  resources:
    requests:
      storage: ${size}Gi
EOF
}

manifest_pod() {
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ax-restore-drill
  namespace: ${DRILL_NAMESPACE}
  labels:
    ax-restore-drill: "${RUN_ID}"
spec:
  restartPolicy: Never
  activeDeadlineSeconds: 3600
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    fsGroupChangePolicy: OnRootMismatch
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: verify
      image: ${IMAGE}
      command: ["sh", "/drill/verify.sh", "/restored/workspace", "/restored/facts"]
      env:
        - name: HOME
          value: /tmp
        - name: TMPDIR
          value: /tmp
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      resources:
        requests:
          cpu: 250m
          memory: 512Mi
        limits:
          memory: 1Gi
      volumeMounts:
        - { name: verify-script, mountPath: /drill, readOnly: true }
        - { name: tmp, mountPath: /tmp }
        - { name: workspace, mountPath: /restored/workspace }
        - { name: facts, mountPath: /restored/facts }
  volumes:
    - name: verify-script
      configMap:
        name: ax-restore-drill-verify
        defaultMode: 0555
    - name: tmp
      emptyDir: {}
    - name: workspace
      persistentVolumeClaim:
        claimName: $(scratch_pvc workspace)
    - name: facts
      persistentVolumeClaim:
        claimName: $(scratch_pvc facts)
EOF
}

wait_for_pod() {
  local deadline phase
  deadline=$(($(now) + DRILL_TIMEOUT))
  while :; do
    phase="$("${KC[@]}" -n "$DRILL_NAMESPACE" get pod ax-restore-drill -o 'jsonpath={.status.phase}' 2>/dev/null || true)"
    case "$phase" in
      Succeeded | Failed) return 0 ;;
    esac
    [ "$(now)" -lt "$deadline" ] || return 1
    sleep "$POLL_SECONDS"
  done
}

fetch_logs() {
  local out
  # Log streaming can be briefly unavailable right after a node spins up
  # (deploy/GKE.md Troubleshooting), so retry before giving up.
  for _ in 1 2 3 4 5 6; do
    if out="$("${KC[@]}" -n "$DRILL_NAMESPACE" logs ax-restore-drill 2>&1)"; then
      printf '%s\n' "$out"
      return 0
    fi
    sleep "$POLL_SECONDS"
  done
  printf '%s\n' "$out"
  return 1
}

# Delete the drill's objects: the pod and claims first, then the volumes, then
# (once the disks have detached) the scratch disks. <which> is a run id, or
# `all` for every leftover. Only ever selects by our own label.
cleanup_drill() {
  local which="$1" sel rc=0 out name zone rid i users
  if [ "$which" = all ]; then sel="ax-restore-drill"; else sel="ax-restore-drill=$which"; fi
  step "Cleaning up drill leftovers ($which)"
  run_soft "${KC[@]}" -n "$DRILL_NAMESPACE" delete pod,pvc,configmap -l "$sel" --ignore-not-found --wait=true || rc=1
  run_soft "${KC[@]}" delete pv -l "$sel" --ignore-not-found --wait=true || rc=1
  out="$("${GC[@]}" compute disks list --filter='labels.ax_restore_drill:*' --format='value(name,zone.basename(),labels.ax_restore_drill)' 2>&1)" || {
    warn "could not list scratch disks: $out"
    return 1
  }
  while IFS="$TAB" read -r name zone rid; do
    [ -n "$name" ] || continue
    case "$name" in ax-restore-drill-*) : ;; *) continue ;; esac
    if [ "$which" != all ] && [ "$rid" != "$which" ]; then continue; fi
    if [ "$DRY_RUN" != 1 ]; then
      # A disk cannot be deleted while a node still has it attached.
      for i in $(seq 1 60); do
        users="$("${GC[@]}" compute disks describe "$name" --zone "$zone" --format='value(users)' 2>/dev/null || true)"
        [ -z "$users" ] && break
        [ "$i" -lt 60 ] || warn "disk $name still shows as attached after waiting; trying to delete it anyway"
        sleep "$POLL_SECONDS"
      done
    fi
    run_soft "${GC[@]}" compute disks delete "$name" --zone "$zone" --quiet || rc=1
  done <<<"$out"
  return "$rc"
}

DRILL_ACTIVE=0
on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$DRILL_ACTIVE" = 1 ]; then
    if [ "$KEEP" = 1 ]; then
      step "--keep: leaving the drill in place"
      note "namespace $DRILL_NAMESPACE, pod ax-restore-drill, disks named $(scratch_disk workspace) and $(scratch_disk facts)"
      note "Remove it with: bash deploy/gke/backups.sh drill-cleanup --context $CONTEXT"
    elif ! cleanup_drill "$RUN_ID"; then
      warn "cleanup did not finish. Scratch disks cost money. Run: bash deploy/gke/backups.sh drill-cleanup --context $CONTEXT"
      [ "$rc" -ne 0 ] || rc=1
    fi
  fi
  exit "$rc"
}

cmd_drill() {
  local kind t0 t_disks result logs phase
  RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
  discover_all
  resolve_image
  banner
  kv "checks run with" "$IMAGE"

  step "Snapshots to restore"
  for kind in $KINDS; do
    pick_snapshot "$kind"
    note "$kind: $(getv "V_${kind}_snap")  (taken $(getv "V_${kind}_snap_at"))"
  done

  if [ "$DRY_RUN" != 1 ]; then
    trap on_exit EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    DRILL_ACTIVE=1
  fi
  t0="$(now)"

  step "Restoring the snapshots to scratch disks"
  for kind in $KINDS; do
    run_write "${GC[@]}" compute disks create "$(scratch_disk "$kind")" \
      --zone "$(getv "V_${kind}_zone")" \
      --source-snapshot "$(getv "V_${kind}_snap")" \
      --type "$(getv "V_${kind}_type")" \
      --labels "ax_restore_drill=${RUN_ID}" \
      --quiet
  done
  t_disks="$(now)"
  stage_done "restore snapshots to disks" "$t0"

  step "Mounting them in a throwaway pod ($DRILL_NAMESPACE/ax-restore-drill)"
  if "${KC[@]}" get namespace "$DRILL_NAMESPACE" >/dev/null 2>&1; then
    note "namespace $DRILL_NAMESPACE already exists: using it as it is"
  else
    manifest_namespace | apply_manifest "namespace $DRILL_NAMESPACE"
  fi
  manifest_configmap | apply_manifest "the check script"
  for kind in $KINDS; do
    manifest_pv "$kind" | apply_manifest "volume for the restored $kind disk"
    manifest_pvc "$kind" | apply_manifest "claim for the restored $kind disk"
  done
  manifest_pod | apply_manifest "the checking pod"

  if [ "$DRY_RUN" = 1 ]; then
    step "Dry run finished: nothing was changed."
    note "A real run would now wait up to ${DRILL_TIMEOUT}s for the pod, print its report, and delete everything above."
    return 0
  fi

  step "Waiting for the pod to run the checks (up to ${DRILL_TIMEOUT}s)"
  result=FAIL
  if wait_for_pod; then
    stage_done "attach disks and run checks" "$t_disks"
    phase="$("${KC[@]}" -n "$DRILL_NAMESPACE" get pod ax-restore-drill -o 'jsonpath={.status.phase}' 2>/dev/null || true)"
    logs="$(fetch_logs)" || warn "could not read the pod's logs after several tries"
    printf '%s\n' "$logs" | sed 's/^/    | /'
    if [ "$phase" = Succeeded ] && grep -q '^DRILL-RESULT: PASS$' <<<"$logs"; then
      result=PASS
    fi
  else
    stage_done "attach disks and run checks (timed out)" "$t_disks"
    warn "the pod did not finish within ${DRILL_TIMEOUT}s. What Kubernetes says about it:"
    "${KC[@]}" -n "$DRILL_NAMESPACE" describe pod ax-restore-drill 2>&1 | tail -30 | sed 's/^/    | /' || true
  fi

  # Clean up now (not only in the exit trap) so the timing below includes it.
  local t_clean
  t_clean="$(now)"
  if [ "$KEEP" != 1 ]; then
    if cleanup_drill "$RUN_ID"; then DRILL_ACTIVE=0; else warn "cleanup did not finish; the exit handler will say what to run"; fi
    stage_done "cleanup" "$t_clean"
  fi

  step "Restore drill: $result"
  for kind in $KINDS; do
    note "$kind: restored $(getv "V_${kind}_snap") (taken $(getv "V_${kind}_snap_at"))"
  done
  local entry
  local IFS=';'
  for entry in $STAGES; do
    [ -n "$entry" ] || continue
    note "$(printf '%-44s %s' "${entry%%=*}" "$(fmt_dur "${entry#*=}")")"
  done
  note "$(printf '%-44s %s' "total" "$(fmt_dur $(($(now) - t0)))")"
  note "Record these numbers in the drill log in deploy/GKE.md."
  [ "$result" = PASS ] || exit 1
}

cmd_drill_cleanup() {
  discover_all
  banner
  cleanup_drill all || fail "cleanup did not finish"
  if [ "$DRY_RUN" = 1 ]; then step "Dry run finished: nothing was changed."; else step "Done"; fi
}

# ── main ─────────────────────────────────────────────────────────────────────
parse_args "$@"
validate_args
case "$CMD" in
  enable) cmd_enable ;;
  status) cmd_status ;;
  drill) cmd_drill ;;
  drill-cleanup) cmd_drill_cleanup ;;
esac
