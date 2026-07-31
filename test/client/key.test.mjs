import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import Cmd from '../../source/engine/common/Cmd.ts';
import COM from '../../source/engine/common/Com.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
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
  const con = {
    Print(msg) { printed.push(msg); }, backscroll: 0, text: [], isOpen: false,
  };
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
      // `console` was retired as a destination — the drop-down console is now the
      // independent `Con.isOpen` overlay instead, taking dispatch priority over whichever of
      // these is active underneath it. Values are kept as before (minus that member) so
      // nothing needed renumbering.
      assert.equal(KeyDestination.game, 0);
      assert.equal(KeyDestination.message, 2);
      assert.equal(KeyDestination.menu, 3);
    });

    void test('destination defaults to game', () => {
      assert.equal(Key.destination, KeyDestination.game);
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
    void test('routes to the console editor when the console is open', () => {
      withMockKeyRegistry(({ con }) => {
        withCleanInputState(() => {
          con.isOpen = true;
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

  void describe('Event: drop-down console overlay', () => {
    /**
     * Temporarily installs mock `CL`/`M` registry stubs (alongside the existing `Con`/`COM`
     * stubs from withMockKeyRegistry) so Key.Event can run without a full client bootstrap.
     * Exposes spies for whether M.Keydown/M.ToggleMenu_f/M.Menu_Main_f were called.
     * @param {(spies: { menuKeydownCalls: number[], toggleMenu: { count: number }, menuMainCalls: { count: number } }) => void} callback
     * @param {{ connectionState?: number }} [options]
     */
    function withMockEventRegistry(callback, options = {}) {
      withMockKeyRegistry(() => {
        const previousCL = registry.CL;
        const previousM = registry.M;
        const menuKeydownCalls = [];
        const toggleMenu = { count: 0 };
        const menuMainCalls = { count: 0 };

        registry.CL = {
          cls: { state: options.connectionState ?? clientConnectionState.connected, demoplayback: false },
        };
        registry.M = {
          Keydown: (key) => { menuKeydownCalls.push(key); },
          ToggleMenu_f: () => { toggleMenu.count++; },
          Menu_Main_f: () => { menuMainCalls.count++; },
        };
        eventBus.publish('registry.frozen');

        try {
          callback({ menuKeydownCalls, toggleMenu, menuMainCalls });
        } finally {
          registry.CL = previousCL;
          registry.M = previousM;
          eventBus.publish('registry.frozen');
        }
      });
    }

    void test('Escape closes an open console instead of touching whatever is underneath', () => {
      withMockEventRegistry(({ menuKeydownCalls, toggleMenu }) => {
        withCleanInputState(() => {
          registry.Con.isOpen = true;
          Key.destination = KeyDestination.game;

          Key.Event(K.ESCAPE, true);
          Key.Event(K.ESCAPE, false);

          assert.equal(registry.Con.isOpen, false);
          assert.equal(menuKeydownCalls.length, 0);
          assert.equal(toggleMenu.count, 0);
        });
      });
    });

    void test('routes typed keys to the console when open, even though destination still reads game', () => {
      withMockEventRegistry(() => {
        withCleanInputState(() => {
          registry.Con.isOpen = true;
          Key.destination = KeyDestination.game;
          Key.edit_line = '';

          Key.Event('a'.charCodeAt(0), true);
          Key.Event('a'.charCodeAt(0), false);

          assert.equal(Key.edit_line, 'a');
        });
      });
    });

    void test('routes typed keys to the console when open, even over the menu', () => {
      withMockEventRegistry(({ menuKeydownCalls }) => {
        withCleanInputState(() => {
          registry.Con.isOpen = true;
          Key.destination = KeyDestination.menu;
          Key.edit_line = '';

          Key.Event('b'.charCodeAt(0), true);
          Key.Event('b'.charCodeAt(0), false);

          assert.equal(Key.edit_line, 'b');
          assert.equal(menuKeydownCalls.length, 0);
        });
      });
    });

    void test('a key not consumed as console text still fires its binding while open (e.g. the toggle key)', () => {
      withMockEventRegistry(() => {
        withCleanInputState(() => {
          const previousBindings = [...Key.bindings];
          const previousCmdText = Cmd.text;
          const tick = '`'.charCodeAt(0);

          try {
            Key.bindings = [];
            Key.bindings[tick] = 'toggleconsole';
            Cmd.text = '';
            registry.Con.isOpen = true;

            Key.Event(tick, true);
            Key.Event(tick, false);

            assert.equal(Cmd.text, 'toggleconsole\n');
          } finally {
            Key.bindings = previousBindings;
            Cmd.text = previousCmdText;
          }
        });
      });
    });

    void test('gameplay keys still execute their bindings when the console is closed', () => {
      withMockEventRegistry(() => {
        withCleanInputState(() => {
          const previousBindings = [...Key.bindings];
          const previousCmdText = Cmd.text;

          try {
            Key.bindings = [];
            Key.bindings[K.SPACE] = '+jump';
            Cmd.text = '';
            registry.Con.isOpen = false;
            Key.destination = KeyDestination.game;

            Key.Event(K.SPACE, true);

            assert.equal(Cmd.text, `+jump ${K.SPACE}\n`);
          } finally {
            Key.Event(K.SPACE, false);
            Key.bindings = previousBindings;
            Cmd.text = previousCmdText;
          }
        });
      });
    });

    void test('F-keys still execute bindings in the menu when the console is closed', () => {
      withMockEventRegistry(({ menuKeydownCalls }) => {
        withCleanInputState(() => {
          const previousBindings = [...Key.bindings];
          const previousCmdText = Cmd.text;

          try {
            Key.bindings = [];
            Key.bindings[K.F1] = 'help';
            Cmd.text = '';
            registry.Con.isOpen = false;
            Key.destination = KeyDestination.menu;

            Key.Event(K.F1, true);

            assert.equal(Cmd.text, 'help\n');
            assert.equal(menuKeydownCalls.length, 0);
          } finally {
            Key.Event(K.F1, false);
            Key.bindings = previousBindings;
            Cmd.text = previousCmdText;
          }
        });
      });
    });

    void test('non-F-keys in the menu go to M.Keydown when the console is closed', () => {
      withMockEventRegistry(({ menuKeydownCalls }) => {
        withCleanInputState(() => {
          registry.Con.isOpen = false;
          Key.destination = KeyDestination.menu;

          Key.Event(K.DOWNARROW, true);
          Key.Event(K.DOWNARROW, false);

          assert.deepEqual(menuKeydownCalls, [K.DOWNARROW]);
        });
      });
    });

    void test('the toggle key still opens the console from the menu, even with a text field focused', () => {
      // Regression test: backtick/tilde are excluded from Key.consolekeys specifically so their
      // binding always fires, but the menu's own binding-execution carve-out used to only cover
      // F-keys — meaning `~` got silently typed into a focused menu Textbox (e.g. "Your Name")
      // instead of toggling the console.
      withMockEventRegistry(({ menuKeydownCalls }) => {
        withCleanInputState(() => {
          const previousBindings = [...Key.bindings];
          const previousCmdText = Cmd.text;
          const tick = '`'.charCodeAt(0);

          try {
            Key.bindings = [];
            Key.bindings[tick] = 'toggleconsole';
            Cmd.text = '';
            registry.Con.isOpen = false;
            Key.destination = KeyDestination.menu;

            Key.Event(tick, true);

            assert.equal(Cmd.text, 'toggleconsole\n');
            assert.equal(menuKeydownCalls.length, 0);
          } finally {
            Key.Event(tick, false);
            Key.bindings = previousBindings;
            Cmd.text = previousCmdText;
          }
        });
      });
    });

    void test('mouse clicks in the menu still go to M.Keydown, not treated as a binding', () => {
      // Regression test for the fix above: widening the menu's binding-execution carve-out to
      // cover non-consolekeys in general must not swallow MOUSE1/2/3 or wheel keys, which the
      // menu's own click/scroll handling needs to keep receiving.
      withMockEventRegistry(({ menuKeydownCalls }) => {
        withCleanInputState(() => {
          registry.Con.isOpen = false;
          Key.destination = KeyDestination.menu;

          Key.Event(K.MOUSE1, true);
          Key.Event(K.MOUSE1, false);

          assert.deepEqual(menuKeydownCalls, [K.MOUSE1]);
        });
      });
    });
  });

  void describe('Event: stuck at the idle "game" destination with no game running', () => {
    /**
     * Temporarily installs mock `CL`/`M` registry stubs so Key.Event's click-opens-menu escape
     * hatch can run without a full client bootstrap.
     * @param {number} connectionState
     * @param {(spies: { menuMainCalls: { count: number } }) => void} callback test callback
     */
    function withMockConsoleClickRegistry(connectionState, callback) {
      withMockKeyRegistry(() => {
        const previousCL = registry.CL;
        const previousM = registry.M;
        const menuMainCalls = { count: 0 };

        registry.CL = { cls: { state: connectionState, demoplayback: false } };
        registry.M = {
          Menu_Main_f: () => { menuMainCalls.count++; },
          ToggleMenu_f: () => {},
          Keydown: () => {},
        };
        eventBus.publish('registry.frozen');

        try {
          callback({ menuMainCalls });
        } finally {
          registry.CL = previousCL;
          registry.M = previousM;
          eventBus.publish('registry.frozen');
        }
      });
    }

    void test('opens the main menu when clicking while disconnected', () => {
      withCleanInputState(() => {
        Key.destination = KeyDestination.game;

        withMockConsoleClickRegistry(clientConnectionState.disconnected, ({ menuMainCalls }) => {
          Key.Event(K.MOUSE1, true);
          Key.Event(K.MOUSE1, false);

          assert.equal(menuMainCalls.count, 1);
        });
      });
    });

    void test('opens the main menu when clicking while a connection attempt is still in progress', () => {
      withCleanInputState(() => {
        Key.destination = KeyDestination.game;

        withMockConsoleClickRegistry(clientConnectionState.connecting, ({ menuMainCalls }) => {
          Key.Event(K.MOUSE1, true);
          Key.Event(K.MOUSE1, false);

          assert.equal(menuMainCalls.count, 1);
        });
      });
    });

    void test('does not open the menu when a game is actually connected', () => {
      withCleanInputState(() => {
        Key.destination = KeyDestination.game;

        withMockConsoleClickRegistry(clientConnectionState.connected, ({ menuMainCalls }) => {
          Key.Event(K.MOUSE1, true);
          Key.Event(K.MOUSE1, false);

          assert.equal(menuMainCalls.count, 0);
        });
      });
    });

    void test('does not open the menu from the menu destination itself', () => {
      withCleanInputState(() => {
        Key.destination = KeyDestination.menu;

        withMockConsoleClickRegistry(clientConnectionState.disconnected, ({ menuMainCalls }) => {
          Key.Event(K.MOUSE1, true);
          Key.Event(K.MOUSE1, false);

          assert.equal(menuMainCalls.count, 0);
        });
      });
    });

    void test('a single click cannot both close the menu (to game) and reopen it', () => {
      // Regression test: the menu's Back/Close button synthesizes Escape on MOUSE1, which can
      // change Key.destination from menu to game within the very same mousedown dispatch. The
      // click-opens-menu check must not re-fire for that same physical click.
      withCleanInputState(() => {
        Key.destination = KeyDestination.menu;

        withMockConsoleClickRegistry(clientConnectionState.disconnected, ({ menuMainCalls }) => {
          registry.M.Keydown = () => {
            // Simulate the Back/Close button popping the menu stack back to `game`.
            Key.destination = KeyDestination.game;
          };
          eventBus.publish('registry.frozen');

          Key.Event(K.MOUSE1, true);

          assert.equal(menuMainCalls.count, 0);
          assert.equal(Key.destination, KeyDestination.game);
        });
      });
    });
  });
});
