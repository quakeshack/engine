import { calcRoll } from '../../../shared/PlayerRoll.ts';
import Vector from '../../../shared/Vector.ts';
import Cvar from '../../common/Cvar.ts';
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

  /**
   * Creates the console variables of the view, in the order `cvarlist` shows them.
   */
  static Init(): void {
    viewCvars.centermove = new Cvar('v_centermove', '0.15');
    viewCvars.centerspeed = new Cvar('v_centerspeed', '500');
    viewCvars.iyaw_cycle = new Cvar('v_iyaw_cycle', '2');
    viewCvars.iroll_cycle = new Cvar('v_iroll_cycle', '0.5');
    viewCvars.ipitch_cycle = new Cvar('v_ipitch_cycle', '1');
    viewCvars.iyaw_level = new Cvar('v_iyaw_level', '0.3');
    viewCvars.iroll_level = new Cvar('v_iroll_level', '0.1');
    viewCvars.ipitch_level = new Cvar('v_ipitch_level', '0.3');
    viewCvars.idlescale = new Cvar('v_idlescale', '0');
    viewCvars.ofsx = new Cvar('scr_ofsx', '0');
    viewCvars.ofsy = new Cvar('scr_ofsy', '0');
    viewCvars.ofsz = new Cvar('scr_ofsz', '0');
    viewCvars.rollspeed = new Cvar('cl_rollspeed', '200');
    viewCvars.rollangle = new Cvar('cl_rollangle', '2.0');
    viewCvars.bob = new Cvar('cl_bob', '0.02');
    viewCvars.bobcycle = new Cvar('cl_bobcycle', '0.6');
    viewCvars.bobup = new Cvar('cl_bobup', '0.5');
    viewCvars.kicktime = new Cvar('v_kicktime', '0.5');
    viewCvars.kickroll = new Cvar('v_kickroll', '0.6');
    viewCvars.kickpitch = new Cvar('v_kickpitch', '0.6');
    viewCvars.pitchdrift = new Cvar('v_pitchdrift', '1', Cvar.FLAG.ARCHIVE, 'Vanilla Quake drift pitch when moving forward.');

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
   * Calculates the first-person view of this frame into `Camera.refdef` and places the weapon model: the eye
   * at the player's origin and view height with the walking bob, the roll into a strafe, the damage kick, the
   * idle sway, the `scr_ofs` offsets, the punch angle and the smoothing of steps; then the game's `updateRefDef`
   * and the chase camera, in that order.
   */
  static CalcRefdef(): void { // TODO: Client
    if (viewCvars.pitchdrift.value) {
      PitchDrift.Update();
    }

    const ent = clientRuntimeState.playerentity!;
    console.assert(ent !== null, 'Player entity is required for view calculations');

    const bob = ViewmodelMotion.CalcBob();
    ViewmodelMotion.Advance(bob, clientRuntimeState.viewangles[0], clientRuntimeState.viewangles[1]);
    const viewmodelBob = ViewmodelMotion.bob;

    Camera.refdef.vieworg[0] = finiteOrZero(ent.origin[0]) + 0.03125;
    Camera.refdef.vieworg[1] = finiteOrZero(ent.origin[1]) + 0.03125;
    Camera.refdef.vieworg[2] = finiteOrZero(ent.origin[2]) + clientRuntimeState.viewheight + bob + 0.03125;

    Camera.refdef.viewangles[0] = clientRuntimeState.viewangles[0];
    Camera.refdef.viewangles[1] = clientRuntimeState.viewangles[1];
    Camera.refdef.viewangles[2] = clientRuntimeState.viewangles[2] + calcRoll(ent.angles, clientRuntimeState.velocity, viewCvars.rollspeed.value, viewCvars.rollangle.value);

    if (FirstPersonView.dmg_time > 0.0) {
      if (viewCvars.kicktime.value) {
        Camera.refdef.viewangles[2] += (FirstPersonView.dmg_time / viewCvars.kicktime.value) * FirstPersonView.dmg_roll;
        Camera.refdef.viewangles[0] -= (FirstPersonView.dmg_time / viewCvars.kicktime.value) * FirstPersonView.dmg_pitch;
      }
      FirstPersonView.dmg_time -= Host.frametime;
    }

    const ipitch = viewCvars.idlescale.value * Math.sin(clientRuntimeState.time * viewCvars.ipitch_cycle.value) * viewCvars.ipitch_level.value;
    const iyaw = viewCvars.idlescale.value * Math.sin(clientRuntimeState.time * viewCvars.iyaw_cycle.value) * viewCvars.iyaw_level.value;
    const iroll = viewCvars.idlescale.value * Math.sin(clientRuntimeState.time * viewCvars.iroll_cycle.value) * viewCvars.iroll_level.value;
    Camera.refdef.viewangles[0] += ipitch;
    Camera.refdef.viewangles[1] += iyaw;
    Camera.refdef.viewangles[2] += iroll;

    const { forward, right, up } = new Vector(finiteOrZero(-ent.angles[0]), finiteOrZero(ent.angles[1]), finiteOrZero(ent.angles[2])).angleVectors();
    Camera.refdef.vieworg[0] += viewCvars.ofsx.value * forward[0] + viewCvars.ofsy.value * right[0] + viewCvars.ofsz.value * up[0];
    Camera.refdef.vieworg[1] += viewCvars.ofsx.value * forward[1] + viewCvars.ofsy.value * right[1] + viewCvars.ofsz.value * up[1];
    Camera.refdef.vieworg[2] += viewCvars.ofsx.value * forward[2] + viewCvars.ofsy.value * right[2] + viewCvars.ofsz.value * up[2];

    if (Camera.refdef.vieworg[0] < (ent.origin[0] - 14.0)) {
      Camera.refdef.vieworg[0] = finiteOrZero(ent.origin[0]) - 14.0;
    } else if (Camera.refdef.vieworg[0] > (ent.origin[0] + 14.0)) {
      Camera.refdef.vieworg[0] = finiteOrZero(ent.origin[0]) + 14.0;
    }
    if (Camera.refdef.vieworg[1] < (ent.origin[1] - 14.0)) {
      Camera.refdef.vieworg[1] = finiteOrZero(ent.origin[1]) - 14.0;
    } else if (Camera.refdef.vieworg[1] > (ent.origin[1] + 14.0)) {
      Camera.refdef.vieworg[1] = finiteOrZero(ent.origin[1]) + 14.0;
    }
    if (Camera.refdef.vieworg[2] < (ent.origin[2] - 22.0)) {
      Camera.refdef.vieworg[2] = finiteOrZero(ent.origin[2]) - 22.0;
    } else if (Camera.refdef.vieworg[2] > (ent.origin[2] + 30.0)) {
      Camera.refdef.vieworg[2] = finiteOrZero(ent.origin[2]) + 30.0;
    }

    const view = clientRuntimeState.viewent!;
    console.assert(view !== null, 'View entity is required for view calculations');

    view.angles[0] = -Camera.refdef.viewangles[0] - ipitch;
    view.angles[1] = Camera.refdef.viewangles[1] - iyaw;
    view.angles[2] = clientRuntimeState.viewangles[2] - iroll;
    view.origin[0] = finiteOrZero(ent.origin[0]) + forward[0] * viewmodelBob * 0.4;
    view.origin[1] = finiteOrZero(ent.origin[1]) + forward[1] * viewmodelBob * 0.4;
    view.origin[2] = finiteOrZero(ent.origin[2]) + clientRuntimeState.viewheight + forward[2] * viewmodelBob * 0.4 + viewmodelBob;
    view.origin[0] += right[0] * ViewmodelMotion.lookBobRight + up[0] * ViewmodelMotion.lookBobUp;
    view.origin[1] += right[1] * ViewmodelMotion.lookBobRight + up[1] * ViewmodelMotion.lookBobUp;
    view.origin[2] += right[2] * ViewmodelMotion.lookBobRight + up[2] * ViewmodelMotion.lookBobUp;
    view.angles[1] += ViewmodelMotion.lookBobRight * 0.45;
    view.angles[0] += ViewmodelMotion.lookBobUp * 0.35;
    view.angles[2] -= ViewmodelMotion.lookBobRight * 0.25;
    switch (viewCvars.viewsize.value) {
      case 110:
      case 90:
        view.origin[2] += 1.0;
        break;
      case 100:
        view.origin[2] += 2.0;
        break;
      case 80:
        view.origin[2] += 0.5;
    }

    const viewmodel = clientRuntimeState.gameAPI?.viewmodel ?? null;

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

    Camera.refdef.viewangles.add(clientRuntimeState.punchangle);

    if (clientRuntimeState.onground && (ent.origin[2] - FirstPersonView.oldz) > 0.0) {
      let steptime = Host.frametime;
      if (steptime < 0.0) {
        steptime = 0.0;
      }
      FirstPersonView.oldz += steptime * 80.0;
      if (FirstPersonView.oldz > ent.origin[2]) {
        FirstPersonView.oldz = finiteOrZero(ent.origin[2]);
      } else if ((ent.origin[2] - FirstPersonView.oldz) > 12.0) {
        FirstPersonView.oldz = finiteOrZero(ent.origin[2]) - 12.0;
      }
      Camera.refdef.vieworg[2] += FirstPersonView.oldz - finiteOrZero(ent.origin[2]);
      view.origin[2] += FirstPersonView.oldz - finiteOrZero(ent.origin[2]);
    } else {
      FirstPersonView.oldz = finiteOrZero(ent.origin[2]);
    }

    if (clientRuntimeState.gameAPI) {
      clientRuntimeState.gameAPI.updateRefDef(Camera.refdef);
    }

    if (Chase.active.value) {
      Chase.Update();
    }
  }
}
