import type { ConsoleCommand } from '../common/Cmd.ts';
import type { ConsoleOutput } from '../common/Services.ts';
import type Server from './Server.ts';
import type ServerHost from './ServerHost.ts';

import Cmd from '../common/Cmd.ts';
import { QSocket } from '../network/NetworkDrivers.ts';
import { ServerClient } from './Client.ts';

/**
 * What the player types at the console of a page whose server is in a worker. The page forwards what
 * it does not know, and the commands that act on the player (`god`, `give`, `kill`, ...) ask to be
 * forwarded as that player, like they do on a console that has the server in its own table. That
 * request is answered by running the command for the local player of this server.
 */
export default class ServerLocalConsole {
  /** The address the player of the page connects with. */
  static readonly LOCAL_ADDRESS = 'local';

  readonly #sv: Server;
  readonly #serverHost: ServerHost;
  readonly #con: ConsoleOutput;

  constructor(sv: Server, serverHost: ServerHost, con: ConsoleOutput) {
    this.#sv = sv;
    this.#serverHost = serverHost;
    this.#con = con;
  }

  /**
   * Makes commands that ask to be forwarded run for the local player.
   */
  install(): void {
    Cmd.forwardLocal = (command) => this.forward(command);
  }

  /**
   * Stops handling forwarding requests.
   */
  uninstall(): void {
    Cmd.forwardLocal = null;
  }

  /**
   * Runs a line the player typed at the console of the page.
   * @param text The line.
   * @param operator Name the player has, shown for what they do on the server's behalf, like kicks.
   */
  execute(text: string, operator: string): void {
    this.#serverHost.getLocalOperatorName = () => operator;
    void Cmd.ExecuteString(text, null);
  }

  /**
   * Runs a command as the local player.
   * @param command The command that asked to be forwarded.
   * @returns True, the command is taken care of either way.
   */
  forward(command: ConsoleCommand): boolean {
    const player = this.findLocalPlayer();

    if (player === null) {
      this.#con.Print(`Can't "${command.command}", not connected\n`);
      return true;
    }

    void Cmd.ExecuteString(command.args ?? '', player);

    return true;
  }

  /**
   * Finds the client the page of this server plays with.
   * @returns The client, `null` when the page is not connected.
   */
  findLocalPlayer(): ServerClient | null {
    for (let index = 0; index < this.#sv.svs.maxclients; index++) {
      const client = this.#sv.svs.clients[index];

      if (client.state >= ServerClient.STATE.CONNECTED
        && client.netconnection !== null
        && client.netconnection.state === QSocket.STATE_CONNECTED
        && client.netconnection.address === ServerLocalConsole.LOCAL_ADDRESS) {
        return client;
      }
    }

    return null;
  }
}
