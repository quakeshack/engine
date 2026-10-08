import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import Key, { KeyDestination } from '../../source/engine/client/Key.ts';
import { MenuViewport } from '../../source/engine/client/menu/MenuViewport.ts';
import { useClientStateOf } from '../support/clientState.ts';
import { engineMocks } from '../support/engineMocks.ts';

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
    const previousKey = engineMocks.Key;
    const previousDestination = Key.destination;

    // M.MouseMove() is a no-op unless the menu is the active input destination -- see the test
    // below -- so this needs a real Key module wired up and explicitly pointed at the menu, even
    // for this otherwise-pure coordinate-math assertion.
    engineMocks.Key = Key;
    Key.destination = KeyDestination.menu;

    try {
      // With VID.width/height at their default (0) test value, DrawPic's cx * 2 + floor(w/2) - 320
      // transform inverts to (canvasX + 320) / 2 / (canvasY + 200) / 2.
      M.MouseMove(320, 200);

      assert.equal(M.mouseX, 320);
      assert.equal(M.mouseY, 200);
    } finally {
      Key.destination = previousDestination;
      engineMocks.Key = previousKey;
    }
  });

  void test('forwards to the current page hover tracking only while the menu is active', () => {
    const previousKey = engineMocks.Key;
    const previousDestination = Key.destination;
    const hovered = [];
    const mockPage = { updateHover(mx, my) { hovered.push([mx, my]); } };

    engineMocks.Key = Key;

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
      engineMocks.Key = previousKey;
    }
  });

  void test('is a no-op entirely -- not just skipping hover -- while the menu is not the active destination', () => {
    const previousKey = engineMocks.Key;
    const previousDestination = Key.destination;

    engineMocks.Key = Key;

    try {
      Key.destination = KeyDestination.menu;
      M.MouseMove(0, 0);
      const [mouseXBefore, mouseYBefore] = [M.mouseX, M.mouseY];

      // A raw mousemove fires continuously during gameplay mouselook too -- M.mouseX/M.mouseY
      // (and the internal "mouse was last used" bookkeeping) must stay untouched rather than
      // resolving a viewport transform for a position nothing will read.
      Key.destination = KeyDestination.game;
      M.MouseMove(999, 999);

      assert.equal(M.mouseX, mouseXBefore);
      assert.equal(M.mouseY, mouseYBefore);
    } finally {
      Key.destination = previousDestination;
      engineMocks.Key = previousKey;
    }
  });
});

void describe('M.withRenderingPage', () => {
  void test('projects through the given page\'s own viewport, not the top of menuStack', () => {
    const previousDraw = engineMocks.Draw;
    const calls = [];

    // A DialogPage (e.g. the quit-confirmation box) stays on top of menuStack for the whole
    // time it draws its backdrop (e.g. a mod's own main menu with a wider, screen-filling
    // viewport) -- M's drawing primitives must resolve against whichever page is actually
    // rendering (see withRenderingPage()), not menuStack.current(), or the backdrop renders
    // at the dialog's coordinates/scale instead of its own.
    const dialogViewport = new MenuViewport({ width: 320, height: 200, fit: 'fixed', scale: 2 });
    const backdropViewport = new MenuViewport({ width: 200, height: 100, fit: 'fixed', scale: 1 });
    const dialogPage = { viewport: dialogViewport };
    const backdropPage = { viewport: backdropViewport };

    engineMocks.Draw = { StringWhite(x, y, str, scale) { calls.push({
      x, y, str, scale,
    }); } };

    try {
      M.menuStack.stack.push(dialogPage);

      M.withRenderingPage(backdropPage, () => { M.Print(10, 10, 'backdrop'); });
      M.Print(10, 10, 'dialog');

      // VID.width/height are 0 in this test environment, so each viewport's origin is
      // `-((width * scale) / 2)`, `-((height * scale) / 2)` -- see MenuViewport.resolve().
      assert.deepEqual(calls, [
        { x: 10 * 1 - 100, y: 10 * 1 - 50, str: 'backdrop', scale: 1 },
        { x: 10 * 2 - 320, y: 10 * 2 - 200, str: 'dialog', scale: 2 },
      ]);
    } finally {
      M.menuStack.stack.pop();
      engineMocks.Draw = previousDraw;
    }
  });
});

void describe('M.AllowsSimulation', () => {
  /**
   * Run a callback with `engineMocks.Key` wired to the real `Key` module (needed since
   * `AllowsSimulation` reads `Key.destination`) and restore its destination afterward.
   * @param {() => void} callback test callback
   */
  function withMockKeyRegistry(callback) {
    const previousKey = engineMocks.Key;
    const previousDestination = Key.destination;

    engineMocks.Key = Key;

    try {
      callback();
    } finally {
      Key.destination = previousDestination;
      engineMocks.Key = previousKey;
    }
  }

  void test('allows simulation during gameplay, regardless of the menu stack', () => {
    withMockKeyRegistry(() => {
      Key.destination = KeyDestination.game;

      assert.equal(M.AllowsSimulation(), true);
    });
  });

  void test('blocks simulation for any other destination (e.g. typing a chat message) when nothing is on the stack', () => {
    withMockKeyRegistry(() => {
      Key.destination = KeyDestination.message;

      assert.equal(M.AllowsSimulation(), false);
    });
  });

  void test('blocks simulation while a menu page is open by default, matching classic pause-on-menu behavior', () => {
    withMockKeyRegistry(() => {
      Key.destination = KeyDestination.menu;
      M.menuStack.stack.push({ pausesGame: true });

      try {
        assert.equal(M.AllowsSimulation(), false);
      } finally {
        M.menuStack.stack.pop();
      }
    });
  });

  void test('allows simulation while a page that opted out (pausesGame: false) is open', () => {
    withMockKeyRegistry(() => {
      Key.destination = KeyDestination.menu;
      M.menuStack.stack.push({ pausesGame: false });

      try {
        assert.equal(M.AllowsSimulation(), true);
      } finally {
        M.menuStack.stack.pop();
      }
    });
  });

  void test('blocks simulation while the menu destination is active but nothing is actually on the stack', () => {
    withMockKeyRegistry(() => {
      Key.destination = KeyDestination.menu;

      assert.equal(M.AllowsSimulation(), false);
    });
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
    const previousKey = engineMocks.Key;
    const previousS = engineMocks.S;
    const previousCL = engineMocks.CL;
    const sounds = [];

    engineMocks.Key = { destination: KeyDestination.menu };
    engineMocks.S = { LocalSound(sfx) { sounds.push(sfx); } };
    engineMocks.CL = { cls: { state: clientConnectionState.connected } };
    const restoreClientState = useClientStateOf(engineMocks.CL);

    try {
      callback(sounds);
    } finally {
      engineMocks.Key = previousKey;
      engineMocks.S = previousS;
      engineMocks.CL = previousCL;
      restoreClientState();
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
      const previousCL = engineMocks.CL;
      const handled = [];
      const mockPage = {
        handleInput(key) { handled.push(key); return true; },
        getBackButtonAnchor: () => null,
        updateHover() {},
      };

      engineMocks.CL = { cls: { state: clientConnectionState.disconnected } };

      const restoreClientState = useClientStateOf(engineMocks.CL);

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
        engineMocks.CL = previousCL;
        restoreClientState();
      }
    });
  });

  void test('still shows "< Back" one level deep even while disconnected', () => {
    withMockSoundRegistry((sounds) => {
      const previousMouseX = M.mouseX;
      const previousMouseY = M.mouseY;
      const previousCL = engineMocks.CL;
      const handled = [];
      const mockPage = {
        handleInput(key) { handled.push(key); return true; },
        getBackButtonAnchor: () => null,
        updateHover() {},
      };

      engineMocks.CL = { cls: { state: clientConnectionState.disconnected } };

      const restoreClientState = useClientStateOf(engineMocks.CL);

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
        engineMocks.CL = previousCL;
        restoreClientState();
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
    const previousCL = engineMocks.CL;
    const previousKey = engineMocks.Key;
    const previousIN = engineMocks.IN;
    const previousM = engineMocks.M;
    const previousStack = [...M.menuStack.stack];
    const previousPages = new Map(M.menuStack.pages);
    const mainPage = createMockPage('Main');

    engineMocks.CL = { cls: { state } };

    const restoreClientState = useClientStateOf(engineMocks.CL);
    engineMocks.Key = { destination: KeyDestination.menu };
    engineMocks.IN = { ReleasePointerLock() {} };
    engineMocks.M = M; // MenuStack.push() sets M.entersound directly on the real registry entry.
    M.menuStack.stack.length = 0;
    M.menuStack.register('main', mainPage);
    M.menuStack.setRootPage('main');

    try {
      callback({ mainPage });
    } finally {
      engineMocks.CL = previousCL;
      restoreClientState();
      engineMocks.Key = previousKey;
      engineMocks.IN = previousIN;
      engineMocks.M = previousM;
      M.menuStack.stack.length = 0;
      M.menuStack.stack.push(...previousStack);
      M.menuStack.pages.clear();
      for (const [name, page] of previousPages) {
        M.menuStack.pages.set(name, page);
      }
    }
  }

  void test('CloseMenu collapses to the main page instead of exiting while disconnected', () => {
    withMockDisconnectedRegistry(clientConnectionState.disconnected, ({ mainPage }) => {
      M.menuStack.stack.push(createMockPage('Options'));

      M.CloseMenu();

      assert.equal(M.menuStack.current(), mainPage);
      assert.equal(engineMocks.Key.destination, KeyDestination.menu);
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
      assert.equal(engineMocks.Key.destination, KeyDestination.game);
    });
  });

  void test('PopMenu falls back to the main page instead of the game when popping the last page while disconnected', () => {
    withMockDisconnectedRegistry(clientConnectionState.disconnected, ({ mainPage }) => {
      M.menuStack.stack.push(createMockPage('Alert'));

      M.PopMenu();

      assert.equal(M.menuStack.current(), mainPage);
      assert.equal(engineMocks.Key.destination, KeyDestination.menu);
    });
  });

  void test('PopMenu falls back to the game when popping the last page while connected', () => {
    withMockDisconnectedRegistry(clientConnectionState.connected, () => {
      M.menuStack.stack.push(createMockPage('Alert'));

      M.PopMenu();

      assert.equal(M.menuStack.isEmpty(), true);
      assert.equal(engineMocks.Key.destination, KeyDestination.game);
    });
  });
});

void describe('M.Init: reopening the menu on an involuntary disconnect', () => {
  void test('reopens the main menu when nothing is showing and the client disconnects', () => {
    const previousStack = [...M.menuStack.stack];
    const previousPages = new Map(M.menuStack.pages);
    const previousKey = engineMocks.Key;
    const previousCL = engineMocks.CL;
    const previousIN = engineMocks.IN;
    const previousM = engineMocks.M;
    const mainPage = { title: 'Main', activate() {}, deactivate() {}, updateHover() {}, handleInput() { return false; }, getBackButtonAnchor: () => null };

    engineMocks.Key = { destination: KeyDestination.game };
    engineMocks.CL = { cls: { connecting: null } };
    const restoreClientState = useClientStateOf(engineMocks.CL);
    engineMocks.IN = { ReleasePointerLock() {} };
    engineMocks.M = M;
    M.menuStack.stack.length = 0;
    M.menuStack.register('main', mainPage);
    M.menuStack.setRootPage('main');

    try {
      eventBus.publish('client.disconnected');

      assert.equal(M.menuStack.current(), mainPage);
      assert.equal(engineMocks.Key.destination, KeyDestination.menu);
    } finally {
      engineMocks.Key = previousKey;
      engineMocks.CL = previousCL;
      restoreClientState();
      engineMocks.IN = previousIN;
      engineMocks.M = previousM;
      M.menuStack.stack.length = 0;
      M.menuStack.stack.push(...previousStack);
      M.menuStack.pages.clear();
      for (const [name, page] of previousPages) {
        M.menuStack.pages.set(name, page);
      }
    }
  });

  void test('does not touch an already-open menu on disconnect', () => {
    const previousStack = [...M.menuStack.stack];
    const previousKey = engineMocks.Key;
    const previousCL = engineMocks.CL;
    const previousIN = engineMocks.IN;
    const previousM = engineMocks.M;
    const openPage = { title: 'Options', activate() {}, deactivate() {}, updateHover() {}, handleInput() { return false; }, getBackButtonAnchor: () => null };

    engineMocks.Key = { destination: KeyDestination.menu };
    engineMocks.CL = { cls: { connecting: null } };
    const restoreClientState = useClientStateOf(engineMocks.CL);
    engineMocks.IN = { ReleasePointerLock() {} };
    engineMocks.M = M;
    M.menuStack.stack.length = 0;
    M.menuStack.stack.push(openPage);

    try {
      eventBus.publish('client.disconnected');

      assert.equal(M.menuStack.current(), openPage);
    } finally {
      engineMocks.Key = previousKey;
      engineMocks.CL = previousCL;
      restoreClientState();
      engineMocks.IN = previousIN;
      engineMocks.M = previousM;
      M.menuStack.stack.length = 0;
      M.menuStack.stack.push(...previousStack);
    }
  });
});

void describe('M.Init: showing the main menu on cold boot', () => {
  void test('opens the main menu once the game module has initialized, if disconnected and nothing is showing', () => {
    const previousStack = [...M.menuStack.stack];
    const previousPages = new Map(M.menuStack.pages);
    const previousKey = engineMocks.Key;
    const previousCL = engineMocks.CL;
    const previousIN = engineMocks.IN;
    const previousM = engineMocks.M;
    const mainPage = { title: 'Main', activate() {}, deactivate() {}, updateHover() {}, handleInput() { return false; }, getBackButtonAnchor: () => null };

    engineMocks.Key = { destination: KeyDestination.game };
    engineMocks.CL = { cls: { state: clientConnectionState.disconnected, connecting: null } };
    const restoreClientState = useClientStateOf(engineMocks.CL);
    engineMocks.IN = { ReleasePointerLock() {} };
    engineMocks.M = M;
    M.menuStack.stack.length = 0;
    M.menuStack.register('main', mainPage);
    M.menuStack.setRootPage('main');

    try {
      eventBus.publish('client.game-initialized');

      assert.equal(M.menuStack.current(), mainPage);
      assert.equal(engineMocks.Key.destination, KeyDestination.menu);
    } finally {
      engineMocks.Key = previousKey;
      engineMocks.CL = previousCL;
      restoreClientState();
      engineMocks.IN = previousIN;
      engineMocks.M = previousM;
      M.menuStack.stack.length = 0;
      M.menuStack.stack.push(...previousStack);
      M.menuStack.pages.clear();
      for (const [name, page] of previousPages) {
        M.menuStack.pages.set(name, page);
      }
    }
  });

  void test('does not touch an already-open menu', () => {
    const previousStack = [...M.menuStack.stack];
    const previousKey = engineMocks.Key;
    const previousCL = engineMocks.CL;
    const previousIN = engineMocks.IN;
    const previousM = engineMocks.M;
    const openPage = { title: 'Options', activate() {}, deactivate() {}, updateHover() {}, handleInput() { return false; }, getBackButtonAnchor: () => null };

    engineMocks.Key = { destination: KeyDestination.menu };
    engineMocks.CL = { cls: { state: clientConnectionState.disconnected, connecting: null } };
    const restoreClientState = useClientStateOf(engineMocks.CL);
    engineMocks.IN = { ReleasePointerLock() {} };
    engineMocks.M = M;
    M.menuStack.stack.length = 0;
    M.menuStack.stack.push(openPage);

    try {
      eventBus.publish('client.game-initialized');

      assert.equal(M.menuStack.current(), openPage);
    } finally {
      engineMocks.Key = previousKey;
      engineMocks.CL = previousCL;
      restoreClientState();
      engineMocks.IN = previousIN;
      engineMocks.M = previousM;
      M.menuStack.stack.length = 0;
      M.menuStack.stack.push(...previousStack);
    }
  });

  void test('does nothing if a connection is already active or in progress by the time it fires', () => {
    const previousStack = [...M.menuStack.stack];
    const previousPages = new Map(M.menuStack.pages);
    const previousKey = engineMocks.Key;
    const previousCL = engineMocks.CL;
    const previousIN = engineMocks.IN;
    const previousM = engineMocks.M;
    const mainPage = { title: 'Main', activate() {}, deactivate() {}, updateHover() {}, handleInput() { return false; }, getBackButtonAnchor: () => null };

    engineMocks.Key = { destination: KeyDestination.game };
    engineMocks.CL = { cls: { state: clientConnectionState.connected, connecting: null } };
    const restoreClientState = useClientStateOf(engineMocks.CL);
    engineMocks.IN = { ReleasePointerLock() {} };
    engineMocks.M = M;
    M.menuStack.stack.length = 0;
    M.menuStack.register('main', mainPage);
    M.menuStack.setRootPage('main');

    try {
      eventBus.publish('client.game-initialized');

      assert.equal(M.menuStack.isEmpty(), true);
      assert.equal(engineMocks.Key.destination, KeyDestination.game);
    } finally {
      engineMocks.Key = previousKey;
      engineMocks.CL = previousCL;
      restoreClientState();
      engineMocks.IN = previousIN;
      engineMocks.M = previousM;
      M.menuStack.stack.length = 0;
      M.menuStack.stack.push(...previousStack);
      M.menuStack.pages.clear();
      for (const [name, page] of previousPages) {
        M.menuStack.pages.set(name, page);
      }
    }
  });
});

void describe('M.Init: closing the menu when a connection attempt starts', () => {
  void test('force-closes a single open menu page', () => {
    const previousStack = [...M.menuStack.stack];
    const previousKey = engineMocks.Key;
    const previousCL = engineMocks.CL;
    const previousM = engineMocks.M;
    const openPage = { title: 'Main', activate() {}, deactivate() {}, updateHover() {}, handleInput() { return false; }, getBackButtonAnchor: () => null };

    engineMocks.Key = { destination: KeyDestination.menu };
    engineMocks.CL = { cls: { demonum: -1 } };
    const restoreClientState = useClientStateOf(engineMocks.CL);
    engineMocks.M = M;
    M.menuStack.stack.length = 0;
    M.menuStack.stack.push(openPage);

    try {
      eventBus.publish('client.connecting', 'webrtc://some-session');

      assert.equal(M.menuStack.isEmpty(), true);
      assert.equal(engineMocks.Key.destination, KeyDestination.game);
    } finally {
      engineMocks.Key = previousKey;
      engineMocks.CL = previousCL;
      restoreClientState();
      engineMocks.M = previousM;
      M.menuStack.stack.length = 0;
      M.menuStack.stack.push(...previousStack);
    }
  });

  void test('force-closes every page on the stack, not just the top one (e.g. a profile gate pushed over the main menu)', () => {
    const previousStack = [...M.menuStack.stack];
    const previousKey = engineMocks.Key;
    const previousCL = engineMocks.CL;
    const previousM = engineMocks.M;
    const mainPage = { title: 'Main', activate() {}, deactivate() {}, updateHover() {}, handleInput() { return false; }, getBackButtonAnchor: () => null };
    const gatePage = { title: 'Profile', activate() {}, deactivate() {}, updateHover() {}, handleInput() { return false; }, getBackButtonAnchor: () => null };

    engineMocks.Key = { destination: KeyDestination.menu };
    engineMocks.CL = { cls: { demonum: -1 } };
    const restoreClientState = useClientStateOf(engineMocks.CL);
    engineMocks.M = M;
    M.menuStack.stack.length = 0;
    M.menuStack.stack.push(mainPage, gatePage);

    try {
      eventBus.publish('client.connecting', 'local');

      assert.equal(M.menuStack.isEmpty(), true);
      assert.equal(engineMocks.Key.destination, KeyDestination.game);
    } finally {
      engineMocks.Key = previousKey;
      engineMocks.CL = previousCL;
      restoreClientState();
      engineMocks.M = previousM;
      M.menuStack.stack.length = 0;
      M.menuStack.stack.push(...previousStack);
    }
  });

  void test('does nothing when no menu is open', () => {
    const previousStack = [...M.menuStack.stack];
    const previousKey = engineMocks.Key;
    const previousCL = engineMocks.CL;
    const previousM = engineMocks.M;

    engineMocks.Key = { destination: KeyDestination.game };
    engineMocks.CL = { cls: { demonum: -1 } };
    const restoreClientState = useClientStateOf(engineMocks.CL);
    engineMocks.M = M;
    M.menuStack.stack.length = 0;

    try {
      eventBus.publish('client.connecting', 'local');

      assert.equal(M.menuStack.isEmpty(), true);
      assert.equal(engineMocks.Key.destination, KeyDestination.game);
    } finally {
      engineMocks.Key = previousKey;
      engineMocks.CL = previousCL;
      restoreClientState();
      engineMocks.M = previousM;
      M.menuStack.stack.length = 0;
      M.menuStack.stack.push(...previousStack);
    }
  });
});
