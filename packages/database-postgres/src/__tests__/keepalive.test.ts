import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import net from 'node:net';
import { sql, type Kysely } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// TASK-1061: TCP keepalive on the pooled connection.
//
// pg never calls net.Socket#setKeepAlive by default, so a peer that vanishes
// without closing the connection (a node dies, a NAT forgets the mapping) is
// never noticed on a quiet socket. The spy records the remote port AT CALL
// TIME: pg calls setKeepAlive on 'connect', and Node computes remotePort on
// demand, so it reads undefined once the socket has closed. Only calls to the
// test container count; other sockets in the process may call setKeepAlive too.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close({ onError: () => {} });
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('TCP keepalive', () => {
  it('is on for the pooled connection, first probe after 10 s', async () => {
    const seen: Array<[number | undefined, boolean, number | undefined]> = [];
    const original = net.Socket.prototype.setKeepAlive;
    const spy = vi
      .spyOn(net.Socket.prototype, 'setKeepAlive')
      .mockImplementation(function (this: net.Socket, ...args: Parameters<typeof original>) {
        seen.push([this.remotePort, Boolean(args[0]), args[1]]);
        return original.apply(this, args);
      });
    try {
      const h = await createTestHarness({
        plugins: [createDatabasePostgresPlugin({ connectionString })],
      });
      harnesses.push(h);
      const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        h.ctx(),
        {},
      );
      await sql`SELECT 1`.execute(db);
    } finally {
      spy.mockRestore();
    }
    const calls = seen
      .filter(([remotePort]) => remotePort === container.getPort())
      .map(([, enable, delay]) => [enable, delay]);
    expect(calls).toStrictEqual([[true, 10_000]]);
  });
});
