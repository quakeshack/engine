import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import type { ClientGameInterface } from '../../source/shared/GameInterfaces.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import Host from '../../source/engine/common/Host.ts';
import { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import Chase from '../../source/engine/client/Chase.ts';
import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import ConsoleOverlay from '../../source/engine/client/ConsoleOverlay.ts';
import R from '../../source/engine/client/R.ts';
import SCR from '../../source/engine/client/SCR.ts';
import FirstPersonView from '../../source/engine/client/view/FirstPersonView.ts';
import QuakeColorShifts from '../../source/engine/client/view/QuakeColorShifts.ts';
import ViewmodelMotion from '../../source/engine/client/view/ViewmodelMotion.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import Visibility from '../../source/engine/client/renderer/scene/Visibility.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';

/** Where the player stands in every test; far from the origin so a missing offset shows. */
const PLAYER_ORIGIN = new Vector(100, 200, 300);

/** View height of a standing player. */
const VIEW_HEIGHT = 22;

/** One frame at 10 Hz. */
const FRAME_TIME = 0.1;

/**
 * Builds the entity the view is calculated for.
 * @param num Entity number.
 * @returns The entity, standing at `PLAYER_ORIGIN` with zero angles.
 */
function createEntity(num: number): ClientEdict {
  const entity = new ClientEdict(num);

  entity.origin.set(PLAYER_ORIGIN);
  entity.angles.setTo(0, 0, 0);

  return entity;
}

void describe('FirstPersonView', () => {
  let restores: Array<() => void> = [];
  let player: ClientEdict = createEntity(1);
  let viewent: ClientEdict = createEntity(-1);
  let velocity = new Vector();

  /**
   * Sets a view cvar by its console name.
   * @param name The console name.
   * @param value The new value.
   */
  function setCvar(name: string, value: number): void {
    Cvar._vars[name].set(value);
  }

  beforeEach(() => {
    // registers the view cvars with their defaults, once per process
    if (Cvar._vars.cl_bob === undefined) {
      FirstPersonView.Init();
    }

    player = createEntity(1);
    viewent = createEntity(-1);
    velocity = new Vector();

    // a plain view: no sway, no bob drift, no kick, no offset, no pitch drift, full-size view
    setCvar('v_idlescale', 0);
    setCvar('v_pitchdrift', 0);
    setCvar('scr_ofsx', 0);
    setCvar('scr_ofsy', 0);
    setCvar('scr_ofsz', 0);
    setCvar('cl_bob', 0.02);
    setCvar('cl_bobcycle', 0.6);
    setCvar('cl_bobup', 0.5);
    setCvar('cl_rollspeed', 200);
    setCvar('cl_rollangle', 2);
    setCvar('v_kicktime', 0.5);
    setCvar('v_kickroll', 0.6);
    setCvar('v_kickpitch', 0.6);
    Chase.active = { value: 0 } as Cvar;

    FirstPersonView.dmg_time = 0;
    FirstPersonView.dmg_roll = 0;
    FirstPersonView.dmg_pitch = 0;
    FirstPersonView.oldz = PLAYER_ORIGIN[2];

    restores = [
      patchMembers(Host, { frametime: FRAME_TIME }),
      patchMembers(SCR, { viewsize: { value: 120 } as Cvar }),
      patchMembers(clientRuntimeState, {
        playerentity: player,
        viewent,
        get velocity(): Vector {
          return velocity;
        },
        viewangles: new Vector(),
        viewheight: VIEW_HEIGHT,
        punchangle: new Vector(),
        onground: false,
        time: 100,
        gameAPI: null,
        intermission: 0,
        paused: false,
        maxclients: 1,
      }),
    ];

    Camera.refdef.vieworg.setTo(0, 0, 0);
    Camera.refdef.viewangles.setTo(0, 0, 0);
  });

  afterEach(() => {
    ViewmodelMotion.Reset();
    Chase.active = { value: 0 } as Cvar;

    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }

    FirstPersonView.dmg_time = 0;
    FirstPersonView.oldz = 0;
  });

  void describe('CalcRefdef', () => {
    void test('puts the eye at the player origin plus view height, nudged off the grid by 1/32', () => {
      FirstPersonView.CalcRefdef();

      assertNear(Camera.refdef.vieworg[0], 100.03125);
      assertNear(Camera.refdef.vieworg[1], 200.03125);
      assertNear(Camera.refdef.vieworg[2], 322.03125);
      assertNear(Camera.refdef.viewangles[0], 0);
      assertNear(Camera.refdef.viewangles[1], 0);
      assertNear(Camera.refdef.viewangles[2], 0);
    });

    void test('takes the view angles from the client, not from the player entity', () => {
      clientRuntimeState.viewangles.setTo(10, 90, 0);
      player.angles.setTo(0, 45, 0);

      FirstPersonView.CalcRefdef();

      assertNear(Camera.refdef.viewangles[0], 10);
      assertNear(Camera.refdef.viewangles[1], 90);
    });

    void test('raises the eye by the walking bob, and the weapon takes the first frame as it is', () => {
      // time 0.15 of a 0.6 s cycle is a quarter in: sin(pi * 0.25 / 0.5) = 1, so bob = 100 * 0.02 * (0.3 + 0.7) = 2
      clientRuntimeState.time = 0.15;
      velocity = new Vector(100, 0, 0);

      FirstPersonView.CalcRefdef();

      assertNear(Camera.refdef.vieworg[2], 300 + VIEW_HEIGHT + 2 + 0.03125);

      // the weapon sits at origin + viewheight + forward * bob * 0.4 + bob
      assertNear(viewent.origin[2], 300 + VIEW_HEIGHT + 2, 1e-4);
      assertNear(viewent.origin[0], 100 + 2 * 0.4, 1e-4);
    });

    void test('smooths the weapon bob from the second frame on, at sharpness 72 per second', () => {
      FirstPersonView.CalcRefdef();
      assertNear(viewent.origin[2], 300 + VIEW_HEIGHT, 1e-4);

      clientRuntimeState.time = 0.15;
      velocity = new Vector(100, 0, 0);
      FirstPersonView.CalcRefdef();

      // one 0.1 s frame closes 1 - exp(-7.2) of the way from the previous value (rest) to 2
      const smoothedBob = 2 * (1 - Math.exp(-7.2));
      assertNear(viewent.origin[2], 300 + VIEW_HEIGHT + smoothedBob, 1e-4);
      assertNear(ViewmodelMotion.bob, smoothedBob, 1e-4);
    });

    void test('caps the bob at 4 units up and 7 down', () => {
      clientRuntimeState.time = 0.15;
      velocity = new Vector(10000, 0, 0);

      FirstPersonView.CalcRefdef();

      assertNear(Camera.refdef.vieworg[2], 300 + VIEW_HEIGHT + 4 + 0.03125);
    });

    void test('does not bob with the bob cvar at zero or a cycle outside 0 to 1', () => {
      clientRuntimeState.time = 0.15;
      velocity = new Vector(100, 0, 0);

      setCvar('cl_bob', 0);
      FirstPersonView.CalcRefdef();
      assertNear(Camera.refdef.vieworg[2], 322.03125);

      setCvar('cl_bob', 0.02);
      setCvar('cl_bobcycle', 1);
      FirstPersonView.CalcRefdef();
      assertNear(Camera.refdef.vieworg[2], 322.03125);
    });

    void test('rolls the view into a strafe by cl_rollangle at cl_rollspeed', () => {
      // moving along the player's right at half the roll speed gives half the roll angle
      const { right } = new Vector(0, 0, 0).angleVectors();
      velocity = right.copy().multiply(100);

      FirstPersonView.CalcRefdef();

      assertNear(Camera.refdef.viewangles[2], 1);
    });

    void test('kicks roll and pitch in proportion to the time left of the damage kick, and counts it down', () => {
      FirstPersonView.dmg_time = 0.25;
      FirstPersonView.dmg_roll = 10;
      FirstPersonView.dmg_pitch = 5;

      FirstPersonView.CalcRefdef();

      // 0.25 / kicktime 0.5 of the full kick
      assertNear(Camera.refdef.viewangles[2], 5);
      assertNear(Camera.refdef.viewangles[0], -2.5);
      assertNear(FirstPersonView.dmg_time, 0.15);
    });

    void test('adds the idle sway of each axis and removes it again from the viewmodel angles', () => {
      setCvar('v_idlescale', 1);
      clientRuntimeState.time = Math.PI / 2;

      FirstPersonView.CalcRefdef();

      // pitch: sin(time * 1) * 0.3; yaw: sin(time * 2) * 0.3 is 0; roll: sin(time * 0.5) * 0.1
      const ipitch = Math.sin(Math.PI / 2) * 0.3;
      const iroll = Math.sin(Math.PI / 4) * 0.1;
      assertNear(Camera.refdef.viewangles[0], ipitch, 1e-5);
      assertNear(Camera.refdef.viewangles[2], iroll, 1e-5);
      // the weapon does not sway with the eye
      assertNear(viewent.angles[0], -(Camera.refdef.viewangles[0]) - ipitch, 1e-5);
      assertNear(viewent.angles[2], 0 - iroll, 1e-5);
    });

    void test('applies the scr_ofs offsets along the player axes', () => {
      setCvar('scr_ofsx', 5);
      setCvar('scr_ofsz', 3);

      FirstPersonView.CalcRefdef();

      // zero angles: forward is +x, up is +z
      assertNear(Camera.refdef.vieworg[0], 100.03125 + 5);
      assertNear(Camera.refdef.vieworg[2], 322.03125 + 3);
    });

    void test('keeps the eye within 14 units sideways and from -22 to +30 vertically of the player origin', () => {
      setCvar('scr_ofsx', 100);
      setCvar('scr_ofsy', 100);
      setCvar('scr_ofsz', 100);

      FirstPersonView.CalcRefdef();

      // zero angles: forward is +x, right is -y (Quake's right-handed axes), up is +z
      assertNear(Camera.refdef.vieworg[0], 100 + 14);
      assertNear(Camera.refdef.vieworg[1], 200 - 14);
      assertNear(Camera.refdef.vieworg[2], 300 + 30);

      setCvar('scr_ofsx', -100);
      setCvar('scr_ofsy', -100);
      setCvar('scr_ofsz', -100);

      FirstPersonView.CalcRefdef();

      assertNear(Camera.refdef.vieworg[0], 100 - 14);
      assertNear(Camera.refdef.vieworg[1], 200 + 14);
      assertNear(Camera.refdef.vieworg[2], 300 - 22);
    });

    void test('adds the punch angle after everything that rotates the view', () => {
      clientRuntimeState.punchangle.setTo(1, 2, 3);

      FirstPersonView.CalcRefdef();

      assertNear(Camera.refdef.viewangles[0], 1);
      assertNear(Camera.refdef.viewangles[1], 2);
      assertNear(Camera.refdef.viewangles[2], 3);
    });

    void test('replaces a non-finite player coordinate by zero', () => {
      // written by index: Vector.setTo() would complain about the NaN
      player.origin[0] = Number.NaN;

      FirstPersonView.CalcRefdef();

      assertNear(Camera.refdef.vieworg[0], 0.03125);
      assertNear(Camera.refdef.vieworg[1], 200.03125);
    });

    void test('lands an infinite player coordinate 14 units below zero, because the clamp reads the raw origin', () => {
      player.origin[1] = Number.POSITIVE_INFINITY;

      FirstPersonView.CalcRefdef();

      assertNear(Camera.refdef.vieworg[1], -14);
    });

    void describe('step smoothing', () => {
      void test('lets the eye climb a step at 80 units per second, never more than 12 behind', () => {
        clientRuntimeState.onground = true;
        FirstPersonView.oldz = 280;

        FirstPersonView.CalcRefdef();

        // 280 + 0.1 * 80 = 288 is exactly 12 below the player: the eye is held 12 down
        assertNear(FirstPersonView.oldz, 288);
        assertNear(Camera.refdef.vieworg[2], 322.03125 - 12);
        assertNear(viewent.origin[2], 300 + VIEW_HEIGHT - 12);
      });

      void test('catches up to 12 units behind when the step was higher', () => {
        clientRuntimeState.onground = true;
        FirstPersonView.oldz = 250;

        FirstPersonView.CalcRefdef();

        assertNear(FirstPersonView.oldz, 288);
      });

      void test('holds the eye at 12 behind as soon as it would be more, not only for big steps', () => {
        clientRuntimeState.onground = true;
        // 277 + 8 = 285 is 15 behind
        FirstPersonView.oldz = 277;

        FirstPersonView.CalcRefdef();

        assertNear(FirstPersonView.oldz, 288);
      });

      void test('follows the player exactly while not on the ground', () => {
        clientRuntimeState.onground = false;
        FirstPersonView.oldz = 280;

        FirstPersonView.CalcRefdef();

        assertNear(FirstPersonView.oldz, 300);
        assertNear(Camera.refdef.vieworg[2], 322.03125);
      });
    });

    void describe('viewmodel', () => {
      void test('nudges the weapon up by the view size, 2 at 100, 1 at 90 and 110, a half at 80', () => {
        const expectedNudges: Array<[number, number]> = [[120, 0], [110, 1], [100, 2], [90, 1], [80, 0.5], [70, 0]];

        for (const [viewsize, nudge] of expectedNudges) {
          SCR.viewsize = { value: viewsize } as Cvar;

          FirstPersonView.CalcRefdef();

          assertNear(viewent.origin[2], 300 + VIEW_HEIGHT + nudge, 1e-5);
        }
      });

      void test('shows the model and frame the game asks for and lerps from the previous frame', () => {
        const model = new BaseModel('models/v_axe.mdl');
        player.lerpEndTime = 7;
        player.frameTime = 3;
        clientRuntimeState.gameAPI = {
          viewmodel: { model, frame: 4, visible: true },
          updateRefDef() {},
        } as unknown as ClientGameInterface;

        FirstPersonView.CalcRefdef();

        assert.equal(viewent.model, model);
        assert.equal(viewent.frame, 4);
        assert.equal(viewent.framePrevious, 3);
        assert.equal(viewent.lerpEndTime, 7);
        assert.equal(viewent.frameTime, 3);
      });

      void test('does not lerp frame 0', () => {
        clientRuntimeState.gameAPI = {
          viewmodel: { model: new BaseModel('models/v_axe.mdl'), frame: 0, visible: true },
          updateRefDef() {},
        } as unknown as ClientGameInterface;

        FirstPersonView.CalcRefdef();

        assert.equal(viewent.lerpEndTime, -1);
        assert.equal(viewent.framePrevious, null);
        assert.equal(viewent.frameTime, 0);
      });

      void test('shows nothing without a game viewmodel', () => {
        viewent.model = new BaseModel('models/v_axe.mdl');
        viewent.frame = 5;

        FirstPersonView.CalcRefdef();

        assert.equal(viewent.model, null);
        assert.equal(viewent.frame, 0);
      });
    });

    void describe('hooks', () => {
      void test('lets the game adjust the final refdef, after step smoothing and before the chase camera', () => {
        const calls: string[] = [];
        clientRuntimeState.onground = true;
        FirstPersonView.oldz = 280;
        clientRuntimeState.gameAPI = {
          viewmodel: null,
          updateRefDef(refdef: unknown) {
            assert.equal(refdef, Camera.refdef);
            // step smoothing has already lowered the eye by 12
            assertNear(Camera.refdef.vieworg[2], 322.03125 - 12);
            calls.push('game');
          },
        } as unknown as ClientGameInterface;
        Chase.active = { value: 1 } as Cvar;
        mock.method(Chase, 'Update', () => { calls.push('chase'); });

        FirstPersonView.CalcRefdef();

        assert.deepEqual(calls, ['game', 'chase']);
      });

      void test('drifts the pitch back to the ideal one when v_pitchdrift is on', () => {
        setCvar('v_pitchdrift', 1);
        clientRuntimeState.onground = true;
        clientRuntimeState.nodrift = false;
        clientRuntimeState.pitchvel = 10;
        clientRuntimeState.idealpitch = 0;
        clientRuntimeState.viewangles.setTo(30, 0, 0);

        FirstPersonView.CalcRefdef();

        // 0.1 s at 10 units per second
        assertNear(clientRuntimeState.viewangles[0], 29, 1e-5);
      });
    });
  });

  void describe('CalcIntermissionRefdef', () => {
    void test('looks from the camera entity with a slow sway and hides the weapon', () => {
      clientRuntimeState.time = 0;
      player.angles.setTo(10, 20, 0);
      viewent.model = new BaseModel('models/v_axe.mdl');

      FirstPersonView.CalcIntermissionRefdef();

      assertNear(Camera.refdef.vieworg[0], 100);
      assertNear(Camera.refdef.vieworg[2], 300);
      assertNear(Camera.refdef.viewangles[0], 10);
      assertNear(Camera.refdef.viewangles[1], 20);
      assert.equal(viewent.model, null);
    });
  });

  void describe('PreRenderView', () => {
    let calls: string[] = [];
    let previousForcedup = false;

    beforeEach(() => {
      calls = [];
      previousForcedup = ConsoleOverlay.forcedup;
      ConsoleOverlay.forcedup = false;
      mock.method(R, 'PreRenderScene', () => { calls.push('R.PreRenderScene'); });
      mock.method(Camera, 'UpdateViewVectors', () => { calls.push('Camera.UpdateViewVectors'); });
      mock.method(Visibility, 'UpdateViewLeaf', () => {
        calls.push('Visibility.UpdateViewLeaf');

        return { contents: -1 } as never;
      });
      mock.method(QuakeColorShifts, 'Update', () => { calls.push('QuakeColorShifts.Update'); });
      mock.method(FirstPersonView, 'CalcRefdef', () => { calls.push('FirstPersonView.CalcRefdef'); });
      mock.method(FirstPersonView, 'CalcIntermissionRefdef', () => { calls.push('FirstPersonView.CalcIntermissionRefdef'); });
    });

    afterEach(() => {
      ConsoleOverlay.forcedup = previousForcedup;
    });

    void test('derives the frame from the refdef in the order each step needs', () => {
      SCR.PreRenderView();

      assert.deepEqual(calls, [
        'FirstPersonView.CalcRefdef',
        'Camera.UpdateViewVectors',
        'Visibility.UpdateViewLeaf',
        'QuakeColorShifts.Update',
        'R.PreRenderScene',
      ]);
    });

    void test('does nothing while the console is forced up', () => {
      ConsoleOverlay.forcedup = true;

      SCR.PreRenderView();

      assert.deepEqual(calls, []);
    });

    void test('uses the intermission camera, and keeps the view as it was while paused', () => {
      clientRuntimeState.intermission = 1;
      SCR.PreRenderView();
      assert.equal(calls[0], 'FirstPersonView.CalcIntermissionRefdef');

      calls.length = 0;
      clientRuntimeState.intermission = 0;
      clientRuntimeState.paused = true;
      SCR.PreRenderView();
      assert.equal(calls.includes('FirstPersonView.CalcRefdef'), false);
      assert.equal(calls.includes('Camera.UpdateViewVectors'), true);
    });

    void test('zeroes the scr_ofs offsets in a multiplayer game', () => {
      setCvar('scr_ofsx', 5);
      clientRuntimeState.maxclients = 4;

      SCR.PreRenderView();

      assert.equal(Cvar._vars.scr_ofsx.value, 0);
    });
  });
});
