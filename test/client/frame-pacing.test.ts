import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import type Cvar from '../../source/engine/common/Cvar.ts';
import Host from '../../source/engine/common/Host.ts';
import FramePacing from '../../source/engine/client/screen/FramePacing.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';

void describe('FramePacing', () => {
  let restores: Array<() => void> = [];
  let set = mock.fn();

  /**
   * A refresh rate variable that takes the value it is set to, as the real one does.
   * @param value The value it starts with.
   * @returns The variable.
   */
  function createRefreshRate(value: number): Cvar {
    const variable = {
      value,
      set(next: number): void {
        variable.value = next;
        set(next);
      },
    };

    return variable as unknown as Cvar;
  }

  /**
   * Feeds frames that are one frame time apart.
   * @param count How many frames.
   * @param frameTime Milliseconds between two frames.
   * @param start The time of the first frame.
   */
  function run(count: number, frameTime: number, start = 1000): void {
    for (let frame = 0; frame < count; frame++) {
      FramePacing.Record(start + frame * frameTime);
    }
  }

  beforeEach(() => {
    FramePacing.Reset();
    set = mock.fn();
    restores = [
      patchMembers(Host, { framecount: 1000, refreshrate: createRefreshRate(0) }),
    ];
  });

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }

    FramePacing.Reset();
  });

  void describe('FPS', () => {
    void test('is the frame rate over the frames drawn, and 0 before there are two', () => {
      FramePacing.Record(1000);
      assert.equal(FramePacing.FPS, 0);

      FramePacing.Record(1020);
      assertNear(FramePacing.FPS, 50, 1e-9);
    });

    void test('averages over the last 30 frames', () => {
      // 40 frames at 10 ms followed by 30 at 20 ms: only the slow ones count
      run(41, 10);
      run(31, 20, 1400);

      assertNear(FramePacing.FPS, 50, 1e-6);
    });
  });

  void describe('refresh rate', () => {
    void test('is set from a steady frame rate: the next step of 15 up from it', () => {
      // 17 ms is 58.8 FPS, a display of 60 Hz
      run(40, 17);

      assert.deepEqual(set.mock.calls.map((call) => call.arguments), [[60]]);
    });

    void test('stays at 60 for a frame rate that measures a hair above it', () => {
      // 1000 / 16.6666 is 60.0004: the old rounding made that 75
      run(60, 1000 / 60.0004);

      assert.deepEqual(set.mock.calls.map((call) => call.arguments), [[60]]);
    });

    void test('steps up to 75 only once it is clearly above 60, from about 63', () => {
      run(60, 1000 / 62.9);
      assert.deepEqual(set.mock.calls.map((call) => call.arguments), [[60]]);

      set.mock.resetCalls();
      FramePacing.Reset();
      Host.refreshrate = createRefreshRate(0);
      run(60, 1000 / 63.5);
      assert.deepEqual(set.mock.calls.map((call) => call.arguments), [[75]]);
    });

    void test('is not set before the host has drawn enough frames', () => {
      Host.framecount = 100;

      run(60, 17);

      assert.deepEqual(set.mock.calls, []);
    });

    void test('is not set from a single window, the pick has to hold for a window of frames', () => {
      // 30 frames of 60, then 30 of 144: neither pick holds for a window of its own
      run(15, 17);
      run(15, 7, 2000);
      run(15, 17, 3000);

      assert.deepEqual(set.mock.calls, []);
    });

    void test('is left alone once the host has one', () => {
      Host.refreshrate = createRefreshRate(144);

      run(60, 17);

      assert.deepEqual(set.mock.calls, []);
    });
  });
});
