import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import Cmd from '../../source/engine/common/Cmd.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
import Key from '../../source/engine/client/Key.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import { MultiplayerSetupPage } from '../../source/engine/client/Menu.ts';

/**
 * Installs the minimal registry stubs MultiplayerSetupPage and its widgets need
 * (CL for name/color/connection state, Key/Host/S/M for widget sound/blink plumbing).
 * @param {object} cl fake CL module
 * @param {() => void} callback test callback
 */
function withMockMultiplayerRegistry(cl, callback) {
  const previousCL = registry.CL;
  const previousHost = registry.Host;
  const previousKey = registry.Key;
  const previousM = registry.M;
  const previousS = registry.S;

  registry.CL = cl;
  registry.Host = { realtime: 0 };
  registry.Key = Key;
  registry.M = {
    sfx_menu1: 'menu1', sfx_menu2: 'menu2', sfx_menu3: 'menu3', entersound: false,
    Print() {}, PrintWhite() {}, DrawCharacter() {},
  };
  registry.S = { LocalSound() {} };
  eventBus.publish('registry.frozen');

  try {
    callback();
  } finally {
    registry.CL = previousCL;
    registry.Host = previousHost;
    registry.Key = previousKey;
    registry.M = previousM;
    registry.S = previousS;
    eventBus.publish('registry.frozen');
  }
}

/**
 * Types each character of a string into the currently-focused item.
 * @param {MultiplayerSetupPage} page page under test
 * @param {string} text text to type
 */
function type(page, text) {
  for (const ch of text) {
    page.handleInput(ch.charCodeAt(0));
  }
}

void describe('MultiplayerSetupPage', () => {
  void test('typing a new name and confirming Join Game queues a name command', () => {
    const cl = {
      name: { string: 'OldName' },
      color: { value: 0x12 },
      cls: { state: clientConnectionState.disconnected },
    };

    withMockMultiplayerRegistry(cl, () => {
      const previousCmdText = Cmd.text;
      Cmd.text = '';

      try {
        const page = new MultiplayerSetupPage();
        page.activate();

        assert.equal(page.cursor, 0, 'name field should be focused by default');

        // Clear the pre-filled name, then type a fresh one.
        for (let i = 0; i < 'OldName'.length; i++) {
          page.handleInput(K.BACKSPACE);
        }
        type(page, 'NewName');

        page.handleInput(K.DOWNARROW);
        page.handleInput(K.DOWNARROW);
        page.handleInput(K.DOWNARROW);
        assert.equal(page.cursor, 3, 'cursor should reach the Join Game row');

        page.handleInput(K.ENTER);

        assert.match(Cmd.text, /name "NewName"/);
      } finally {
        Cmd.text = previousCmdText;
      }
    });
  });

  void test('changing shirt/pants color and confirming queues a color command', () => {
    const cl = {
      name: { string: 'Player' },
      color: { value: 0x12 }, // top=1, bottom=2
      cls: { state: clientConnectionState.disconnected },
    };

    withMockMultiplayerRegistry(cl, () => {
      const previousCmdText = Cmd.text;
      Cmd.text = '';

      try {
        const page = new MultiplayerSetupPage();
        page.activate();

        assert.equal(page.top, 1);
        assert.equal(page.bottom, 2);

        page.handleInput(K.DOWNARROW); // -> shirt color
        page.handleInput(K.RIGHTARROW); // top 1 -> 2
        page.handleInput(K.DOWNARROW); // -> pants color
        page.handleInput(K.RIGHTARROW); // bottom 2 -> 3
        page.handleInput(K.DOWNARROW); // -> Join Game
        page.handleInput(K.ENTER);

        assert.match(Cmd.text, /color 2 3/);
      } finally {
        Cmd.text = previousCmdText;
      }
    });
  });

  void test('when already connected, confirming closes the menu instead of opening the server browser', () => {
    const cl = {
      name: { string: 'Player' },
      color: { value: 0 },
      cls: { state: clientConnectionState.connected },
    };

    withMockMultiplayerRegistry(cl, () => {
      const page = new MultiplayerSetupPage();
      page.activate();

      assert.equal(page.items[3].label, 'Accept Changes');
    });
  });
});
