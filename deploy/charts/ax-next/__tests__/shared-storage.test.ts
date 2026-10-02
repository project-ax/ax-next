import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const chart = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = ['template', 'ax-test', chart, '--namespace', 'host', '--kube-version', '1.36.4-gke.1247000',
  '--set', 'credentials.key=test', '--set', 'http.cookieKey=' + '0'.repeat(64),
  '--set', 'sandbox.backend=agent-sandbox', '--set', 'credentialProxy.tcp.enabled=true',
  '--set', 'sandbox.sharedPool.enabled=true', '--set', 'sandbox.filestore.server=10.0.0.9',
  '--set', 'sandbox.sharedPool.clientTlsSecret=controller-tls', '--set', 'sandbox.sharedPool.serverTlsSecret=storage-tls'];
type Port = { port: number; protocol: string };
type Volume = { name: string; hostPath?: { path: string }; secret?: { secretName: string } };
type Container = { securityContext: object; args: string[]; volumeMounts: object[]; env: object[] };
type Doc = { kind: string; metadata: { name: string; namespace?: string }; spec: {
  template: { spec: { hostNetwork: boolean; hostPID: boolean; runtimeClassName?: string; containers: Container[]; volumes: Volume[] } };
  ingress: { from: { namespaceSelector: { matchLabels: Record<string, string> } }[]; ports: Port[] }[];
  egress: { ports: Port[] }[];
  podSelector: { matchExpressions?: { key: string; operator: string }[] };
}; rules?: { apiGroups: string[]; resources: string[]; verbs: string[] }[] };
const render = (extra: string[] = []): Doc[] => loadAll(execFileSync('helm', [...base, ...extra],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 })).filter(Boolean) as Doc[];
describe('shared storage deployment', () => {
  it('confines privileged filesystem access to a dedicated node helper', () => {
    const docs = render(); const daemon = docs.find(d => d.kind === 'DaemonSet')!;
    expect(daemon.metadata.namespace).toBe('ax-sandbox-system');
    const pod = daemon.spec.template.spec;
    expect(pod.hostNetwork).toBe(false); expect(pod.hostPID).toBe(false); expect(pod.runtimeClassName).toBeUndefined();
    expect(pod.containers[0].securityContext).toEqual({ privileged: true, runAsUser: 0, readOnlyRootFilesystem: true });
    expect(pod.containers[0].args).toEqual(['flock', '--no-fork', '/ledger/daemon.lock', 'node', '/opt/ax-next/storage-node.mjs']);
    expect(pod.volumes.filter(v => v.hostPath).map(v => v.hostPath!.path)).toEqual([
      '/var/lib/kubelet/pods', '/var/lib/ax-shared-storage/ax-shared',
    ]);
    expect(pod.volumes.find(v => v.name === 'tls')!.secret!.secretName).toBe('storage-tls');
    const host = docs.find(d => d.kind === 'Deployment' && d.metadata.name.endsWith('-host'))!.spec.template.spec;
    expect(host.containers[0].volumeMounts).toContainEqual({ name: 'storage-client-tls', mountPath: '/var/run/ax-storage-tls', readOnly: true });
    expect(host.volumes.find(v => v.name === 'storage-client-tls')!.secret!.secretName).toBe('controller-tls');
    expect(host.containers[0].env).toContainEqual({ name: 'K8S_SHARED_POOL_REPLICAS', value: '1' });
  });
  it('grants no secret-read, exec, cluster, or host pod patch capabilities', () => {
    const docs = render(); expect(docs.filter(d => d.kind === 'ClusterRole')).toHaveLength(0);
    for (const role of docs.filter(d => d.kind === 'Role')) {
      for (const rule of role.rules!) expect(rule.resources).not.toEqual(expect.arrayContaining(['secrets', 'pods/exec', '*']));
    }
    const hostRole = docs.find(d => d.kind === 'Role' && d.metadata.name.endsWith('runner-manager'))!;
    expect(hostRole.rules!.flatMap(r => r.verbs)).not.toContain('patch');
    expect(hostRole.rules!.find(r => r.resources.includes('sandboxclaims'))!.verbs).toEqual(['create', 'get', 'list', 'delete']);
    const discovery = docs.find(d => d.kind === 'Role' && d.metadata.name.endsWith('storage-discovery'))!;
    expect(discovery.rules).toEqual([{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }]);
  });
  it.each([
    ['sandbox.backend=pod', 'v1beta1 Agent Sandbox'],
    ['sandbox.sharedPool.clientTlsSecret=', 'TLS Secrets'],
    ['sandbox.sharedPool.storageNamespace=host', 'administrator namespace'],
    ['sandbox.sharedPool.replicas=0', 'greater than or equal to 1'],
    ['sandbox.filestore.mountPath=/workspace', 'Filestore at /files'],
  ])('rejects %s', (value, message) => {
    const result = spawnSync('helm', [...base, '--set', value], { encoding: 'utf8' });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain(message);
  });
  it('rejects clusters missing force-shared emptyDir support', () => {
    const result = spawnSync('helm', [...base, '--kube-version', '1.35.9'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('1.36.0-gke.3302001');
  });
  it('gives storage ingress only to the host and grants runners no helper API access', () => {
    const docs = render(); const policy = docs.find(d => d.kind === 'NetworkPolicy' && d.metadata.name.endsWith('-storage'))!;
    expect(policy.spec.ingress).toHaveLength(1);
    expect(policy.spec.ingress[0]!.from[0]!.namespaceSelector.matchLabels['kubernetes.io/metadata.name']).toBe('host');
    expect(policy.spec.ingress[0]!.ports).toEqual([{ port: 9443, protocol: 'TCP' }]);
    const runners = docs.find(d => d.kind === 'NetworkPolicy' && d.metadata.name.endsWith('sandbox-restrict'))!;
    expect(runners.spec.egress.flatMap(r => r.ports).map(p => p.port)).not.toContain(9443);
    expect(runners.spec.egress.flatMap(r => r.ports).map(p => p.port)).not.toContain(2049);
    const cold = docs.find(d => d.kind === 'NetworkPolicy' && d.metadata.name.endsWith('cold-nfs'))!;
    expect(cold.spec.podSelector.matchExpressions).toEqual([{ key: 'ax.io/shared-standby', operator: 'DoesNotExist' }]);
  });
});
