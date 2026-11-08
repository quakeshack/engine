import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import { clientStaticState } from '../../source/engine/client/ClientState.ts';
import FrameBenchmark from '../../source/engine/client/FrameBenchmark.ts';
import FrameProfiler from '../../source/engine/client/FrameProfiler.ts';
import Sys from '../../source/engine/client/Sys.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Con from '../../source/engine/common/Console.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import { patchMembers } from '../support/clientState.ts';

/** The frames every variant waits before measuring; FrameBenchmark's SETTLE_FRAMES. */
const SETTLE_FRAMES = 30;

void describe('FrameBenchmark', () => {
  const created: Cvar[] = [];
  const restores: Array<() => void> = [];
  let now = 0;

  /**
   * Makes a cvar for the test, freed afterwards.
   * @param name The name.
   * @param value The value it starts with.
   * @returns The cvar.
   */
  function cvar(name: string, value: string): Cvar {
    const variable = new Cvar(name, value);
    created.push(variable);
    return variable;
  }

  /**
   * Runs drawn frames the way the screen does, with the bench stepped in front of each.
   * @param count How many.
   * @param each Called inside every frame, after the bench stepped.
   */
  function drawFrames(count: number, each: () => void = () => {}): void {
    for (let i = 0; i < count; i++) {
      FrameBenchmark.Frame();
      FrameProfiler.beginFrame();
      each();
      now += 10;
      FrameProfiler.endFrame();
    }
  }

  beforeEach(() => {
    now = 0;
    restores.push(patchMembers(rendererCvars, { speeds: cvar('r_speeds', '0') }));
    restores.push(patchMembers(clientStaticState, { signon: 4 }));
    mock.method(Sys, 'FloatMilliTime', () => now);
    mock.method(Con, 'Print', () => {});
    mock.method(Con, 'PrintWarning', () => {});
    // no GL context: the profiler measures the CPU only
    FrameProfiler.attach({ getExtension: () => null } as unknown as WebGL2RenderingContext);
  });

  afterEach(() => {
    if (FrameBenchmark.running) {
      FrameBenchmark.Bench_f('stop');
    }

    rendererCvars.speeds.set(0);
    FrameProfiler.beginFrame();
    FrameProfiler.detach();
    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }
    restores.length = 0;

    for (const variable of created) {
      variable.free();
    }
    created.length = 0;
  });

  void describe('a run', () => {
    void test('gives each variant only its own change and puts everything back at the end', () => {
      const shadows = cvar('bench_test_shadows', '1');
      const bloom = cvar('bench_test_bloom', '2');
      const seen = new Set<string>();

      FrameBenchmark.Bench_f('10', '1', 'bench_test_shadows', 'bench_test_bloom');

      // as set, shadows 0, bloom 0, both 0
      // the frame after the last one is where the run ends, with the settings put back
      drawFrames(4 * (SETTLE_FRAMES + 10) + 1, () => {
        if (FrameBenchmark.running) {
          seen.add(`${shadows.string}/${bloom.string}/${rendererCvars.speeds.string}`);
        }
      });

      assert.equal(FrameBenchmark.running, false);
      assert.deepEqual(FrameBenchmark.results.map((result) => result.label), ['as set', 'bench_test_shadows 0', 'bench_test_bloom 0', 'all of them 0']);
      assert.deepEqual([...seen].sort(), ['0/0/1', '0/2/1', '1/0/1', '1/2/1']);
      assert.equal(shadows.string, '1');
      assert.equal(bloom.string, '2');
      assert.equal(rendererCvars.speeds.string, '0');
    });

    void test('measures exactly the frames it was asked for, after the settling ones', () => {
      cvar('bench_test_shadows', '1');
      // a frame of 10 ms, and one of 50 ms while settling that must not be the worst of the measured ones
      let frame = 0;

      FrameBenchmark.Bench_f('10', '1', 'bench_test_shadows');
      drawFrames(2 * (SETTLE_FRAMES + 10) + 1, () => {
        frame++;
        if (frame === 5) {
          now += 40;
        }
      });

      assert.equal(FrameBenchmark.results.length, 2);
      assert.equal(FrameProfiler.summary.frames, 10);

      for (const result of FrameBenchmark.results) {
        assert.equal(result.frameMs, 10);
        assert.equal(result.maxFrameMs, 10);
      }
    });

    void test('puts the settings back when the game ends in the middle of it', () => {
      const shadows = cvar('bench_test_shadows', '1');

      FrameBenchmark.Bench_f('10', '1', 'bench_test_shadows');
      drawFrames(SETTLE_FRAMES + 10 + 5);
      assert.equal(shadows.string, '0');

      clientStaticState.signon = 0;
      FrameBenchmark.Frame();

      assert.equal(FrameBenchmark.running, false);
      assert.equal(shadows.string, '1');
      assert.equal(rendererCvars.speeds.string, '0');
      assert.deepEqual(FrameBenchmark.results.map((result) => result.label), ['as set']);
    });
  });

  void describe('the variants', () => {
    void test('leave out a cvar that is off already, and make no "all of them" row for one change', () => {
      cvar('bench_test_shadows', '1');
      cvar('bench_test_bloom', '0');

      FrameBenchmark.Bench_f('10', '1', 'bench_test_shadows', 'bench_test_bloom');
      drawFrames(2 * (SETTLE_FRAMES + 10) + 1);

      assert.deepEqual(FrameBenchmark.results.map((result) => result.label), ['as set', 'bench_test_shadows 0']);
    });

    void test('are refused for a name that is no cvar, so a typo does not measure the same thing twice', () => {
      FrameBenchmark.Bench_f('10', '1', 'bench_test_nothing');

      assert.equal(FrameBenchmark.running, false);
    });
  });

  void describe('rounds', () => {
    void test('measures the variants one after the other in every round, so a drift hits each alike', () => {
      cvar('bench_test_shadows', '1');

      FrameBenchmark.Bench_f('10', '2', 'bench_test_shadows');
      drawFrames(4 * (SETTLE_FRAMES + 10) + 1);

      assert.deepEqual(FrameBenchmark.results.map((result) => result.label), ['as set', 'bench_test_shadows 0', 'as set', 'bench_test_shadows 0']);
    });

  });
});
