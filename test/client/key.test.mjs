import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import Cmd from '../../source/engine/common/Cmd.ts';
import COM from '../../source/engine/common/Com.ts';
import Key, { KeyDestination } from '../../source/engine/client/Key.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Temporarily installs a minimal `Con` registry stub (plus the real `COM` for
 * `Cmd.ExecuteString`'s tokenizer) so `Key.Console`/`Key.Message` can run without a full
 * client bootstrap.
 * @param {(context: { con: object, printed: string[] }) => void} callback test callback
 */
function withMockKeyRegistry(callback) {
  const previousCon = registry.Con;
  const previousCOM = registry.COM;

  const printed = [];
  const con = { Print(msg) { printed.push(msg); }, backscroll: 0, text: [] };
  registry.Con = con;
  registry.COM = COM;
  eventBus.publish('registry.frozen');

  try {
    callback({ con, printed });
  } finally {
    registry.Con = previousCon;
    registry.COM = previousCOM;
    eventBus.publish('registry.frozen');
  }
}

/**
 * Snapshots and restores the module-level console/chat input state around a test, since
 * `Key`'s edit line, history, and destination are shared static singletons.
 * @param {() => void} callback test callback
 */
function withCleanInputState(callback) {
  const previousDestination = Key.destination;
  const previousLines = [...Key.lines];
  const previousHistoryLine = Key.history_line;
  const previousTeamMessage = Key.team_message;
  const previousCmdText = Cmd.text;

  Key.edit_line = '';
  Key.chat_buffer = '';
  Cmd.text = '';

  try {
    callback();
  } finally {
    Key.destination = previousDestination;
    Key.lines = previousLines;
    Key.history_line = previousHistoryLine;
    Key.team_message = previousTeamMessage;
    Key.edit_line = '';
    Key.chat_buffer = '';
    Cmd.text = previousCmdText;
  }
}

void describe('Key', () => {
  void describe('StringToKeynum', () => {
    void test('resolves named special keys', () => {
      assert.equal(Key.StringToKeynum('ENTER'), K.ENTER);
      assert.equal(Key.StringToKeynum('ESCAPE'), K.ESCAPE);
      assert.equal(Key.StringToKeynum('SPACE'), K.SPACE);
      assert.equal(Key.StringToKeynum('SEMICOLON'), ';'.charCodeAt(0));
    });

    void test('resolves single printable characters by char code', () => {
      assert.equal(Key.StringToKeynum('a'), 97);
      assert.equal(Key.StringToKeynum('Z'), 90);
    });

    void test('is case-insensitive for named keys', () => {
      assert.equal(Key.StringToKeynum('enter'), K.ENTER);
      assert.equal(Key.StringToKeynum('Escape'), K.ESCAPE);
    });

    void test('returns null for unknown names', () => {
      assert.equal(Key.StringToKeynum('not-a-key'), null);
      assert.equal(Key.StringToKeynum('BOGUS'), null);
    });
  });

  void describe('KeynumToString', () => {
    void test('returns printable character for ASCII range', () => {
      assert.equal(Key.KeynumToString(97), 'a');
      assert.equal(Key.KeynumToString(65), 'A');
    });

    void test('returns canonical name for special keys', () => {
      assert.equal(Key.KeynumToString(K.ENTER), 'ENTER');
      assert.equal(Key.KeynumToString(K.ESCAPE), 'ESCAPE');
    });

    void test('returns marker for unrecognized key codes', () => {
      assert.equal(Key.KeynumToString(999), '<UNKNOWN KEYNUM>');
    });
  });

  void describe('WriteBindings', () => {
    void test('serializes active bindings with readable key names', () => {
      const previousBindings = [...Key.bindings];

      try {
        Key.bindings = [];
        Key.bindings[K.ENTER] = '+jump';
        Key.bindings[97] = 'say hello';

        assert.equal(
          Key.WriteBindings(),
          'bind "ENTER" "+jump"\nbind "a" "say hello"',
        );
      } finally {
        Key.bindings = previousBindings;
      }
    });

    void test('skips null and undefined slots', () => {
      const previousBindings = [...Key.bindings];
      try {
        Key.bindings = [];
        Key.bindings[10] = null;
        Key.bindings[97] = 'test';
        assert.equal(Key.WriteBindings(), 'bind "a" "test"');
      } finally {
        Key.bindings = previousBindings;
      }
    });
  });

  void describe('BindingToString', () => {
    void test('finds the first key bound to a command', () => {
      const previousBindings = [...Key.bindings];
      try {
        Key.bindings = [];
        Key.bindings[K.ENTER] = '+jump';
        assert.equal(Key.BindingToString('+jump'), 'ENTER');
      } finally {
        Key.bindings = previousBindings;
      }
    });

    void test('returns null when no key is bound to the command', () => {
      assert.equal(Key.BindingToString('nonexistent_command'), null);
    });
  });

  void describe('KeyDestination', () => {
    void test('enum values match expected constants', () => {
      assert.equal(KeyDestination.game, 0);
      assert.equal(KeyDestination.console, 1);
      assert.equal(KeyDestination.message, 2);
      assert.equal(KeyDestination.menu, 3);
    });

    void test('destination defaults to console', () => {
      assert.equal(Key.destination, KeyDestination.console);
    });
  });

  void describe('Console', () => {
    void test('typing appends characters and moves the cursor to the end', () => {
      withMockKeyRegistry(() => {
        withCleanInputState(() => {
          Key.Console('a'.charCodeAt(0));
          Key.Console('b'.charCodeAt(0));
          Key.Console('c'.charCodeAt(0));

          assert.equal(Key.edit_line, 'abc');
          assert.equal(Key.consoleCursorPos, 3);
        });
      });
    });

    void test('Left/Right move the cursor, so typing can insert in the middle of the line', () => {
      withMockKeyRegistry(() => {
        withCleanInputState(() => {
          Key.edit_line = 'ac';
          Key.Console(K.LEFTARROW);
          Key.Console('b'.charCodeAt(0));

          assert.equal(Key.edit_line, 'abc');
        });
      });
    });

    void test('Backspace/Del edit around the cursor', () => {
      withMockKeyRegistry(() => {
        withCleanInputState(() => {
          Key.edit_line = 'abc';
          Key.Console(K.HOME);
          Key.Console(K.RIGHTARROW); // cursor between 'a' and 'b'

          Key.Console(K.DEL); // forward-delete 'b'
          assert.equal(Key.edit_line, 'ac');

          Key.Console(K.BACKSPACE); // delete 'a'
          assert.equal(Key.edit_line, 'c');
        });
      });
    });

    void test('Enter queues the line, echoes it, records history, and clears the input', () => {
      withMockKeyRegistry(({ printed }) => {
        withCleanInputState(() => {
          Key.lines = [''];
          Key.edit_line = 'status';

          Key.Console(K.ENTER);

          assert.equal(Cmd.text, 'status\n');
          assert.ok(printed.includes(']status\n'));
          assert.equal(Key.lines.at(-1), 'status');
          assert.equal(Key.edit_line, '');
          assert.equal(Key.consoleCursorPos, 0);
        });
      });
    });

    void test('Up/Down navigate command history', () => {
      withMockKeyRegistry(() => {
        withCleanInputState(() => {
          Key.lines = ['', 'first', 'second'];
          Key.history_line = Key.lines.length;

          Key.Console(K.UPARROW);
          assert.equal(Key.edit_line, 'second');

          Key.Console(K.UPARROW);
          assert.equal(Key.edit_line, 'first');

          Key.Console(K.DOWNARROW);
          assert.equal(Key.edit_line, 'second');

          Key.Console(K.DOWNARROW);
          assert.equal(Key.edit_line, '');
        });
      });
    });

    void test('plain Home/End move the cursor without touching the scrollback', () => {
      withMockKeyRegistry(({ con }) => {
        withCleanInputState(() => {
          Key.edit_line = 'hello';
          con.text = new Array(20).fill(null);
          con.backscroll = 0;

          Key.Console(K.HOME);
          assert.equal(Key.consoleCursorPos, 0);
          assert.equal(con.backscroll, 0);

          Key.Console(K.END);
          assert.equal(Key.consoleCursorPos, 5);
          assert.equal(con.backscroll, 0);
        });
      });
    });

    void test('Ctrl+Home/Ctrl+End scroll the backscroll to the top/bottom instead', () => {
      withMockKeyRegistry(({ con }) => {
        withCleanInputState(() => {
          con.text = new Array(20).fill(null);
          con.backscroll = 0;

          // Reaches into Key's internal pressed-key set to simulate Ctrl being held, since
          // that state is normally only reachable via a full DOM keydown round-trip.
          Key.pressed.add(K.CTRL);
          try {
            Key.Console(K.HOME);
            assert.equal(con.backscroll, 10);

            Key.Console(K.END);
            assert.equal(con.backscroll, 0);
          } finally {
            Key.pressed.delete(K.CTRL);
          }
        });
      });
    });
  });

  void describe('Message', () => {
    void test('typing composes the chat buffer with cursor support', () => {
      withMockKeyRegistry(() => {
        withCleanInputState(() => {
          Key.destination = KeyDestination.message;
          Key.chat_buffer = 'ac';

          Key.Message(K.LEFTARROW);
          Key.Message('b'.charCodeAt(0));

          assert.equal(Key.chat_buffer, 'abc');
          assert.equal(Key.chatCursorPos, 2);
        });
      });
    });

    void test('Enter sends the message via say/say_team and returns to game', () => {
      withMockKeyRegistry(() => {
        withCleanInputState(() => {
          const received = [];
          Cmd.AddCommand('say_team', (...args) => { received.push(args.join(' ')); });

          try {
            Key.destination = KeyDestination.message;
            Key.team_message = true;
            Key.chat_buffer = 'gg';

            Key.Message(K.ENTER);

            assert.deepEqual(received, ['gg']);
            assert.equal(Key.destination, KeyDestination.game);
            assert.equal(Key.chat_buffer, '');
          } finally {
            Cmd.RemoveCommand('say_team');
          }
        });
      });
    });

    void test('Enter on a blank/whitespace-only message sends nothing but still exits', () => {
      withMockKeyRegistry(() => {
        withCleanInputState(() => {
          Key.destination = KeyDestination.message;
          Key.chat_buffer = '   ';

          Key.Message(K.ENTER);

          assert.equal(Cmd.text, '');
          assert.equal(Key.destination, KeyDestination.game);
        });
      });
    });

    void test('Escape discards the message and returns to game', () => {
      withMockKeyRegistry(() => {
        withCleanInputState(() => {
          Key.destination = KeyDestination.message;
          Key.chat_buffer = 'nevermind';

          Key.Message(K.ESCAPE);

          assert.equal(Key.destination, KeyDestination.game);
          assert.equal(Key.chat_buffer, '');
        });
      });
    });
  });

  void describe('Paste', () => {
    void test('routes to the console editor when destination is console', () => {
      withMockKeyRegistry(() => {
        withCleanInputState(() => {
          Key.destination = KeyDestination.console;
          Key.edit_line = 'ac';

          Key.Console(K.HOME);
          Key.Console(K.RIGHTARROW);
          Key.Paste('b');

          assert.equal(Key.edit_line, 'abc');
        });
      });
    });

    void test('routes to the chat editor when destination is message', () => {
      withMockKeyRegistry(() => {
        withCleanInputState(() => {
          Key.destination = KeyDestination.message;
          Key.chat_buffer = 'hi';

          Key.Paste(' there');

          assert.equal(Key.chat_buffer, 'hi there');
        });
      });
    });

    void test('is a no-op during gameplay', () => {
      withMockKeyRegistry(() => {
        withCleanInputState(() => {
          Key.destination = KeyDestination.game;

          Key.Paste('hello');

          assert.equal(Key.edit_line, '');
          assert.equal(Key.chat_buffer, '');
        });
      });
    });
  });
});
