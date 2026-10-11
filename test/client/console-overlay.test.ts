import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type Cvar from '../../source/engine/common/Cvar.ts';
import Host from '../../source/engine/common/Host.ts';
import type { BrushModel } from '../../source/engine/common/model/BSP.ts';
import { clientRuntimeState, clientStaticState } from '../../source/engine/client/ClientState.ts';
import ConsoleOverlay from '../../source/engine/client/ConsoleOverlay.ts';
import { patchMembers } from '../support/clientState.ts';
import { engineMocks } from '../support/engineMocks.ts';

interface ToggleStubs {
  readonly key: { history_line: number; lines: string[] };
  readonly scr: { EndLoadingPlaque(): void };
  /** Whether pointer lock was released. */
  readonly pointerLockReleased: () => boolean;
}

/**
 * Installs the registry stubs `ConsoleOverlay.ToggleConsole_f()` needs: `SCR` (a no-op `EndLoadingPlaque`),
 * `Key` (a settable history/lines pair,
 * deliberately without a `destination` field, the toggle must not touch it) and `IN` (a spy for the pointer-lock release).
 * @param callback The test body.
 */
function withToggleRegistry(callback: (stubs: ToggleStubs) => void): void {
  const previous = { SCR: engineMocks.SCR, Key: engineMocks.Key, IN: engineMocks.IN };
  let released = false;
  const key = { history_line: 0, lines: ['a', 'b', 'c'] };
  const scr = { EndLoadingPlaque() {} };

  engineMocks.SCR = scr;
  engineMocks.Key = key;
  engineMocks.IN = { ReleasePointerLock() { released = true; } };

  ConsoleOverlay.isOpen = false;
  ConsoleOverlay.forcedup = false;

  try {
    // The stubs are patched onto the real facades, so state the overlay changes is read back from there.
    callback({ key: engineMocks.Key as ToggleStubs['key'], scr: engineMocks.SCR as ToggleStubs['scr'], pointerLockReleased: () => released });
  } finally {
    ConsoleOverlay.isOpen = false;
    ConsoleOverlay.forcedup = false;
    Object.assign(engineMocks, previous);
  }
}

void describe('ConsoleOverlay', () => {
  void describe('ToggleConsole_f', () => {
    void test('toggles isOpen on and off', () => {
      withToggleRegistry(() => {
        assert.equal(ConsoleOverlay.isOpen, false);

        ConsoleOverlay.ToggleConsole_f();
        assert.equal(ConsoleOverlay.isOpen, true);

        ConsoleOverlay.ToggleConsole_f();
        assert.equal(ConsoleOverlay.isOpen, false);
      });
    });

    void test('releases pointer lock when opening', () => {
      withToggleRegistry(({ pointerLockReleased }) => {
        ConsoleOverlay.ToggleConsole_f();

        assert.equal(pointerLockReleased(), true);
      });
    });

    void test('resets the input-history cursor to the end when closing, not when opening', () => {
      withToggleRegistry(({ key }) => {
        key.history_line = 0;

        ConsoleOverlay.ToggleConsole_f();
        assert.equal(key.history_line, 0, 'unchanged while opening');

        ConsoleOverlay.ToggleConsole_f();
        assert.equal(key.history_line, key.lines.length, 'reset while closing');
      });
    });

    void test('never touches the slide directly -- Update() owns its animation', () => {
      withToggleRegistry(() => {
        ConsoleOverlay.forcedup = true;
        ConsoleOverlay.current = 37;

        ConsoleOverlay.ToggleConsole_f();
        assert.equal(ConsoleOverlay.current, 37, 'unchanged while opening');

        ConsoleOverlay.ToggleConsole_f();
        assert.equal(ConsoleOverlay.current, 37, 'unchanged while closing');
      });
    });
  });
});

void describe('ConsoleOverlay slide', () => {
  const previousConspeed = ConsoleOverlay.conspeed;
  let restores: Array<() => void> = [];

  /**
   * Puts the client in a connected game or in none.
   * @param connected Whether there is a map and the signon is complete.
   */
  function connect(connected: boolean): void {
    restores.push(
      patchMembers(clientRuntimeState, { worldmodel: connected ? ({} as BrushModel) : null }),
      patchMembers(clientStaticState, { signon: connected ? 4 : 0 }),
    );
  }

  beforeEach(() => {
    ConsoleOverlay.conspeed = { value: 300 } as Cvar;
    ConsoleOverlay.current = 0;
    restores = [
      patchMembers(Host, { frametime: 0.1 }),
      patchMembers(ConsoleOverlay, { forcedup: false, isOpen: false }),
    ];
  });

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }

    ConsoleOverlay.conspeed = previousConspeed;
    ConsoleOverlay.current = 0;
  });

  void describe('Update', () => {
    void test('slides toward 0 when not open, even with no valid connected game (no full-screen pin)', () => {
      // Regression test: the console must never snap to a full-screen pin anymore. While
      // disconnected the main menu is always shown instead (see M.CloseMenu()), and the console
      // itself is never drawn in that state (see IsPassiveBackdrop), so there's no
      // reason for the slide to jump to a "full screen" value.
      connect(false);
      ConsoleOverlay.isOpen = false;
      ConsoleOverlay.current = 100;

      ConsoleOverlay.Update();

      assert.equal(ConsoleOverlay.forcedup, true);
      assert.ok(ConsoleOverlay.current < 100 && ConsoleOverlay.current >= 0, 'animates down toward 0, same as the connected case');
    });

    void test('slides open toward the normal drawer height when forced up and actively toggled open', () => {
      connect(false);
      ConsoleOverlay.isOpen = true;

      ConsoleOverlay.Update();

      assert.equal(ConsoleOverlay.forcedup, true);
      assert.ok(ConsoleOverlay.current > 0 && ConsoleOverlay.current <= 100);
    });

    void test('slides open at the normal drawer height with a valid connected game', () => {
      connect(true);
      ConsoleOverlay.isOpen = true;

      ConsoleOverlay.Update();

      assert.equal(ConsoleOverlay.forcedup, false);
      assert.equal(ConsoleOverlay.current, 30);
    });

    void test('slides closed with a valid connected game, and stops at 0', () => {
      connect(true);
      ConsoleOverlay.current = 20;

      ConsoleOverlay.Update();

      assert.equal(ConsoleOverlay.forcedup, false);
      assert.equal(ConsoleOverlay.current, 0);
    });

    void test('stops at the open height instead of overshooting it', () => {
      connect(true);
      ConsoleOverlay.isOpen = true;
      ConsoleOverlay.current = 95;

      ConsoleOverlay.Update();

      assert.equal(ConsoleOverlay.current, 100);
    });
  });

  void describe('IsPassiveBackdrop', () => {
    void test('true only when forced up and not actively toggled open', () => {
      connect(false);
      ConsoleOverlay.Update();
      ConsoleOverlay.isOpen = false;

      assert.equal(ConsoleOverlay.IsPassiveBackdrop(), true);
    });

    void test('false while actively open, even with no game connected', () => {
      connect(false);
      ConsoleOverlay.Update();
      ConsoleOverlay.isOpen = true;

      assert.equal(ConsoleOverlay.IsPassiveBackdrop(), false);
    });

    void test('false while mid-close-animation with a valid connected game', () => {
      // Regression test: draw-order must keep the drawer on top of the menu for the entire
      // closing slide while connected, not just while the console is still open.
      connect(true);
      ConsoleOverlay.Update();
      ConsoleOverlay.isOpen = false; // just toggled closed, the slide is still animating down

      assert.equal(ConsoleOverlay.IsPassiveBackdrop(), false);
    });
  });

  void describe('Reset', () => {
    void test('puts the console away at once', () => {
      ConsoleOverlay.current = 80;

      ConsoleOverlay.Reset();

      assert.equal(ConsoleOverlay.current, 0);
    });
  });
});
