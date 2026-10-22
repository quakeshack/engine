import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import Cmd, { ConsoleCommand } from '../../source/engine/common/Cmd.ts';

/**
 * Builds a command that asks to be forwarded, as `god` or `give` do when typed at a console.
 * @param client Who issued it, `null` for the local console.
 * @returns The command.
 */
function createCommand(client: ConsoleCommand['client'] = null): ConsoleCommand {
  const command = new ConsoleCommand();

  command.client = client;
  command.command = 'god';
  command.args = 'god';

  return command;
}

void describe('ConsoleCommand.forward', () => {
  afterEach(() => {
    Cmd.forwardLocal = null;
    Cmd.forwardToServer = null;
  });

  void test('does not forward what a remote player typed', () => {
    Cmd.forwardToServer = () => { throw new Error('must not be asked'); };

    assert.equal(createCommand({} as ConsoleCommand['client']).forward(), false);
  });

  void test('runs it for the local player in a realm that has a server of its own', () => {
    const forwarded: ConsoleCommand[] = [];
    const command = createCommand();

    Cmd.forwardLocal = (forwardedCommand) => { forwarded.push(forwardedCommand); return true; };
    Cmd.forwardToServer = () => { throw new Error('the local player comes first'); };

    assert.equal(command.forward(), true);
    assert.deepEqual(forwarded, [command]);
  });

  void test('hands it to the server the realm is connected to', () => {
    const forwarded: ConsoleCommand[] = [];
    const command = createCommand();

    Cmd.forwardToServer = (forwardedCommand) => { forwarded.push(forwardedCommand); return true; };

    assert.equal(command.forward(), true);
    assert.deepEqual(forwarded, [command]);
  });

  void test('is swallowed in a realm that has no server to forward to, like a dedicated server', () => {
    assert.equal(createCommand().forward(), true);
  });
});
