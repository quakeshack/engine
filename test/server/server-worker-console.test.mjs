import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import ServerWorkerConsole from '../../source/engine/server/ServerWorkerConsole.ts';

/**
 * @returns {{ console: ServerWorkerConsole, sent: object[] }} a console and the messages it sent
 */
function createConsole() {
  const sent = [];

  return { console: new ServerWorkerConsole((message) => sent.push(message)), sent };
}

void describe('ServerWorkerConsole', () => {
  void test('sends every line with how loud it is', () => {
    const { console: con, sent } = createConsole();

    con.Print('a');
    con.PrintSuccess('b');
    con.PrintWarning('c');
    con.PrintError('d');
    con.DPrint('e');

    assert.deepEqual(sent, [
      { kind: 'print', level: 'print', text: 'a' },
      { kind: 'print', level: 'success', text: 'b' },
      { kind: 'print', level: 'warning', text: 'c' },
      { kind: 'print', level: 'error', text: 'd' },
      { kind: 'print', level: 'debug', text: 'e' },
    ]);
  });

  void test('keeps what is printed while capturing and returns it', () => {
    const { console: con, sent } = createConsole();

    con.StartCapturing();
    con.Print('first\n');
    con.PrintWarning('second\n');

    assert.equal(con.StopCapturing(), 'first\nsecond\n');
    assert.deepEqual(sent, []);
  });

  void test('prints normally again after a capture', () => {
    const { console: con, sent } = createConsole();

    con.StartCapturing();
    con.StopCapturing();
    con.Print('after');

    assert.deepEqual(sent, [{ kind: 'print', level: 'print', text: 'after' }]);
  });

  void test('captures nothing when nothing was started', () => {
    assert.equal(createConsole().console.StopCapturing(), '');
  });

  void test('sends the color of a line along', () => {
    const { console: con, sent } = createConsole();

    con.Print('red\n', new Vector(1, 0, 0));

    assert.deepEqual(sent, [{ kind: 'print', level: 'print', text: 'red\n', color: [1, 0, 0] }]);
  });
});
