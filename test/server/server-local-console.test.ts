import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import COM from '../../source/engine/common/Com.ts';
import Cmd, { ConsoleCommand } from '../../source/engine/common/Cmd.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import type { ConsoleOutput } from '../../source/engine/common/Services.ts';
import type Server from '../../source/engine/server/Server.ts';
import type ServerHost from '../../source/engine/server/ServerHost.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';
import ServerLocalConsole from '../../source/engine/server/ServerLocalConsole.ts';
import { QSocket } from '../../source/engine/network/NetworkDrivers.ts';
import { withMockEngine } from '../support/fixtures.ts';

/**
 * @param address address of the connection
 * @param [state] state of the client
 * @returns a client connected from that address
 */
function createClient(address: string, state: number = ServerClient.STATE.SPAWNED): ServerClient {
  // Only the state and the address of the connection are looked at.
  return { state, netconnection: { address, state: QSocket.STATE_CONNECTED } } as unknown as ServerClient;
}

/**
 * @param clients the clients of the server
 * @returns the local console and what it works on
 */
function createConsole(clients: ServerClient[]): { console: ServerLocalConsole, serverHost: { getLocalOperatorName: () => string }, prints: string[] } {
  const prints: string[] = [];
  const serverHost = { getLocalOperatorName: () => 'nobody' };
  // The local console reads the client slots of the server, the operator name of the host and prints through the console.
  const sv = { svs: { maxclients: clients.length, clients } } as unknown as Server;

  return {
    console: new ServerLocalConsole(sv, serverHost as unknown as ServerHost, { Print: (text: string) => prints.push(text) } as unknown as ConsoleOutput),
    serverHost,
    prints,
  };
}

/**
 * Runs a console line with the parser available.
 * @param line the line
 * @param [client] who runs it
 */
async function run(line: string, client: ServerClient | null = null) {
  await withMockEngine({ COM, Con: { Print() {}, DPrint() {} }, Host: { frametime: 0.1 }, SV: {} }, async () => {
    await Cmd.ExecuteString(line, client);
  });
}

void describe('ServerLocalConsole', () => {
  beforeEach(() => {
    Cvar.Shutdown();
    Cmd.Init();
  });

  afterEach(() => {
    Cmd.forwardLocal = null;
    Cmd.Init();
  });

  void describe('findLocalPlayer', () => {
    void test('is the client that connected through the channel to the page', () => {
      const local = createClient('local');
      const { console: con } = createConsole([createClient('1.2.3.4:5'), local]);

      assert.equal(con.findLocalPlayer(), local);
    });

    void test('is nobody while the page is not connected', () => {
      const { console: con } = createConsole([createClient('1.2.3.4:5')]);

      assert.equal(con.findLocalPlayer(), null);
    });

    void test('is nobody once the client left', () => {
      const { console: con } = createConsole([createClient('local', ServerClient.STATE.FREE)]);

      assert.equal(con.findLocalPlayer(), null);
    });
  });

  void describe('commands that ask to be forwarded', () => {
    void test('run for the local player', async () => {
      const local = createClient('local');
      const { console: con } = createConsole([local]);
      const seen: unknown[] = [];

      Cmd.AddCommand('probe', class extends ConsoleCommand {
        run() {
          if (this.forward()) {
            return;
          }

          seen.push(this.client);
        }
      });
      con.install();

      await run('probe a b');

      assert.deepEqual(seen, [local]);
    });

    void test('say so when the page is not connected', async () => {
      const { console: con, prints } = createConsole([]);
      let ranAsPlayer = false;

      Cmd.AddCommand('probe', class extends ConsoleCommand {
        run() {
          if (!this.forward()) {
            ranAsPlayer = true;
          }
        }
      });
      con.install();

      await run('probe');

      assert.equal(ranAsPlayer, false);
      assert.deepEqual(prints, ['Can\'t "probe", not connected\n']);
    });

    void test('are left alone when a client sent them', async () => {
      const remote = createClient('1.2.3.4:5');
      const { console: con } = createConsole([createClient('local'), remote]);
      const seen: unknown[] = [];

      Cmd.AddCommand('probe', class extends ConsoleCommand {
        run() {
          if (!this.forward()) {
            seen.push(this.client);
          }
        }
      });
      con.install();

      await run('probe', remote);

      assert.deepEqual(seen, [remote]);
    });

    void test('are no longer taken once uninstalled', () => {
      const { console: con } = createConsole([]);

      con.install();
      con.uninstall();

      assert.equal(Cmd.forwardLocal, null);
    });
  });

  void describe('execute', () => {
    void test('runs the line as the console, not as a player', () => {
      const { console: con } = createConsole([createClient('local')]);
      const seen: unknown[] = [];

      Cmd.AddCommand('probe', class extends ConsoleCommand {
        run() {
          seen.push(this.client);
        }
      });

      withMockEngine({ COM, Con: { Print() {}, DPrint() {} }, Host: { frametime: 0.1 }, SV: {} }, () => {
        con.execute('probe', 'Ranger');
      });

      assert.deepEqual(seen, [null]);
    });

    void test('names the player as the operator for what the server does on their behalf', () => {
      const { console: con, serverHost } = createConsole([]);

      Cmd.AddCommand('probe', () => {});
      withMockEngine({ COM, Con: { Print() {}, DPrint() {} }, Host: { frametime: 0.1 }, SV: {} }, () => {
        con.execute('probe', 'Ranger');
      });

      assert.equal(serverHost.getLocalOperatorName(), 'Ranger');
    });
  });
});
