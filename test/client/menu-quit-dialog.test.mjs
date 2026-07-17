import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
import { KeyDestination } from '../../source/engine/client/Key.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import { default as M, QuitDialogPage } from '../../source/engine/client/Menu.ts';

/**
 * Installs the minimal registry stubs QuitDialogPage's Yes/No handling needs: `CL` (so
 * M.PopMenu()'s fallback destination logic can run), `Key` (a settable destination, mutated
 * directly by both the dialog and M.PopMenu()), and `Host` (Quit_f, recorded rather than
 * actually exiting the process).
 * @param {(context: { quitCalled: () => boolean }) => void} callback test callback
 */
function withMockQuitRegistry(callback) {
  const previousCL = registry.CL;
  const previousKey = registry.Key;
  const previousHost = registry.Host;
  const previousStack = [...M.menuStack.stack];
  let quitCalled = false;

  registry.CL = { cls: { state: clientConnectionState.disconnected } };
  registry.Key = { destination: KeyDestination.menu };
  registry.Host = { realtime: 0, Quit_f: () => { quitCalled = true; } };
  M.menuStack.stack.length = 0;
  eventBus.publish('registry.frozen');

  try {
    callback({ quitCalled: () => quitCalled });
  } finally {
    registry.CL = previousCL;
    registry.Key = previousKey;
    registry.Host = previousHost;
    M.menuStack.stack.length = 0;
    M.menuStack.stack.push(...previousStack);
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
      assert.equal(registry.Key.destination, KeyDestination.console);
    });
  });

  void test('clicking "Yes" confirms the quit, same as pressing Y', () => {
    withMockQuitRegistry(({ quitCalled }) => {
      const page = new QuitDialogPage();

      M.mouseX = 88; // QuitDialogPage's #yesX
      M.mouseY = 116; // QuitDialogPage's #promptY

      assert.equal(page.handleInput(K.MOUSE1), true);
      assert.equal(quitCalled(), true);
      assert.equal(registry.Key.destination, KeyDestination.console);
    });
  });

  void test('clicking "No" cancels, same as pressing N', () => {
    withMockQuitRegistry(({ quitCalled }) => {
      const page = new QuitDialogPage();

      M.mouseX = 168; // QuitDialogPage's #noX
      M.mouseY = 116;

      assert.equal(page.handleInput(K.MOUSE1), true);
      assert.equal(quitCalled(), false);
      // M.PopMenu() on an already-empty stack falls back to returnToPreviousDestination(),
      // which routes to console since CL.cls.state is disconnected in this test.
      assert.equal(registry.Key.destination, KeyDestination.console);
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

  void test('getBackButtonAnchor centers under the taller box (5 lines, for the Yes/No row)', () => {
    withMockQuitRegistry(() => {
      const page = new QuitDialogPage();

      // Box: x=56, width=24 units (total 16 + 24*8 = 208px) -> centerX = 56 + 104 = 160.
      // Box: y=76, 5 content lines -> height (5+2)*8=56 -> bottom=132 -> anchor y = 132+8=140.
      assert.deepEqual(page.getBackButtonAnchor(), { centerX: 160, y: 140 });
    });
  });
});
