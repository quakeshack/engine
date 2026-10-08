import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ConsoleOverlay from '../../source/engine/client/ConsoleOverlay.ts';
import { facades } from '../support/facades.ts';

interface ToggleStubs {
  readonly key: { history_line: number; lines: string[] };
  readonly scr: { con_current: number; EndLoadingPlaque(): void };
  /** Whether pointer lock was released. */
  readonly pointerLockReleased: () => boolean;
}

/**
 * Installs the registry stubs `ConsoleOverlay.ToggleConsole_f()` needs: `SCR` (a no-op `EndLoadingPlaque`
 * plus a settable `con_current`, which the overlay must never touch), `Key` (a settable history/lines pair,
 * deliberately without a `destination` field, the toggle must not touch it) and `IN` (a spy for the pointer-lock release).
 * @param callback The test body.
 */
function withToggleRegistry(callback: (stubs: ToggleStubs) => void): void {
  const previous = { SCR: facades.SCR, Key: facades.Key, IN: facades.IN };
  let released = false;
  const key = { history_line: 0, lines: ['a', 'b', 'c'] };
  const scr = { EndLoadingPlaque() {}, con_current: 0 };

  facades.SCR = scr;
  facades.Key = key;
  facades.IN = { ReleasePointerLock() { released = true; } };

  ConsoleOverlay.isOpen = false;
  ConsoleOverlay.forcedup = false;

  try {
    // The stubs are patched onto the real facades, so state the overlay changes is read back from there.
    callback({ key: facades.Key as ToggleStubs['key'], scr: facades.SCR as ToggleStubs['scr'], pointerLockReleased: () => released });
  } finally {
    ConsoleOverlay.isOpen = false;
    ConsoleOverlay.forcedup = false;
    Object.assign(facades, previous);
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

    void test('never touches con_current directly -- SCR.SetUpToDrawConsole() owns its animation', () => {
      withToggleRegistry(({ scr }) => {
        ConsoleOverlay.forcedup = true;
        scr.con_current = 37;

        ConsoleOverlay.ToggleConsole_f();
        assert.equal(scr.con_current, 37, 'unchanged while opening');

        ConsoleOverlay.ToggleConsole_f();
        assert.equal(scr.con_current, 37, 'unchanged while closing');
      });
    });
  });
});
