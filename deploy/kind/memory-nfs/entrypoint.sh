#!/bin/sh
# NFSv4-only kernel server for kind — dev only. See Dockerfile.
#
# `/exports` is the NFSv4 pseudo-root (fsid=0), and clients mount two things
# beneath it:
#   <server>:/memory  facts memory's per-agent projection, on the pod's
#                     emptyDir. The host rewrites it, so a restart loses nothing.
#   <server>:/files   every agent's durable home (`sandbox.filestore`), on the
#                     ax-next-files-nfs PVC mounted at /exports/files, so it
#                     survives NFS-pod restarts.
# `no_root_squash` mirrors the managed export the chart expects in production:
# the runner pod-spec chowns each per-agent subPath to uid 1000 as root, and
# that chown needs root to survive the wire.
set -eu

EXPORT_ROOT=/exports
MEMORY_DIR="$EXPORT_ROOT/memory"
FILES_DIR="$EXPORT_ROOT/files"

# Succeeds when $1 is a mount point. This reads the kernel's mount table on
# purpose. busybox's `mountpoint` compares device numbers with the parent
# directory, and on kind the PVC and the emptyDir come from the same node
# filesystem, so it would call a correctly mounted PVC a plain directory.
is_mounted() {
  awk -v p="$1" '$5 == p { found = 1 } END { exit !found }' /proc/self/mountinfo
}

# Agent homes are the one thing on this server worth keeping. Without the PVC
# (say, an older nfs-server.yaml was applied), /exports/files would be a plain
# directory on the emptyDir, and every agent's files would vanish with the pod.
# Refuse instead, before anything is exported.
if ! is_mounted "$FILES_DIR"; then
  echo "memory-nfs: $FILES_DIR is not a mounted volume; refusing to serve agent homes from scratch space (apply nfs-server.yaml, which mounts the ax-next-files-nfs PVC there)" >&2
  exit 1
fi

mkdir -p "$MEMORY_DIR"
# The host pod writes the memory export as uid/gid 1000.
chown 1000:1000 "$MEMORY_DIR"

# The top of the files export stays root-owned, 0755. kubelet creates each
# agent's subPath directory as root (copying this mode), and the runner pod's
# chown init container then hands that one directory to uid 1000.
chown 0:0 "$FILES_DIR"
chmod 0755 "$FILES_DIR"

mountpoint -q /proc/fs/nfsd || mount -t nfsd nfsd /proc/fs/nfsd

# Who may mount: the NODE only, never a pod. kubelet mounts `nfs:` volumes
# from the node, and on the pod network the node shows up as this pod's
# default gateway (the bridge address, e.g. 10.244.0.1). A pod talking NFS
# directly arrives from its own pod IP instead — refused. Without this, any
# runner could skip its own mounts and read or write every agent's export by
# speaking NFS to the Service, since kind runs without NetworkPolicy.
NODE_ADDR=$(ip route | awk '/^default/ {print $3; exit}')
if [ -z "$NODE_ADDR" ]; then
  echo "memory-nfs: no default route; cannot tell which address is the node" >&2
  exit 1
fi

# Both exports go to the node only. The fsids are explicit because on kind
# both directories live on one node filesystem, so its device number or UUID
# cannot tell the two exports apart. `crossmnt` lets an NFSv4 client walk from
# the pseudo-root into the PVC mounted beneath it.
{
  echo "$EXPORT_ROOT $NODE_ADDR(rw,fsid=0,crossmnt,sync,no_subtree_check,no_root_squash,insecure)"
  echo "$FILES_DIR $NODE_ADDR(rw,fsid=1,sync,no_subtree_check,no_root_squash,insecure)"
} > /etc/exports

shutdown() {
  echo "memory-nfs: stopping"
  rpc.nfsd 0 || true
  exportfs -ua || true
  kill "$MOUNTD_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

rpcbind -w
exportfs -ra
# v4 only: no v3 (v2 is not even built into modern kernels — asking to
# disable it is an error), so no statd/lockd and a single port (2049).
rpc.nfsd -N 3 8
rpc.mountd -N 3 -F &
MOUNTD_PID=$!

echo "memory-nfs: serving $EXPORT_ROOT and $FILES_DIR to $NODE_ADDR only (clients mount <server>:/memory and <server>:/files)"
exportfs -v

wait "$MOUNTD_PID"
