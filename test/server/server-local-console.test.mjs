import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import COM from '../../source/engine/common/Com.ts';
import Cmd, { ConsoleCommand } from '../../source/engine/common/Cmd.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';
import ServerLocalConsole from '../../source/engine/server/ServerLocalConsole.ts';
import { QSocket } from '../../source/engine/network/NetworkDrivers.ts';
import { withMockRegistry } from '../physics/fixtures.mjs';

/**
 * @param {string} address address of the connection
 * @param {number} [state] state of the client
 * @returns {object} a client connected from that address
 */
function createClient(address, state = ServerClient.STATE.SPAWNED) {
  return { state, netconnection: { address, state: QSocket.STATE_CONNECTED } };
}

/**
 * @param {object[]} clients the clients of the server
 * @returns {{ console: ServerLocalConsole, serverHost: { getLocalOperatorName: () => string }, prints: string[] }} the local console and what it works on
 */
function createConsole(clients) {
  const prints = [];
  const serverHost = { getLocalOperatorName: () => 'nobody' };
  const sv = { svs: { maxclients: clients.length, clients } };

  return {
    console: new ServerLocalConsole(/** @type {any} */ (sv), /** @type {any} */ (serverHost), /** @type {any} */ ({ Print: (text) => prints.push(text) })),
    serverHost,
    prints,
  };
}

/**
 * Runs a console line with the parser available.
 * @param {string} line the line
 * @param {object | null} [client] who runs it
 */
async function run(line, client = null) {
  await withMockRegistry({ COM: /** @type {any} */ (COM), Con: { Print() {}, DPrint() {} }, Host: { frametime: 0.1 }, SV: {} }, async () => {
    await Cmd.ExecuteString(line, /** @type {any} */ (client));
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
      const seen = [];

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
      const seen = [];

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
    void test('runs the line as the console, not as a player', async () => {
      const { console: con } = createConsole([createClient('local')]);
      const seen = [];

      Cmd.AddCommand('probe', class extends ConsoleCommand {
        run() {
          seen.push(this.client);
        }
      });

      await withMockRegistry({ COM: /** @type {any} */ (COM), Con: { Print() {}, DPrint() {} }, Host: { frametime: 0.1 }, SV: {} }, () => {
        con.execute('probe', 'Ranger');
      });

      assert.deepEqual(seen, [null]);
    });

    void test('names the player as the operator for what the server does on their behalf', async () => {
      const { console: con, serverHost } = createConsole([]);

      Cmd.AddCommand('probe', () => {});
      await withMockRegistry({ COM: /** @type {any} */ (COM), Con: { Print() {}, DPrint() {} }, Host: { frametime: 0.1 }, SV: {} }, () => {
        con.execute('probe', 'Ranger');
      });

      assert.equal(serverHost.getLocalOperatorName(), 'Ranger');
    });
  });
});
