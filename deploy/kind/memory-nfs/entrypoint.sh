#!/bin/sh
# NFSv4-only kernel server for the kind memory walk. See Dockerfile.
#
# One export, `/exports` as the NFSv4 pseudo-root (fsid=0), so clients mount
# `<server>:/memory`. `no_root_squash` mirrors the managed export the chart
# expects in production: the runner pod-spec chowns each per-agent subPath to
# uid 1000 as root, and that chown needs root to survive the wire.
set -eu

EXPORT_ROOT=/exports
MEMORY_DIR="$EXPORT_ROOT/memory"

mkdir -p "$MEMORY_DIR"
# The host pod writes the export as uid/gid 1000.
chown 1000:1000 "$MEMORY_DIR"

mountpoint -q /proc/fs/nfsd || mount -t nfsd nfsd /proc/fs/nfsd

# Who may mount: the NODE only, never a pod. kubelet mounts `nfs:` volumes
# from the node, and on the pod network the node shows up as this pod's
# default gateway (the bridge address, e.g. 10.244.0.1). A pod talking NFS
# directly arrives from its own pod IP instead — refused. Without this, any
# runner could skip its read-only mount and write every agent's export by
# speaking NFS to the Service, since kind runs without NetworkPolicy.
NODE_ADDR=$(ip route | awk '/^default/ {print $3; exit}')
if [ -z "$NODE_ADDR" ]; then
  echo "memory-nfs: no default route; cannot tell which address is the node" >&2
  exit 1
fi

echo "$EXPORT_ROOT $NODE_ADDR(rw,fsid=0,sync,no_subtree_check,no_root_squash,insecure)" > /etc/exports

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

echo "memory-nfs: serving $EXPORT_ROOT to $NODE_ADDR only (clients mount <server>:/memory)"
exportfs -v

wait "$MOUNTD_PID"
