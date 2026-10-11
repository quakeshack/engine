import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Cvar from '../../source/engine/common/Cvar.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import SCR from '../../source/engine/client/SCR.ts';
import VID from '../../source/engine/client/VID.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';

void describe('SCR.CalcRefdef', () => {
  let restores: Array<() => void> = [];
  let viewsize: Cvar = null!;
  let fov: Cvar = null!;
  const previousCvars = { viewsize: SCR.viewsize, fov: SCR.fov };

  beforeEach(() => {
    // real cvars, because the clamps write back by name
    viewsize = new Cvar('viewsize', '120');
    fov = new Cvar('fov', '90');
    SCR.viewsize = viewsize;
    SCR.fov = fov;
    SCR.hudReservedHeight = 0;

    restores = [
      patchMembers(VID, { width: 640, height: 480 }),
      patchMembers(clientRuntimeState, { intermission: 0 }),
    ];
  });

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }

    delete Cvar._vars.viewsize;
    delete Cvar._vars.fov;
    SCR.viewsize = previousCvars.viewsize;
    SCR.fov = previousCvars.fov;
  });

  void describe('the view size ladder', () => {
    void test('fills the whole screen at 120 and above and reserves no HUD height', () => {
      SCR.CalcRefdef();

      assert.equal(SCR.hudReservedHeight, 0);
      assert.deepEqual({ ...Camera.refdef.vrect }, { x: 0, y: 0, width: 640, height: 480 });
    });

    void test('reserves 24 pixels for the HUD from 110 up to 120', () => {
      viewsize.set(110);

      SCR.CalcRefdef();

      assert.equal(SCR.hudReservedHeight, 24);
      assert.equal(Camera.refdef.vrect.height, 480 - 24);
      assert.equal(Camera.refdef.vrect.y, 0);
    });

    void test('reserves 48 pixels below 110 and keeps the view full width up to 100', () => {
      viewsize.set(100);

      SCR.CalcRefdef();

      assert.equal(SCR.hudReservedHeight, 48);
      assert.equal(Camera.refdef.vrect.width, 640);
      assert.equal(Camera.refdef.vrect.height, 480 - 48);
      assert.equal(Camera.refdef.vrect.y, 0);
    });

    void test('shrinks the view and centers it below 100', () => {
      viewsize.set(50);

      SCR.CalcRefdef();

      assert.equal(Camera.refdef.vrect.width, 320);
      assert.equal(Camera.refdef.vrect.height, 240);
      assert.equal(Camera.refdef.vrect.x, 160);
      // centered in what is left above the 48 pixels of HUD
      assert.equal(Camera.refdef.vrect.y, (480 - 48 - 240) / 2);
    });

    void test('keeps the view at least 96 pixels wide and scales its height with it', () => {
      restores.push(patchMembers(VID, { width: 160, height: 100 }));
      viewsize.set(30);

      SCR.CalcRefdef();

      // 160 * 0.3 = 48 is too narrow: 96 wide is a factor of 2, which would make the view 200 high; it is capped by
      // the height that is left after the HUD
      assert.equal(Camera.refdef.vrect.width, 96);
      assert.equal(Camera.refdef.vrect.height, 100 - 48);
    });

    void test('clamps the viewsize cvar itself to 30 to 120', () => {
      viewsize.set(5);
      SCR.CalcRefdef();
      assert.equal(viewsize.value, 30);

      viewsize.set(500);
      SCR.CalcRefdef();
      assert.equal(viewsize.value, 120);
    });

    void test('uses the whole screen in an intermission whatever the view size is', () => {
      clientRuntimeState.intermission = 1;
      viewsize.set(50);

      SCR.CalcRefdef();

      assert.equal(SCR.hudReservedHeight, 0);
      assert.deepEqual({ ...Camera.refdef.vrect }, { x: 0, y: 0, width: 640, height: 480 });
    });
  });

  void describe('the field of view', () => {
    void test('is the fov cvar horizontally on a screen that is not wider than 4:3', () => {
      // 640x480 is 4:3 exactly: width * 0.75 === height
      SCR.CalcRefdef();

      assertNear(Camera.refdef.fov_x, 90);
      assertNear(Camera.refdef.fov_y, Math.atan(480 / (640 / Math.tan(90 * Math.PI / 360))) * 360 / Math.PI, 1e-9);
    });

    void test('keeps 0.82 of the fov vertically on a wide screen and widens it horizontally', () => {
      restores.push(patchMembers(VID, { width: 1280, height: 480 }));

      SCR.CalcRefdef();

      assertNear(Camera.refdef.fov_y, 90 * 0.82);
      assert.ok(Camera.refdef.fov_x > 90);
    });

    void test('clamps the fov cvar to 10 to 170', () => {
      fov.set(1);
      SCR.CalcRefdef();
      assert.equal(fov.value, 10);

      fov.set(300);
      SCR.CalcRefdef();
      assert.equal(fov.value, 170);
    });

    void test('writes the two scale entries of the projection matrix', () => {
      SCR.CalcRefdef();

      const ymax = 4 * Math.tan(Camera.refdef.fov_y * Math.PI / 360);

      assertNear(Camera.perspective[0], 4 / (ymax * 640 / 480), 1e-9);
      assertNear(Camera.perspective[5], 4 / ymax, 1e-9);
    });

    void test('clears the recalculation request', () => {
      SCR.recalc_refdef = true;

      SCR.CalcRefdef();

      assert.equal(SCR.recalc_refdef, false);
    });
  });
});
