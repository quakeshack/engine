import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import Key, { KeyDestination } from '../../source/engine/client/Key.ts';

/**
 * Temporarily install a global value for the duration of a callback.
 * @param {string} name
 * @param {unknown} value
 * @param {() => Promise<unknown>} callback
 * @returns {Promise<unknown>} Result of the callback.
 */
function withGlobalValue(name, value, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);

  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });

  try {
    return Promise.resolve(callback()).finally(() => {
      if (descriptor === undefined) {
        delete globalThis[name];
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    });
  } catch (error) {
    if (descriptor === undefined) {
      delete globalThis[name];
    } else {
      Object.defineProperty(globalThis, name, descriptor);
    }

    throw error;
  }
}

const { default: M } = await withGlobalValue('location', new URL('https://quake.test/play'), async () => import('../../source/engine/client/Menu.ts'));

void describe('Menu overlay notices', () => {
  void test('stores lines and clears by matching id', () => {
    const previousNoticeId = M.overlayNoticeId;
    const previousNoticeLines = M.overlayNoticeLines;

    try {
      M.SetOverlayNotice('mobile-input', 'Line one\nLine two');

      assert.equal(M.overlayNoticeId, 'mobile-input');
      assert.deepEqual(M.overlayNoticeLines, ['Line one', 'Line two']);

      M.ClearOverlayNotice('some-other-notice');

      assert.equal(M.overlayNoticeId, 'mobile-input');
      assert.deepEqual(M.overlayNoticeLines, ['Line one', 'Line two']);

      M.ClearOverlayNotice('mobile-input');

      assert.equal(M.overlayNoticeId, null);
      assert.deepEqual(M.overlayNoticeLines, []);
    } finally {
      M.overlayNoticeId = previousNoticeId;
      M.overlayNoticeLines = previousNoticeLines;
    }
  });
});

void describe('M.MouseMove', () => {
  void test('converts canvas-relative pixels into virtual menu-space coordinates', () => {
    const previousKey = registry.Key;

    // M.MouseMove() always checks Key.destination before forwarding hover updates, so the
    // registry needs a real Key module wired up even for this pure coordinate-math assertion.
    registry.Key = Key;
    eventBus.publish('registry.frozen');

    try {
      // With VID.width/height at their default (0) test value, DrawPic's cx * 2 + floor(w/2) - 320
      // transform inverts to (canvasX + 320) / 2 / (canvasY + 200) / 2.
      M.MouseMove(320, 200);

      assert.equal(M.mouseX, 320);
      assert.equal(M.mouseY, 200);
    } finally {
      registry.Key = previousKey;
      eventBus.publish('registry.frozen');
    }
  });

  void test('forwards to the current page hover tracking only while the menu is active', () => {
    const previousKey = registry.Key;
    const previousDestination = Key.destination;
    const hovered = [];
    const mockPage = { updateHover(mx, my) { hovered.push([mx, my]); } };

    registry.Key = Key;
    eventBus.publish('registry.frozen');

    try {
      M.menuStack.stack.push(mockPage);

      Key.destination = KeyDestination.game;
      M.MouseMove(0, 0);
      assert.deepEqual(hovered, []);

      Key.destination = KeyDestination.menu;
      M.MouseMove(0, 0);
      assert.deepEqual(hovered, [[160, 100]]);
    } finally {
      M.menuStack.stack.pop();
      Key.destination = previousDestination;
      registry.Key = previousKey;
      eventBus.publish('registry.frozen');
    }
  });
});

void describe('M.Keydown back button', () => {
  /**
   * Temporarily installs mock `Key`/`S`/`CL` registry stubs so M.Keydown's back-button click
   * path can run without a real audio backend, so M.MouseMove() (used to flip the internal
   * "mouse was just used" flag the button's visibility/hit-testing depends on) doesn't need a
   * real client destination, and so M.#canShowBackButton()'s connection-state check has
   * something to read (connected by default -- the button is always shown/clickable then,
   * regardless of stack depth).
   * @param {(sounds: string[]) => void} callback test callback
   */
  function withMockSoundRegistry(callback) {
    const previousKey = registry.Key;
    const previousS = registry.S;
    const previousCL = registry.CL;
    const sounds = [];

    registry.Key = { destination: KeyDestination.menu };
    registry.S = { LocalSound(sfx) { sounds.push(sfx); } };
    registry.CL = { cls: { state: clientConnectionState.connected } };
    eventBus.publish('registry.frozen');

    try {
      callback(sounds);
    } finally {
      registry.Key = previousKey;
      registry.S = previousS;
      registry.CL = previousCL;
      eventBus.publish('registry.frozen');
    }
  }

  /**
   * Marks the mouse as the most recently used input (as a real mousemove would), then sets the
   * precise virtual-space position under test.
   * @param {number} mx
   * @param {number} my
   */
  function setMousePosition(mx, my) {
    M.MouseMove(0, 0);
    M.mouseX = mx;
    M.mouseY = my;
  }

  void test('clicking the button synthesizes Escape on the current page instead of MOUSE1', () => {
    withMockSoundRegistry((sounds) => {
      const previousMouseX = M.mouseX;
      const previousMouseY = M.mouseY;
      const handled = [];
      const mockPage = {
        handleInput(key) { handled.push(key); return true; },
        getBackButtonAnchor: () => null,
        updateHover() {},
      };

      try {
        // Two pages on the stack -> depth() > 1 -> '< Back' label, 6 chars wide starting at (8, 224).
        M.menuStack.stack.push({ handleInput() { return true; }, getBackButtonAnchor: () => null, updateHover() {} });
        M.menuStack.stack.push(mockPage);

        setMousePosition(8, 224);

        M.Keydown(K.MOUSE1);

        assert.deepEqual(handled, [K.ESCAPE]);
        assert.deepEqual(sounds, [M.sfx_menu2]);
      } finally {
        M.menuStack.stack.length = 0;
        M.mouseX = previousMouseX;
        M.mouseY = previousMouseY;
      }
    });
  });

  void test('clicking outside the button forwards the raw key to the current page', () => {
    withMockSoundRegistry((sounds) => {
      const previousMouseX = M.mouseX;
      const previousMouseY = M.mouseY;
      const handled = [];
      const mockPage = {
        handleInput(key) { handled.push(key); return true; },
        getBackButtonAnchor: () => null,
        updateHover() {},
      };

      try {
        M.menuStack.stack.push(mockPage);

        setMousePosition(200, 100);

        M.Keydown(K.MOUSE1);

        assert.deepEqual(handled, [K.MOUSE1]);
        assert.deepEqual(sounds, []);
      } finally {
        M.menuStack.stack.length = 0;
        M.mouseX = previousMouseX;
        M.mouseY = previousMouseY;
      }
    });
  });

  void test('the button widens at the root of the stack to fit the "< Close" label', () => {
    withMockSoundRegistry((sounds) => {
      const previousMouseX = M.mouseX;
      const previousMouseY = M.mouseY;
      const handled = [];
      const mockPage = {
        handleInput(key) { handled.push(key); return true; },
        getBackButtonAnchor: () => null,
        updateHover() {},
      };

      try {
        // Single page on the stack -> depth() === 1 -> '< Close' label, 7 chars wide (56px),
        // wider than the 48px '< Back' box used when depth() > 1.
        M.menuStack.stack.push(mockPage);

        setMousePosition(60, 224);

        M.Keydown(K.MOUSE1);

        assert.deepEqual(handled, [K.ESCAPE]);
        assert.deepEqual(sounds, [M.sfx_menu2]);
      } finally {
        M.menuStack.stack.length = 0;
        M.mouseX = previousMouseX;
        M.mouseY = previousMouseY;
      }
    });
  });

  void test('is hidden at the root of the stack while disconnected, since it would close to nothing', () => {
    // Regression test: M.CloseMenu() now refuses to close the menu at all while disconnected
    // (see M.CloseMenu()) -- showing a "< Close" button there that silently does nothing would
    // be confusing, so it should not be clickable (or drawn) in that state.
    withMockSoundRegistry((sounds) => {
      const previousMouseX = M.mouseX;
      const previousMouseY = M.mouseY;
      const previousCL = registry.CL;
      const handled = [];
      const mockPage = {
        handleInput(key) { handled.push(key); return true; },
        getBackButtonAnchor: () => null,
        updateHover() {},
      };

      registry.CL = { cls: { state: clientConnectionState.disconnected } };
      eventBus.publish('registry.frozen');

      try {
        // Same position that hits the '< Close' button in the connected test above.
        M.menuStack.stack.push(mockPage);

        setMousePosition(60, 224);

        M.Keydown(K.MOUSE1);

        // Falls through to the page itself instead of being swallowed by the (hidden) button.
        assert.deepEqual(handled, [K.MOUSE1]);
        assert.deepEqual(sounds, []);
      } finally {
        M.menuStack.stack.length = 0;
        M.mouseX = previousMouseX;
        M.mouseY = previousMouseY;
        registry.CL = previousCL;
        eventBus.publish('registry.frozen');
      }
    });
  });

  void test('still shows "< Back" one level deep even while disconnected', () => {
    withMockSoundRegistry((sounds) => {
      const previousMouseX = M.mouseX;
      const previousMouseY = M.mouseY;
      const previousCL = registry.CL;
      const handled = [];
      const mockPage = {
        handleInput(key) { handled.push(key); return true; },
        getBackButtonAnchor: () => null,
        updateHover() {},
      };

      registry.CL = { cls: { state: clientConnectionState.disconnected } };
      eventBus.publish('registry.frozen');

      try {
        // Two pages on the stack -> depth() > 1 -> '< Back' label, 6 chars wide at (8, 224),
        // still poppable (and thus still shown) regardless of connection state.
        M.menuStack.stack.push({ handleInput() { return true; }, getBackButtonAnchor: () => null, updateHover() {} });
        M.menuStack.stack.push(mockPage);

        setMousePosition(8, 224);

        M.Keydown(K.MOUSE1);

        assert.deepEqual(handled, [K.ESCAPE]);
        assert.deepEqual(sounds, [M.sfx_menu2]);
      } finally {
        M.menuStack.stack.length = 0;
        M.mouseX = previousMouseX;
        M.mouseY = previousMouseY;
        registry.CL = previousCL;
        eventBus.publish('registry.frozen');
      }
    });
  });

  void test('a custom page anchor repositions the button instead of the default corner', () => {
    withMockSoundRegistry((sounds) => {
      const previousMouseX = M.mouseX;
      const previousMouseY = M.mouseY;
      const handled = [];
      // '< Back' is 6 chars (48px wide), so centerX 100 puts its bounds at x=[76,124).
      const mockPage = {
        handleInput(key) { handled.push(key); return true; },
        getBackButtonAnchor: () => ({ centerX: 100, y: 60 }),
        updateHover() {},
      };

      try {
        M.menuStack.stack.push({ handleInput() { return true; }, getBackButtonAnchor: () => null, updateHover() {} });
        M.menuStack.stack.push(mockPage);

        // Well outside the default bottom-left corner, but inside the page's custom anchor.
        setMousePosition(100, 62);

        M.Keydown(K.MOUSE1);

        assert.deepEqual(handled, [K.ESCAPE]);
        assert.deepEqual(sounds, [M.sfx_menu2]);
      } finally {
        M.menuStack.stack.length = 0;
        M.mouseX = previousMouseX;
        M.mouseY = previousMouseY;
      }
    });
  });
});

void describe('M.CloseMenu / M.PopMenu while disconnected', () => {
  /**
   * Creates a bare mock page usable as a MenuStack entry (activate/deactivate/handleInput are
   * all it needs).
   * @param {string} title
   * @returns {{ title: string, activate: () => void, deactivate: () => void, updateHover: () => void, handleInput: () => boolean, getBackButtonAnchor: () => null }} A mock menu page.
   */
  function createMockPage(title) {
    return {
      title,
      activate() {},
      deactivate() {},
      updateHover() {},
      handleInput() { return false; },
      getBackButtonAnchor: () => null,
    };
  }

  /**
   * Installs a disconnected/connected `CL` mock plus a real 'main' page registered as the root
   * on the actual M.menuStack, since M.CloseMenu()/M.PopMenu()'s disconnected fallback
   * collapses back to the root page.
   * @param {import('../../source/engine/common/Def.ts').clientConnectionState} state
   * @param {(context: { mainPage: ReturnType<typeof createMockPage> }) => void} callback test callback
   */
  function withMockDisconnectedRegistry(state, callback) {
    const previousCL = registry.CL;
    const previousKey = registry.Key;
    const previousIN = registry.IN;
    const previousM = registry.M;
    const previousStack = [...M.menuStack.stack];
    const previousPages = new Map(M.menuStack.pages);
    const mainPage = createMockPage('Main');

    registry.CL = { cls: { state } };
    registry.Key = { destination: KeyDestination.menu };
    registry.IN = { ReleasePointerLock() {} };
    registry.M = M; // MenuStack.push() sets M.entersound directly on the real registry entry.
    M.menuStack.stack.length = 0;
    M.menuStack.register('main', mainPage);
    M.menuStack.setRootPage('main');
    eventBus.publish('registry.frozen');

    try {
      callback({ mainPage });
    } finally {
      registry.CL = previousCL;
      registry.Key = previousKey;
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

  void test('CloseMenu collapses to the main page instead of exiting while disconnected', () => {
    withMockDisconnectedRegistry(clientConnectionState.disconnected, ({ mainPage }) => {
      M.menuStack.stack.push(createMockPage('Options'));

      M.CloseMenu();

      assert.equal(M.menuStack.current(), mainPage);
      assert.equal(registry.Key.destination, KeyDestination.menu);
    });
  });

  void test('CloseMenu is a no-op (no re-activation) when already on the main page while disconnected', () => {
    withMockDisconnectedRegistry(clientConnectionState.disconnected, ({ mainPage }) => {
      M.menuStack.stack.push(mainPage);
      let activateCalls = 0;
      mainPage.activate = () => { activateCalls += 1; };

      M.CloseMenu();

      assert.equal(activateCalls, 0);
      assert.equal(M.menuStack.current(), mainPage);
    });
  });

  void test('CloseMenu exits normally while connected', () => {
    withMockDisconnectedRegistry(clientConnectionState.connected, () => {
      M.menuStack.stack.push(createMockPage('Options'));

      M.CloseMenu();

      assert.equal(M.menuStack.isEmpty(), true);
      assert.equal(registry.Key.destination, KeyDestination.game);
    });
  });

  void test('PopMenu falls back to the main page instead of the game when popping the last page while disconnected', () => {
    withMockDisconnectedRegistry(clientConnectionState.disconnected, ({ mainPage }) => {
      M.menuStack.stack.push(createMockPage('Alert'));

      M.PopMenu();

      assert.equal(M.menuStack.current(), mainPage);
      assert.equal(registry.Key.destination, KeyDestination.menu);
    });
  });

  void test('PopMenu falls back to the game when popping the last page while connected', () => {
    withMockDisconnectedRegistry(clientConnectionState.connected, () => {
      M.menuStack.stack.push(createMockPage('Alert'));

      M.PopMenu();

      assert.equal(M.menuStack.isEmpty(), true);
      assert.equal(registry.Key.destination, KeyDestination.game);
    });
  });
});

void describe('M.Init: reopening the menu on an involuntary disconnect', () => {
  void test('reopens the main menu when nothing is showing and the client disconnects', () => {
    const previousStack = [...M.menuStack.stack];
    const previousPages = new Map(M.menuStack.pages);
    const previousKey = registry.Key;
    const previousCL = registry.CL;
    const previousIN = registry.IN;
    const previousM = registry.M;
    const mainPage = { title: 'Main', activate() {}, deactivate() {}, updateHover() {}, handleInput() { return false; }, getBackButtonAnchor: () => null };

    registry.Key = { destination: KeyDestination.game };
    registry.CL = { cls: { connecting: null } };
    registry.IN = { ReleasePointerLock() {} };
    registry.M = M;
    M.menuStack.stack.length = 0;
    M.menuStack.register('main', mainPage);
    M.menuStack.setRootPage('main');
    eventBus.publish('registry.frozen');

    try {
      eventBus.publish('client.disconnected');

      assert.equal(M.menuStack.current(), mainPage);
      assert.equal(registry.Key.destination, KeyDestination.menu);
    } finally {
      registry.Key = previousKey;
      registry.CL = previousCL;
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
  });

  void test('does not touch an already-open menu on disconnect', () => {
    const previousStack = [...M.menuStack.stack];
    const previousKey = registry.Key;
    const previousCL = registry.CL;
    const previousIN = registry.IN;
    const previousM = registry.M;
    const openPage = { title: 'Options', activate() {}, deactivate() {}, updateHover() {}, handleInput() { return false; }, getBackButtonAnchor: () => null };

    registry.Key = { destination: KeyDestination.menu };
    registry.CL = { cls: { connecting: null } };
    registry.IN = { ReleasePointerLock() {} };
    registry.M = M;
    M.menuStack.stack.length = 0;
    M.menuStack.stack.push(openPage);
    eventBus.publish('registry.frozen');

    try {
      eventBus.publish('client.disconnected');

      assert.equal(M.menuStack.current(), openPage);
    } finally {
      registry.Key = previousKey;
      registry.CL = previousCL;
      registry.IN = previousIN;
      registry.M = previousM;
      M.menuStack.stack.length = 0;
      M.menuStack.stack.push(...previousStack);
      eventBus.publish('registry.frozen');
    }
  });
});
