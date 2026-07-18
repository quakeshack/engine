import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
import { KeyDestination } from '../../source/engine/client/Key.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import { default as M, QuitDialogPage } from '../../source/engine/client/Menu.ts';
import { MenuPage } from '../../source/engine/client/menu/MenuPage.ts';

/**
 * Installs the minimal registry stubs QuitDialogPage's Yes/No handling needs: `CL` (so
 * M.PopMenu()'s fallback destination logic can run — connected by default, matching the common
 * "quit from the in-game pause menu" case most of these tests exercise), `Key` (a settable
 * destination, mutated directly by M.PopMenu()), `Host` (ForceQuit, recorded rather than
 * actually exiting the process), and `IN` (ReleasePointerLock, called by MenuStack — a no-op spy
 * here). Also registers a bare 'main' page on the real M.menuStack, since M.PopMenu()'s
 * disconnected fallback collapses back to it.
 * @param {(context: { quitCalled: () => boolean }) => void} callback test callback
 * @param {{ state?: import('../../source/engine/common/Def.ts').clientConnectionState }} [options]
 */
function withMockQuitRegistry(callback, options = {}) {
  const previousCL = registry.CL;
  const previousKey = registry.Key;
  const previousHost = registry.Host;
  const previousIN = registry.IN;
  const previousM = registry.M;
  const previousStack = [...M.menuStack.stack];
  const previousPages = new Map(M.menuStack.pages);
  let quitCalled = false;

  registry.CL = { cls: { state: options.state ?? clientConnectionState.connected } };
  registry.Key = { destination: KeyDestination.menu };
  registry.Host = { realtime: 0, ForceQuit: () => { quitCalled = true; } };
  registry.IN = { ReleasePointerLock: () => {} };
  registry.M = M; // MenuStack.push() sets M.entersound directly on the real registry entry.
  M.menuStack.stack.length = 0;
  M.menuStack.register('main', new MenuPage({ title: 'Main' }));
  eventBus.publish('registry.frozen');

  try {
    callback({ quitCalled: () => quitCalled });
  } finally {
    registry.CL = previousCL;
    registry.Key = previousKey;
    registry.Host = previousHost;
    registry.IN = previousIN;
    registry.M = previousM;
    M.menuStack.stack.length = 0;
    M.menuStack.stack.push(...previousStack);
    M.menuStack.pages.clear();
    for (const [name, page] of previousPages) {
      M.menuStack.pages.set(name, page);
    }
    eventBus.publish('registry.frozen');
  }
}

void describe('QuitDialogPage', () => {
  void test('Y still confirms and N still cancels from the keyboard', () => {
    withMockQuitRegistry(({ quitCalled }) => {
      const page = new QuitDialogPage();

      assert.equal(page.handleInput(110), true); // 'n'
      assert.equal(quitCalled(), false);

      assert.equal(page.handleInput(121), true); // 'y'
      assert.equal(quitCalled(), true);
      // 'n' already popped the (empty) stack above, falling back to `game` (the mock is
      // connected, matching quitting from an in-game pause menu); confirming quit via 'y'
      // doesn't touch Key.destination at all anymore.
      assert.equal(registry.Key.destination, KeyDestination.game);
    });
  });

  void test('clicking "Yes" confirms the quit, same as pressing Y', () => {
    withMockQuitRegistry(({ quitCalled }) => {
      const page = new QuitDialogPage();

      M.mouseX = 88; // QuitDialogPage's #yesX
      M.mouseY = 116; // QuitDialogPage's #promptY

      assert.equal(page.handleInput(K.MOUSE1), true);
      assert.equal(quitCalled(), true);
      assert.equal(registry.Key.destination, KeyDestination.menu);
    });
  });

  void test('clicking "No" cancels, same as pressing N', () => {
    withMockQuitRegistry(({ quitCalled }) => {
      const page = new QuitDialogPage();

      M.mouseX = 168; // QuitDialogPage's #noX
      M.mouseY = 116;

      assert.equal(page.handleInput(K.MOUSE1), true);
      assert.equal(quitCalled(), false);
      // M.PopMenu() on an already-empty stack falls back to returnToPreviousDestination() while
      // connected (console is no longer a destination to fall back to).
      assert.equal(registry.Key.destination, KeyDestination.game);
    });
  });

  void test('clicking elsewhere in the dialog does not confirm or cancel', () => {
    withMockQuitRegistry(({ quitCalled }) => {
      const page = new QuitDialogPage();

      M.mouseX = 200;
      M.mouseY = 90; // inside the box, but not on the Yes/No row

      assert.equal(page.handleInput(K.MOUSE1), false);
      assert.equal(quitCalled(), false);
      assert.equal(registry.Key.destination, KeyDestination.menu);
    });
  });

  void test('N collapses back to the main page instead of the game while disconnected', () => {
    // Regression test: M.PopMenu()'s empty-stack fallback must not drop to `game` while there's
    // no game to return to (see M.CloseMenu()/M.PopMenu() in Menu.ts) -- the player should land
    // back on the main menu instead of an empty screen.
    withMockQuitRegistry(({ quitCalled }) => {
      const page = new QuitDialogPage();

      assert.equal(page.handleInput(110), true); // 'n'

      assert.equal(quitCalled(), false);
      assert.equal(registry.Key.destination, KeyDestination.menu);
      assert.equal(M.menuStack.current()?.title, 'Main');
    }, { state: clientConnectionState.disconnected });
  });

  void test('clicking "No" also collapses back to the main page while disconnected', () => {
    withMockQuitRegistry(({ quitCalled }) => {
      const page = new QuitDialogPage();

      M.mouseX = 168; // QuitDialogPage's #noX
      M.mouseY = 116;

      assert.equal(page.handleInput(K.MOUSE1), true);

      assert.equal(quitCalled(), false);
      assert.equal(registry.Key.destination, KeyDestination.menu);
      assert.equal(M.menuStack.current()?.title, 'Main');
    }, { state: clientConnectionState.disconnected });
  });

  void test('getBackButtonAnchor centers under the taller box (5 lines, for the Yes/No row)', () => {
    withMockQuitRegistry(() => {
      const page = new QuitDialogPage();

      // Box: x=56, width=24 units (total 16 + 24*8 = 208px) -> centerX = 56 + 104 = 160.
      // Box: y=76, 5 content lines -> height (5+2)*8=56 -> bottom=132 -> anchor y = 132+8=140.
      assert.deepEqual(page.getBackButtonAnchor(), { centerX: 160, y: 140 });
    });
  });
});
