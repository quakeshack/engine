import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { clientConnectionState } from '../../source/engine/common/Def.ts';
import IN, {
  createMobileInputSupportState,
  markKeyboardActivity,
  markMouseActivity,
  refreshMobileInputSupportState,
  shouldShowMobileExternalInputWarning,
} from '../../source/engine/client/IN.ts';
import { KeyDestination } from '../../source/engine/client/Key.ts';
import VID from '../../source/engine/client/VID.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Temporarily installs a global `document` stub with a settable `pointerLockElement`, since
 * IN.onclick reads it directly rather than through the registry.
 * @param {unknown} pointerLockElement
 * @param {() => void} callback test callback
 */
function withMockDocument(pointerLockElement, callback) {
  const previousDocument = globalThis.document;
  globalThis.document = { pointerLockElement };

  try {
    callback();
  } finally {
    globalThis.document = previousDocument;
  }
}

/**
 * Create a minimal matchMedia mock from explicit query results.
 * @param {Record<string, boolean>} matchesByQuery
 * @returns {(query: string) => { matches: boolean }} Mock matchMedia function.
 */
function createMatchMedia(matchesByQuery) {
  return function matchMedia(query) {
    return {
      matches: matchesByQuery[query] ?? false,
    };
  };
}

void describe('IN mobile external input warning', () => {
  void test('shows the warning on touch-only mobile devices', () => {
    const state = createMobileInputSupportState({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      userAgentDataMobile: true,
      maxTouchPoints: 5,
      matchMedia: createMatchMedia({
        '(any-pointer: coarse)': true,
        '(pointer: coarse)': true,
      }),
    });

    assert.equal(shouldShowMobileExternalInputWarning(state), true);
  });

  void test('keeps the warning hidden on touch-enabled non-mobile devices', () => {
    const state = createMobileInputSupportState({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      userAgentDataMobile: false,
      maxTouchPoints: 10,
      matchMedia: createMatchMedia({
        '(any-pointer: coarse)': true,
        '(pointer: coarse)': true,
      }),
    });

    assert.equal(shouldShowMobileExternalInputWarning(state), false);
  });

  void test('requires both keyboard activity and mouse support before hiding the warning', () => {
    const touchOnlyEnvironment = {
      userAgent: 'Mozilla/5.0 (Android 15; Mobile)',
      userAgentDataMobile: true,
      maxTouchPoints: 5,
      matchMedia: createMatchMedia({
        '(any-pointer: coarse)': true,
        '(pointer: coarse)': true,
      }),
    };
    const mouseAttachedEnvironment = {
      ...touchOnlyEnvironment,
      matchMedia: createMatchMedia({
        '(any-pointer: coarse)': true,
        '(pointer: coarse)': true,
        '(any-pointer: fine)': true,
      }),
    };

    let state = createMobileInputSupportState(touchOnlyEnvironment);

    assert.equal(shouldShowMobileExternalInputWarning(state), true);

    state = markKeyboardActivity(state);

    assert.equal(shouldShowMobileExternalInputWarning(state), true);

    state = refreshMobileInputSupportState(state, mouseAttachedEnvironment);

    assert.equal(shouldShowMobileExternalInputWarning(state), false);
  });

  void test('falls back to actual mouse activity when pointer capabilities do not update yet', () => {
    let state = createMobileInputSupportState({
      userAgent: 'Mozilla/5.0 (Android 15; Mobile)',
      userAgentDataMobile: true,
      maxTouchPoints: 5,
      matchMedia: createMatchMedia({
        '(any-pointer: coarse)': true,
        '(pointer: coarse)': true,
      }),
    });

    state = markKeyboardActivity(state);

    assert.equal(shouldShowMobileExternalInputWarning(state), true);

    state = markMouseActivity(state);

    assert.equal(shouldShowMobileExternalInputWarning(state), false);
  });
});

void describe('IN.onclick', () => {
  /**
   * Temporarily installs mock `Key`/`Con`/`CL` registry stubs (destination, whether the
   * drop-down console is open, and connection state — defaults to connected, matching most of
   * these tests' intent) and a mock `VID.mainwindow.requestPointerLock` that records whether it
   * was called.
   * @param {KeyDestination} destination
   * @param {(wasPointerLockRequested: () => boolean) => void} callback test callback
   * @param {{ consoleOpen?: boolean, connectionState?: number }} [options]
   */
  function withMockClickEnvironment(destination, callback, options = {}) {
    const previousKey = registry.Key;
    const previousCon = registry.Con;
    const previousCL = registry.CL;
    const previousMainwindow = VID.mainwindow;
    let requestedPointerLock = false;

    registry.Key = { destination };
    registry.Con = { isOpen: options.consoleOpen ?? false };
    registry.CL = { cls: { state: options.connectionState ?? clientConnectionState.connected } };
    VID.mainwindow = { requestPointerLock: () => { requestedPointerLock = true; return Promise.resolve(); } };
    eventBus.publish('registry.frozen');

    try {
      callback(() => requestedPointerLock);
    } finally {
      registry.Key = previousKey;
      registry.Con = previousCon;
      registry.CL = previousCL;
      VID.mainwindow = previousMainwindow;
      eventBus.publish('registry.frozen');
    }
  }

  void test('requests pointer lock when clicking the canvas during gameplay', () => {
    withMockClickEnvironment(KeyDestination.game, (wasRequested) => {
      withMockDocument(null, () => {
        IN.onclick();

        assert.equal(wasRequested(), true);
      });
    });
  });

  void test('does not capture the pointer when clicking the canvas to interact with the menu', () => {
    withMockClickEnvironment(KeyDestination.menu, (wasRequested) => {
      withMockDocument(null, () => {
        IN.onclick();

        assert.equal(wasRequested(), false);
      });
    });
  });

  void test('does not capture the pointer while a message prompt is active', () => {
    withMockClickEnvironment(KeyDestination.message, (wasRequested) => {
      withMockDocument(null, () => {
        IN.onclick();

        assert.equal(wasRequested(), false);
      });
    });
  });

  void test('does not capture the pointer while the drop-down console is open over gameplay', () => {
    withMockClickEnvironment(KeyDestination.game, (wasRequested) => {
      withMockDocument(null, () => {
        IN.onclick();

        assert.equal(wasRequested(), false);
      });
    }, { consoleOpen: true });
  });

  void test('does not capture the pointer when destination reads game but no game is actually connected', () => {
    // Regression test: Key.destination now also reads `game` right after closing the menu
    // while disconnected (it no longer falls back to a `console` destination) — clicking that
    // idle backdrop must not lock the mouse to a game that isn't running.
    withMockClickEnvironment(KeyDestination.game, (wasRequested) => {
      withMockDocument(null, () => {
        IN.onclick();

        assert.equal(wasRequested(), false);
      });
    }, { connectionState: clientConnectionState.disconnected });
  });

  void test('does not re-request pointer lock when already locked', () => {
    withMockClickEnvironment(KeyDestination.game, (wasRequested) => {
      withMockDocument(VID.mainwindow, () => {
        IN.onclick();

        assert.equal(wasRequested(), false);
      });
    });
  });
});

void describe('IN.ReleasePointerLock', () => {
  void test('releases the lock when this window holds it', () => {
    withMockDocument(VID.mainwindow, () => {
      let released = false;
      globalThis.document.exitPointerLock = () => { released = true; };

      IN.ReleasePointerLock();

      assert.equal(released, true);
    });
  });

  void test('is a no-op when the lock is not held by this window', () => {
    withMockDocument(null, () => {
      let released = false;
      globalThis.document.exitPointerLock = () => { released = true; };

      IN.ReleasePointerLock();

      assert.equal(released, false);
    });
  });
});
