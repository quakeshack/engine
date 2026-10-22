import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import Host from '../../source/engine/common/Host.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import ViewmodelMotion from '../../source/engine/client/view/ViewmodelMotion.ts';
import viewCvars from '../../source/engine/client/view/ViewCvars.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';

void describe('ViewmodelMotion', () => {
  let restores: Array<() => void> = [];
  let velocity = new Vector();

  beforeEach(() => {
    velocity = new Vector();
    viewCvars.bob = { value: 0.02 } as Cvar;
    viewCvars.bobcycle = { value: 0.6 } as Cvar;
    viewCvars.bobup = { value: 0.5 } as Cvar;

    restores = [
      patchMembers(Host, { frametime: 0.1 }),
      patchMembers(clientRuntimeState, {
        time: 0.15,
        get velocity(): Vector {
          return velocity;
        },
      }),
    ];
    ViewmodelMotion.Reset();
  });

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }
  });

  void describe('CalcBob', () => {
    void test('is the horizontal speed times cl_bob, eased by where in the cycle the time is', () => {
      // a quarter into the 0.6 s cycle is the top of the rising half: sin(pi/2) = 1, the full 100 * 0.02
      velocity = new Vector(100, 0, 0);

      assertNear(ViewmodelMotion.CalcBob(), 2);
    });

    void test('only counts the speed along the ground', () => {
      velocity = new Vector(60, 80, 500);

      // hypot(60, 80) = 100
      assertNear(ViewmodelMotion.CalcBob(), 2);
    });

    void test('goes down in the second half of the cycle, and not further than 7 units', () => {
      // three quarters in: sin(pi + pi/2) = -1: 0.3 - 0.7 = -0.4 of the speed term
      clientRuntimeState.time = 0.45;
      velocity = new Vector(100, 0, 0);
      assertNear(ViewmodelMotion.CalcBob(), 2 * (0.3 - 0.7));

      velocity = new Vector(10000, 0, 0);
      assert.equal(ViewmodelMotion.CalcBob(), -7);
    });

    void test('is capped at 4 units up', () => {
      velocity = new Vector(10000, 0, 0);

      assert.equal(ViewmodelMotion.CalcBob(), 4);
    });

    void test('is off when cl_bob is 0 or a cycle value is out of range', () => {
      velocity = new Vector(100, 0, 0);

      viewCvars.bob = { value: 0 } as Cvar;
      assert.equal(ViewmodelMotion.CalcBob(), 0);

      viewCvars.bob = { value: 0.02 } as Cvar;
      viewCvars.bobcycle = { value: 1 } as Cvar;
      assert.equal(ViewmodelMotion.CalcBob(), 0);

      viewCvars.bobcycle = { value: 0.6 } as Cvar;
      viewCvars.bobup = { value: 0 } as Cvar;
      assert.equal(ViewmodelMotion.CalcBob(), 0);
    });
  });

  void describe('ComputeLookBobTargets', () => {
    void test('pushes against the turn, a yaw to the left pushes right', () => {
      const [right, up] = ViewmodelMotion.ComputeLookBobTargets(10, 10);

      assertNear(right, -0.7);
      assertNear(up, 0.5);
    });

    void test('clamps large turns', () => {
      assert.deepEqual(ViewmodelMotion.ComputeLookBobTargets(100, -100), [1.8, 1.2]);
      assert.deepEqual(ViewmodelMotion.ComputeLookBobTargets(-100, 100), [-1.8, -1.2]);
    });
  });

  void describe('Advance', () => {
    void test('takes the first frame as it is', () => {
      ViewmodelMotion.Advance(2, 30, 45);

      assert.equal(ViewmodelMotion.bob, 2);
      assert.equal(ViewmodelMotion.lookBobRight, 0);
      assert.equal(ViewmodelMotion.lookBobUp, 0);
    });

    void test('then eases the bob toward the new value at sharpness 72', () => {
      ViewmodelMotion.Advance(0, 0, 0);

      ViewmodelMotion.Advance(2, 0, 0);

      assertNear(ViewmodelMotion.bob, 2 * (1 - Math.exp(-7.2)), 1e-9);
    });

    void test('then eases the look bob toward the turn of the frame at sharpness 18', () => {
      ViewmodelMotion.Advance(0, 0, 0);

      // 10 degrees of yaw: the target is -0.7, one frame closes 1 - exp(-1.8) of the way
      ViewmodelMotion.Advance(0, 0, 10);

      assertNear(ViewmodelMotion.lookBobRight, -0.7 * (1 - Math.exp(-1.8)), 1e-9);
      assertNear(ViewmodelMotion.lookBobUp, 0, 1e-12);
    });

    void test('takes the short way round a full turn of the yaw', () => {
      ViewmodelMotion.Advance(0, 0, 350);

      ViewmodelMotion.Advance(0, 0, 10);

      // 350 to 10 is +20 degrees, not -340
      assertNear(ViewmodelMotion.lookBobRight, -Math.min(20 * 0.07, 1.8) * (1 - Math.exp(-1.8)), 1e-9);
    });

    void test('lets a still view settle', () => {
      ViewmodelMotion.Advance(0, 0, 0);
      ViewmodelMotion.Advance(0, 0, 30);

      for (let frame = 0; frame < 20; frame++) {
        ViewmodelMotion.Advance(0, 0, 30);
      }

      assertNear(ViewmodelMotion.lookBobRight, 0, 1e-6);
    });
  });

  void describe('Reset', () => {
    void test('forgets the motion, so the next frame is taken as it is again', () => {
      ViewmodelMotion.Advance(2, 0, 0);
      ViewmodelMotion.Advance(4, 0, 90);

      ViewmodelMotion.Reset();

      assert.equal(ViewmodelMotion.bob, 0);
      assert.equal(ViewmodelMotion.lookBobRight, 0);

      ViewmodelMotion.Advance(3, 50, 200);

      assert.equal(ViewmodelMotion.bob, 3);
      assert.equal(ViewmodelMotion.lookBobRight, 0);
    });
  });
});
