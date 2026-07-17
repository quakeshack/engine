import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
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

      Key.destination = KeyDestination.console;
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
   * Temporarily installs mock `Key`/`S` registry stubs so M.Keydown's back-button click path
   * can run without a real audio backend, and so M.MouseMove() (used to flip the internal
   * "mouse was just used" flag the button's visibility/hit-testing depends on) doesn't need a
   * real client destination.
   * @param {(sounds: string[]) => void} callback test callback
   */
  function withMockSoundRegistry(callback) {
    const previousKey = registry.Key;
    const previousS = registry.S;
    const sounds = [];

    registry.Key = { destination: KeyDestination.menu };
    registry.S = { LocalSound(sfx) { sounds.push(sfx); } };
    eventBus.publish('registry.frozen');

    try {
      callback(sounds);
    } finally {
      registry.Key = previousKey;
      registry.S = previousS;
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
