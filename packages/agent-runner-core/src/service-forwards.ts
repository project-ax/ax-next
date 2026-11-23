import * as realNet from 'node:net';

const LOOPBACK = '127.0.0.1';

export interface ServiceForwards {
  close(): Promise<void>;
}

/**
 * Loopback forwards for published service ports. Services are sidecars sharing
 * the pod's network namespace; compose's `"47017:27017"` means a test config
 * says `localhost:47017` while the service listens on 27017. Each pair listens
 * on 127.0.0.1:<published> and pipes to 127.0.0.1:<target>.
 *
 * Boundary: bind and connect are both 127.0.0.1, never a caller-supplied host.
 * A bind failure logs and skips that port (the runner must keep booting). Both
 * sockets of a pipe are destroyed when either errors or closes, so nothing is
 * left half-open, and `close()` destroys every live socket and releases the
 * ports.
 */
export async function startServiceForwards(
  map: ReadonlyArray<{ published: number; target: number }>,
  deps: { net?: typeof realNet } = {},
): Promise<ServiceForwards> {
  const net = deps.net ?? realNet;
  const servers: realNet.Server[] = [];
  const live = new Set<realNet.Socket>();

  const track = (s: realNet.Socket): void => {
    live.add(s);
    s.once('close', () => live.delete(s));
  };

  await Promise.all(
    map.map(
      ({ published, target }) =>
        new Promise<void>((resolve) => {
          const server = net.createServer((client) => {
            const upstream = net.connect({ host: LOOPBACK, port: target });
            track(client);
            track(upstream);
            const teardown = (): void => {
              client.destroy();
              upstream.destroy();
            };
            client.on('error', teardown);
            upstream.on('error', teardown);
            client.on('close', teardown);
            upstream.on('close', teardown);
            client.pipe(upstream);
            upstream.pipe(client);
          });
          server.once('error', (err: NodeJS.ErrnoException) => {
            process.stderr.write(
              `runner: service forward ${LOOPBACK}:${published} -> ${target} skipped: ${err.code ?? err.message}\n`,
            );
            resolve();
          });
          server.listen({ host: LOOPBACK, port: published }, () => {
            // After a successful bind, a later server error must not crash.
            server.removeAllListeners('error');
            server.on('error', () => {});
            servers.push(server);
            resolve();
          });
        }),
    ),
  );

  return {
    async close(): Promise<void> {
      for (const s of [...live]) s.destroy();
      await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    },
  };
}
