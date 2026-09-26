# A throwaway NFSv4 server for the kind cluster — dev only, never production.
#
# The memory preset (`host.preset=memory`) mounts its export tier as an `nfs:`
# volume, and on GKE that's a Filestore share. kind has no Filestore, so this
# image stands in for it: the kernel's own nfsd (OrbStack / Docker Desktop VMs
# build it in), driven by Alpine's nfs-utils. Nothing here is pulled at run
# time — `apk add` happens at build, and the base is pinned by digest because
# we have trust issues.
#
# Build + load:  see deploy/kind/memory-nfs/README.md
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

# Exact version, so a rebuild cannot silently pick up a different package.
# Bump deliberately when the base digest moves.
RUN apk add --no-cache nfs-utils=2.6.4-r1

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

EXPOSE 2049/tcp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
