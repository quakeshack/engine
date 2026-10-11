import type { ViewInput, ViewResult } from '../../../shared/GameInterfaces.ts';
import { calcRoll } from '../../../shared/PlayerRoll.ts';
import Vector from '../../../shared/Vector.ts';
import { eventBus } from '../../common/EventBus.ts';
import Host from '../../common/Host.ts';
import Chase from '../Chase.ts';
import { clientRuntimeState } from '../ClientState.ts';
import Camera from '../renderer/scene/Camera.ts';
import PitchDrift from './PitchDrift.ts';
import ViewmodelMotion from './ViewmodelMotion.ts';
import viewCvars from './ViewCvars.ts';

/**
 * Replaces a coordinate that is not a finite number by zero.
 * @param value A coordinate.
 * @returns The coordinate, or zero.
 */
function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0.0;
}

/**
 * The first-person view: where the eye is and where it looks (with the bob, the roll into a strafe, the kick of a
 * hit, the idle sway and the smoothing of steps), and where the weapon model is. It writes `Camera.refdef` and the
 * view entity; what the frame derives from that comes after.
 */
export default class FirstPersonView {
  /** Seconds of the damage kick that are left. */
  static dmg_time = 0.0;

  /** Roll of the damage kick at its start, in degrees. */
  static dmg_roll = 0.0;

  /** Pitch of the damage kick at its start, in degrees. */
  static dmg_pitch = 0.0;

  /** Height the eye is smoothed to, so that stepping up a stair does not jump. */
  static oldz = 0.0;

  /** What a view is calculated from, reused every frame. */
  static readonly #input: { -readonly [Member in keyof ViewInput]: ViewInput[Member] } = {
    origin: new Vector(),
    angles: new Vector(),
    velocity: new Vector(),
    viewangles: new Vector(),
    punchangle: new Vector(),
    viewheight: 0,
    onground: false,
    time: 0,
    frametime: 0,
    viewsize: 120,
  };

  /** Where the eye and the weapon are put, reused every frame. */
  static readonly #result: ViewResult = {
    vieworg: new Vector(),
    viewangles: new Vector(),
    weaponOrigin: new Vector(),
    weaponAngles: new Vector(),
  };

  /**
   * Creates the console variables of the view and starts the weapon from where the view is on every new level.
   */
  static Init(): void {
    viewCvars.register();

    // a new level starts the weapon from where the view is
    eventBus.subscribe('server.spawning', () => {
      ViewmodelMotion.Reset();
    });
  }

  /**
   * A hit the server told this client about: lets the game know (`client.damage`, which is where a game tints the
   * view), starts the face animation and kicks the view away from where the damage came from.
   * @param armor How much damage the armor took.
   * @param blood How much damage reached the player.
   * @param origin Where the damage came from.
   */
  static ApplyDamage(armor: number, blood: number, origin: Vector): void { // Client (formerly V.ParseDamage of Quake)
    const ent = clientRuntimeState.playerentity!;
    console.assert(ent !== null, 'Player entity is required for damage calculations');
    const from = origin.subtract(ent.origin);

    eventBus.publish('client.damage', { damageReceived: blood, armorLost: armor, attackOrigin: from.copy() });

    from.normalize();
    let count = (blood + armor) * 0.5;
    if (count < 10.0) {
      count = 10.0;
    }
    clientRuntimeState.faceanimtime = clientRuntimeState.time + 0.2;

    const { forward, right } = ent.angles.angleVectors();
    FirstPersonView.dmg_roll = count * (from[0] * right[0] + from[1] * right[1] + from[2] * right[2]) * viewCvars.kickroll.value;
    FirstPersonView.dmg_pitch = count * (from[0] * forward[0] + from[1] * forward[1] + from[2] * forward[2]) * viewCvars.kickpitch.value;
    FirstPersonView.dmg_time = viewCvars.kicktime.value;
  }

  /**
   * Looks from the camera entity of an intermission with a slow sway and hides the weapon.
   */
  static CalcIntermissionRefdef(): void {
    const ent = clientRuntimeState.playerentity!;
    console.assert(ent !== null, 'Player entity is required for intermission view calculations');
    Camera.refdef.vieworg[0] = finiteOrZero(ent.origin[0]);
    Camera.refdef.vieworg[1] = finiteOrZero(ent.origin[1]);
    Camera.refdef.vieworg[2] = finiteOrZero(ent.origin[2]);
    Camera.refdef.viewangles[0] = finiteOrZero(ent.angles[0]) + Math.sin(clientRuntimeState.time * viewCvars.ipitch_cycle.value) * viewCvars.ipitch_level.value;
    Camera.refdef.viewangles[1] = finiteOrZero(ent.angles[1]) + Math.sin(clientRuntimeState.time * viewCvars.iyaw_cycle.value) * viewCvars.iyaw_level.value;
    Camera.refdef.viewangles[2] = finiteOrZero(ent.angles[2]) + Math.sin(clientRuntimeState.time * viewCvars.iroll_cycle.value) * viewCvars.iroll_level.value;
    console.assert(clientRuntimeState.viewent !== null, 'View entity is required for intermission view calculations');
    clientRuntimeState.viewent!.model = null;
  }

  /**
   * Calculates the first-person view of this frame into `Camera.refdef` and places the weapon model. The game
   * calculates it when it has a `calcView` and the engine's own `Calculate` is used when it has not. Then the
   * model and frame of the weapon, the game's `updateRefDef` and the chase camera, in that order.
   */
  static CalcRefdef(): void { // TODO: Client
    if (viewCvars.pitchdrift.value) {
      PitchDrift.Update();
    }

    const ent = clientRuntimeState.playerentity!;
    console.assert(ent !== null, 'Player entity is required for view calculations');

    const view = clientRuntimeState.viewent!;
    console.assert(view !== null, 'View entity is required for view calculations');

    const input = FirstPersonView.#input;
    input.origin.set(ent.origin);
    input.angles.set(ent.angles);
    input.velocity.set(clientRuntimeState.velocity);
    input.viewangles.set(clientRuntimeState.viewangles);
    input.punchangle.set(clientRuntimeState.punchangle);
    input.viewheight = clientRuntimeState.viewheight;
    input.onground = clientRuntimeState.onground;
    input.time = clientRuntimeState.time;
    input.frametime = Host.frametime;
    input.viewsize = viewCvars.viewsize.value;

    const result = FirstPersonView.#result;
    const game = clientRuntimeState.gameAPI;

    if (game?.calcView !== undefined) {
      game.calcView(input, result);
    } else {
      FirstPersonView.Calculate(input, result);
    }

    Camera.refdef.vieworg.set(result.vieworg);
    Camera.refdef.viewangles.set(result.viewangles);
    view.origin.set(result.weaponOrigin);
    view.angles.set(result.weaponAngles);

    const viewmodel = game?.viewmodel ?? null;

    if (viewmodel !== null) {
      view.model = viewmodel.model;
      view.frame = viewmodel.frame;
      // visibility is considered by R.DrawViewModel
    } else {
      view.model = null;
      view.frame = 0;
    }

    // allow lerping viewmodel by heuristic
    if (view.frame > 0) {
      view.lerpEndTime = ent.lerpEndTime;
      view.framePrevious = view.frame - 1;
      view.frameTime = ent.frameTime;
    } else {
      view.lerpEndTime = -1;
      view.framePrevious = null;
      view.frameTime = 0.0;
    }

    if (game) {
      game.updateRefDef(Camera.refdef);
    }

    if (Chase.active.value) {
      Chase.Update();
    }
  }

  /**
   * The engine's first-person view, from what a view is calculated from to where the eye and the weapon are: the
   * eye at the player's origin and view height with the walking bob, the roll into a strafe, the damage kick, the
   * idle sway, the `scr_ofs` offsets, the punch angle and the smoothing of steps. A game that calculates its own
   * view can call it and adjust the result.
   * @param input What the view is calculated from.
   * @param result Where the eye and the weapon are put. Every member is written.
   */
  static Calculate(input: ViewInput, result: ViewResult): void {
    const origin = input.origin;
    const bob = ViewmodelMotion.CalcBob();
    ViewmodelMotion.Advance(bob, input.viewangles[0], input.viewangles[1]);
    const viewmodelBob = ViewmodelMotion.bob;

    const vieworg = result.vieworg;
    const viewangles = result.viewangles;

    vieworg[0] = finiteOrZero(origin[0]) + 0.03125;
    vieworg[1] = finiteOrZero(origin[1]) + 0.03125;
    vieworg[2] = finiteOrZero(origin[2]) + input.viewheight + bob + 0.03125;

    viewangles[0] = input.viewangles[0];
    viewangles[1] = input.viewangles[1];
    viewangles[2] = input.viewangles[2] + calcRoll(input.angles, input.velocity, viewCvars.rollspeed.value, viewCvars.rollangle.value);

    if (FirstPersonView.dmg_time > 0.0) {
      if (viewCvars.kicktime.value) {
        viewangles[2] += (FirstPersonView.dmg_time / viewCvars.kicktime.value) * FirstPersonView.dmg_roll;
        viewangles[0] -= (FirstPersonView.dmg_time / viewCvars.kicktime.value) * FirstPersonView.dmg_pitch;
      }
      FirstPersonView.dmg_time -= input.frametime;
    }

    const ipitch = viewCvars.idlescale.value * Math.sin(input.time * viewCvars.ipitch_cycle.value) * viewCvars.ipitch_level.value;
    const iyaw = viewCvars.idlescale.value * Math.sin(input.time * viewCvars.iyaw_cycle.value) * viewCvars.iyaw_level.value;
    const iroll = viewCvars.idlescale.value * Math.sin(input.time * viewCvars.iroll_cycle.value) * viewCvars.iroll_level.value;
    viewangles[0] += ipitch;
    viewangles[1] += iyaw;
    viewangles[2] += iroll;

    const { forward, right, up } = new Vector(finiteOrZero(-input.angles[0]), finiteOrZero(input.angles[1]), finiteOrZero(input.angles[2])).angleVectors();
    vieworg[0] += viewCvars.ofsx.value * forward[0] + viewCvars.ofsy.value * right[0] + viewCvars.ofsz.value * up[0];
    vieworg[1] += viewCvars.ofsx.value * forward[1] + viewCvars.ofsy.value * right[1] + viewCvars.ofsz.value * up[1];
    vieworg[2] += viewCvars.ofsx.value * forward[2] + viewCvars.ofsy.value * right[2] + viewCvars.ofsz.value * up[2];

    if (vieworg[0] < (origin[0] - 14.0)) {
      vieworg[0] = finiteOrZero(origin[0]) - 14.0;
    } else if (vieworg[0] > (origin[0] + 14.0)) {
      vieworg[0] = finiteOrZero(origin[0]) + 14.0;
    }
    if (vieworg[1] < (origin[1] - 14.0)) {
      vieworg[1] = finiteOrZero(origin[1]) - 14.0;
    } else if (vieworg[1] > (origin[1] + 14.0)) {
      vieworg[1] = finiteOrZero(origin[1]) + 14.0;
    }
    if (vieworg[2] < (origin[2] - 22.0)) {
      vieworg[2] = finiteOrZero(origin[2]) - 22.0;
    } else if (vieworg[2] > (origin[2] + 30.0)) {
      vieworg[2] = finiteOrZero(origin[2]) + 30.0;
    }

    const weaponAngles = result.weaponAngles;
    const weaponOrigin = result.weaponOrigin;

    weaponAngles[0] = -viewangles[0] - ipitch;
    weaponAngles[1] = viewangles[1] - iyaw;
    weaponAngles[2] = input.viewangles[2] - iroll;
    weaponOrigin[0] = finiteOrZero(origin[0]) + forward[0] * viewmodelBob * 0.4;
    weaponOrigin[1] = finiteOrZero(origin[1]) + forward[1] * viewmodelBob * 0.4;
    weaponOrigin[2] = finiteOrZero(origin[2]) + input.viewheight + forward[2] * viewmodelBob * 0.4 + viewmodelBob;
    weaponOrigin[0] += right[0] * ViewmodelMotion.lookBobRight + up[0] * ViewmodelMotion.lookBobUp;
    weaponOrigin[1] += right[1] * ViewmodelMotion.lookBobRight + up[1] * ViewmodelMotion.lookBobUp;
    weaponOrigin[2] += right[2] * ViewmodelMotion.lookBobRight + up[2] * ViewmodelMotion.lookBobUp;
    weaponAngles[1] += ViewmodelMotion.lookBobRight * 0.45;
    weaponAngles[0] += ViewmodelMotion.lookBobUp * 0.35;
    weaponAngles[2] -= ViewmodelMotion.lookBobRight * 0.25;
    switch (input.viewsize) {
      case 110:
      case 90:
        weaponOrigin[2] += 1.0;
        break;
      case 100:
        weaponOrigin[2] += 2.0;
        break;
      case 80:
        weaponOrigin[2] += 0.5;
    }

    viewangles.add(input.punchangle);

    if (input.onground && (origin[2] - FirstPersonView.oldz) > 0.0) {
      let steptime = input.frametime;
      if (steptime < 0.0) {
        steptime = 0.0;
      }
      FirstPersonView.oldz += steptime * 80.0;
      if (FirstPersonView.oldz > origin[2]) {
        FirstPersonView.oldz = finiteOrZero(origin[2]);
      } else if ((origin[2] - FirstPersonView.oldz) > 12.0) {
        FirstPersonView.oldz = finiteOrZero(origin[2]) - 12.0;
      }
      vieworg[2] += FirstPersonView.oldz - finiteOrZero(origin[2]);
      weaponOrigin[2] += FirstPersonView.oldz - finiteOrZero(origin[2]);
    } else {
      FirstPersonView.oldz = finiteOrZero(origin[2]);
    }
  }
}
