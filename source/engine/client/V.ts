type ColorShift = [number, number, number, number];

import { content } from '../../shared/Defs.ts';
import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import * as Def from '../common/Def.ts';
import Q from '../../shared/Q.ts';
import { calcRoll } from '../../shared/PlayerRoll.ts';
import Vector from '../../shared/Vector.ts';
import { eventBus } from '../common/EventBus.ts';
import Chase from './Chase.ts';
import ConsoleOverlay from './ConsoleOverlay.ts';
import { clientRuntimeState, clientStaticState } from './ClientState.ts';
import clientCvars from './ClientCvars.ts';
import R from './R.ts';
import Camera from './renderer/scene/Camera.ts';
import Visibility from './renderer/scene/Visibility.ts';
import DynamicLights from './renderer/lighting/DynamicLights.ts';
import Host from '../common/Host.ts';
import SCR from './SCR.ts';

/**
 * @param {number} value scalar component
 * @returns {number} finite scalar or zero fallback
 */
function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0.0;
}

export default class V {
  static dmg_time = 0.0;
  static dmg_roll = 0.0;
  static dmg_pitch = 0.0;
  static oldz = 0.0;
  static #smoothedViewmodelBob = 0.0;
  static #smoothedViewmodelBobInitialized = false;
  static #previousViewPitch = 0.0;
  static #previousViewYaw = 0.0;
  static #viewmodelLookBobInitialized = false;
  static #viewmodelLookBobRight = 0.0;
  static #viewmodelLookBobUp = 0.0;

  static cshift_empty: ColorShift = [130.0, 80.0, 50.0, 0.0];
  static cshift_water: ColorShift = [130.0, 80.0, 50.0, 128.0];
  static cshift_slime: ColorShift = [0.0, 25.0, 5.0, 150.0];
  static cshift_lava: ColorShift = [255.0, 80.0, 0.0, 150.0];

  static blend: ColorShift = [0.0, 0.0, 0.0, 0.0];

  static centermove: Cvar = null!;
  static centerspeed: Cvar = null!;
  static iyaw_cycle: Cvar = null!;
  static iroll_cycle: Cvar = null!;
  static ipitch_cycle: Cvar = null!;
  static iyaw_level: Cvar = null!;
  static iroll_level: Cvar = null!;
  static ipitch_level: Cvar = null!;
  static idlescale: Cvar = null!;
  static cshiftpercent: Cvar = null!;
  static ofsx: Cvar = null!;
  static ofsy: Cvar = null!;
  static ofsz: Cvar = null!;
  static rollspeed: Cvar = null!;
  static rollangle: Cvar = null!;
  static bob: Cvar = null!;
  static bobcycle: Cvar = null!;
  static bobup: Cvar = null!;
  static kicktime: Cvar = null!;
  static kickroll: Cvar = null!;
  static kickpitch: Cvar = null!;
  static gamma: Cvar = null!;
  static pitchdrift: Cvar = null!;

  /**
   * Computes how far the view rolls for a player moving sideways.
   * @param angles View angles.
   * @param velocity Player velocity.
   * @returns The roll angle.
   */
  static CalcRoll(angles: Vector, velocity: Vector): number { // FIXME: this is required for dedicated as well
    return calcRoll(angles, velocity, V.rollspeed.value, V.rollangle.value);
  }

  static CalcBob(): number {
    if ((V.bobcycle.value <= 0.0)
      || (V.bobcycle.value >= 1.0)
      || (V.bobup.value <= 0.0)
      || (V.bobup.value >= 1.0)
      || (V.bob.value === 0.0)) {
      return 0.0;
    }

    let cycle = (clientRuntimeState.time - Math.floor(clientRuntimeState.time / V.bobcycle.value) * V.bobcycle.value) / V.bobcycle.value;
    if (cycle < V.bobup.value) {
      cycle = Math.PI * cycle / V.bobup.value;
    } else {
      cycle = Math.PI + Math.PI * (cycle - V.bobup.value) / (1.0 - V.bobup.value);
    }
    let bob = Math.hypot(clientRuntimeState.velocity[0], clientRuntimeState.velocity[1]) * V.bob.value;
    bob = bob * 0.3 + bob * 0.7 * Math.sin(cycle);
    if (bob > 4.0) {
      bob = 4.0;
    } else if (bob < -7.0) {
      bob = -7.0;
    }
    return bob;
  }

  static SmoothValue(current: number, target: number, sharpness: number, deltaTime: number): number {
    const smoothing = 1.0 - Math.exp(-Math.max(0.0, sharpness) * Math.max(0.0, deltaTime));
    return current + (target - current) * smoothing;
  }

  /**
   * @param {number} from previous yaw angle in degrees
   * @param {number} to current yaw angle in degrees
   * @returns {number} shortest wrapped delta in [-180, 180).
   */
  static ShortestAngleDelta(from: number, to: number): number {
    return ((to - from + 540.0) % 360.0) - 180.0;
  }

  /**
   * @param {number} pitchDelta per-frame pitch delta in degrees
   * @param {number} yawDelta per-frame yaw delta in degrees
   * @returns {[number, number]} right/up look bob targets for the viewmodel.
   */
  static ComputeViewmodelLookBobTargets(pitchDelta: number, yawDelta: number): [number, number] {
    const rightTarget = Math.max(-1.8, Math.min(1.8, -yawDelta * 0.07));
    const upTarget = Math.max(-1.2, Math.min(1.2, pitchDelta * 0.05));
    return [rightTarget, upTarget];
  }

  static StartPitchDrift(): void {
    if (clientRuntimeState.laststop === clientRuntimeState.time) {
      return;
    }
    if (clientRuntimeState.nodrift || clientRuntimeState.pitchvel === 0.0) {
      clientRuntimeState.pitchvel = V.centerspeed.value;
      clientRuntimeState.nodrift = false;
      clientRuntimeState.driftmove = 0.0;
    }
  }

  static StopPitchDrift(): void {
    clientRuntimeState.laststop = clientRuntimeState.time;
    clientRuntimeState.nodrift = true;
    clientRuntimeState.pitchvel = 0.0;
  }

  static DriftPitch(): void {
    if (Host.noclip_anglehack || !clientRuntimeState.onground || clientStaticState.demoplayback) {
      clientRuntimeState.driftmove = 0.0;
      clientRuntimeState.pitchvel = 0.0;
      return;
    }

    if (clientRuntimeState.nodrift) {
      if (Math.abs(clientRuntimeState.cmd.forwardmove) < clientCvars.forwardspeed.value) {
        clientRuntimeState.driftmove = 0.0;
      } else {
        clientRuntimeState.driftmove += Host.frametime;
      }
      if (clientRuntimeState.driftmove > V.centermove.value) {
        V.StartPitchDrift();
      }
      return;
    }

    const delta = clientRuntimeState.idealpitch - clientRuntimeState.viewangles[0];
    if (delta === 0.0) {
      clientRuntimeState.pitchvel = 0.0;
      return;
    }

    let move = Host.frametime * clientRuntimeState.pitchvel;
    clientRuntimeState.pitchvel += Host.frametime * V.centerspeed.value;

    if (delta > 0) {
      if (move > delta) {
        clientRuntimeState.pitchvel = 0.0;
        move = delta;
      }
      clientRuntimeState.viewangles[0] += move;
    } else if (delta < 0) {
      if (move > -delta) {
        clientRuntimeState.pitchvel = 0.0;
        move = -delta;
      }
      clientRuntimeState.viewangles[0] -= move;
    }
  }

  static ApplyDamage(armor: number, blood: number, origin: Vector): void { // Client (formally known as V.ParseDamage)
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

    const cshift = clientRuntimeState.cshifts[Def.contentShift.damage];
    cshift[3] += 3.0 * count;
    if (cshift[3] < 0.0) {
      cshift[3] = 0.0;
    } else if (cshift[3] > 150.0) {
      cshift[3] = 150.0;
    }

    if (armor > blood) {
      cshift[0] = 200.0;
      cshift[1] = cshift[2] = 100.0;
    } else if (armor !== 0) {
      cshift[0] = 220.0;
      cshift[1] = cshift[2] = 50.0;
    } else {
      cshift[0] = 255.0;
      cshift[1] = cshift[2] = 0.0;
    }

    const { forward, right } = ent.angles.angleVectors();
    V.dmg_roll = count * (from[0] * right[0] + from[1] * right[1] + from[2] * right[2]) * V.kickroll.value;
    V.dmg_pitch = count * (from[0] * forward[0] + from[1] * forward[1] + from[2] * forward[2]) * V.kickpitch.value;
    V.dmg_time = V.kicktime.value;
  }

  static cshift_f(...args: string[]): void {
    const cshift = V.cshift_empty;
    for (let i = 0; i < Math.min(args.length, cshift.length); i++) {
      cshift[i] = Q.atoi(args[i]);
    }
  }

  static BonusFlash_f(): void {
    const cshift = clientRuntimeState.cshifts[Def.contentShift.bonus];
    cshift[0] = 215.0;
    cshift[1] = 186.0;
    cshift[2] = 69.0;
    cshift[3] = 50.0;
  }

  static ContentShift(slot: number, color: Vector, alpha: number): void {
    const cshift = clientRuntimeState.cshifts[slot];
    cshift[0] = color[0] * 255.0;
    cshift[1] = color[1] * 255.0;
    cshift[2] = color[2] * 255.0;
    cshift[3] = alpha * 255.0;
  }

  /**
   * @param {content} contents content classification
   */
  static SetContentsColor(contents: content): void {
    switch (contents) {
      case content.CONTENT_EMPTY:
        clientRuntimeState.cshifts[Def.contentShift.contents] = V.cshift_empty;
        return;
      case content.CONTENT_LAVA:
        clientRuntimeState.cshifts[Def.contentShift.contents] = V.cshift_lava;
        return;
      case content.CONTENT_SLIME:
        clientRuntimeState.cshifts[Def.contentShift.contents] = V.cshift_slime;
        return;
      case content.CONTENT_WATER:
        clientRuntimeState.cshifts[Def.contentShift.contents] = V.cshift_water;
        return;
    }
  }

  static CalcBlend(): void {
    let cshift = clientRuntimeState.cshifts[Def.contentShift.powerup];
    if ((clientRuntimeState.items & Def.it.quad) !== 0) {
      cshift[0] = 0.0;
      cshift[1] = 0.0;
      cshift[2] = 255.0;
      cshift[3] = 30.0;
    } else if ((clientRuntimeState.items & Def.it.suit) !== 0) {
      cshift[0] = 0.0;
      cshift[1] = 255.0;
      cshift[2] = 0.0;
      cshift[3] = 20.0;
    } else if ((clientRuntimeState.items & Def.it.invisibility) !== 0) {
      cshift[0] = 100.0;
      cshift[1] = 100.0;
      cshift[2] = 100.0;
      cshift[3] = 100.0;
    } else if ((clientRuntimeState.items & Def.it.invulnerability) !== 0) {
      cshift[0] = 255.0;
      cshift[1] = 255.0;
      cshift[2] = 0.0;
      cshift[3] = 30.0;
    } else {
      cshift[3] = 0.0;
    }

    clientRuntimeState.cshifts[Def.contentShift.damage][3] -= Host.frametime * 150.0;
    if (clientRuntimeState.cshifts[Def.contentShift.damage][3] < 0.0) {
      clientRuntimeState.cshifts[Def.contentShift.damage][3] = 0.0;
    }
    clientRuntimeState.cshifts[Def.contentShift.bonus][3] -= Host.frametime * 100.0;
    if (clientRuntimeState.cshifts[Def.contentShift.bonus][3] < 0.0) {
      clientRuntimeState.cshifts[Def.contentShift.bonus][3] = 0.0;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    for (let i = Def.contentShift.user1; i < clientRuntimeState.cshifts.length; i++) {
      const userShift = clientRuntimeState.cshifts[i];
      userShift[3] -= Host.frametime * 100.0;
      if (userShift[3] < 0.0) {
        userShift[3] = 0.0;
      }
    }

    if (V.cshiftpercent.value === 0) {
      V.blend[0] = V.blend[1] = V.blend[2] = V.blend[3] = 0.0;
      return;
    }

    let r = 0.0;
    let g = 0.0;
    let b = 0.0;
    let a = 0.0;
    let a2: number;
    for (let i = 0; i < clientRuntimeState.cshifts.length; i++) {
      cshift = clientRuntimeState.cshifts[i];
      a2 = cshift[3] * V.cshiftpercent.value / 25500.0;
      if (a2 === 0.0) {
        continue;
      }
      a = a + a2 * (1.0 - a);
      a2 = a2 / a;
      r = r * (1.0 - a2) + cshift[0] * a2;
      g = g * (1.0 - a2) + cshift[1] * a2;
      b = b * (1.0 - a2) + cshift[2] * a2;
    }
    if (a > 1.0) {
      a = 1.0;
    } else if (a < 0.0) {
      a = 0.0;
    }
    V.blend[0] = r;
    V.blend[1] = g;
    V.blend[2] = b;
    V.blend[3] = a;
    if (V.blend[3] > 1.0) {
      V.blend[3] = 1.0;
    } else if (V.blend[3] < 0.0) {
      V.blend[3] = 0.0;
    }
  }

  static CalcIntermissionRefdef(): void {
    const ent = clientRuntimeState.playerentity!;
    console.assert(ent !== null, 'Player entity is required for intermission view calculations');
    Camera.refdef.vieworg[0] = finiteOrZero(ent.origin[0]);
    Camera.refdef.vieworg[1] = finiteOrZero(ent.origin[1]);
    Camera.refdef.vieworg[2] = finiteOrZero(ent.origin[2]);
    Camera.refdef.viewangles[0] = finiteOrZero(ent.angles[0]) + Math.sin(clientRuntimeState.time * V.ipitch_cycle.value) * V.ipitch_level.value;
    Camera.refdef.viewangles[1] = finiteOrZero(ent.angles[1]) + Math.sin(clientRuntimeState.time * V.iyaw_cycle.value) * V.iyaw_level.value;
    Camera.refdef.viewangles[2] = finiteOrZero(ent.angles[2]) + Math.sin(clientRuntimeState.time * V.iroll_cycle.value) * V.iroll_level.value;
    console.assert(clientRuntimeState.viewent !== null, 'View entity is required for intermission view calculations');
    clientRuntimeState.viewent!.model = null;
  }

  static CalcRefdef(): void { // TODO: Client
    if (V.pitchdrift.value) {
      V.DriftPitch();
    }

    const ent = clientRuntimeState.playerentity!;
    console.assert(ent !== null, 'Player entity is required for view calculations');

    const bob = V.CalcBob();
    if (!V.#smoothedViewmodelBobInitialized) {
      V.#smoothedViewmodelBob = bob;
      V.#smoothedViewmodelBobInitialized = true;
    } else {
      V.#smoothedViewmodelBob = V.SmoothValue(V.#smoothedViewmodelBob, bob, 72.0, Host.frametime);
    }
    const viewmodelBob = V.#smoothedViewmodelBob;

    const currentPitch = clientRuntimeState.viewangles[0];
    const currentYaw = clientRuntimeState.viewangles[1];
    if (!V.#viewmodelLookBobInitialized) {
      V.#previousViewPitch = currentPitch;
      V.#previousViewYaw = currentYaw;
      V.#viewmodelLookBobRight = 0.0;
      V.#viewmodelLookBobUp = 0.0;
      V.#viewmodelLookBobInitialized = true;
    } else {
      const pitchDelta = currentPitch - V.#previousViewPitch;
      const yawDelta = V.ShortestAngleDelta(V.#previousViewYaw, currentYaw);
      const [lookBobRightTarget, lookBobUpTarget] = V.ComputeViewmodelLookBobTargets(pitchDelta, yawDelta);
      V.#viewmodelLookBobRight = V.SmoothValue(V.#viewmodelLookBobRight, lookBobRightTarget, 18.0, Host.frametime);
      V.#viewmodelLookBobUp = V.SmoothValue(V.#viewmodelLookBobUp, lookBobUpTarget, 18.0, Host.frametime);
      V.#previousViewPitch = currentPitch;
      V.#previousViewYaw = currentYaw;
    }

    Camera.refdef.vieworg[0] = finiteOrZero(ent.origin[0]) + 0.03125;
    Camera.refdef.vieworg[1] = finiteOrZero(ent.origin[1]) + 0.03125;
    Camera.refdef.vieworg[2] = finiteOrZero(ent.origin[2]) + clientRuntimeState.viewheight + bob + 0.03125;

    Camera.refdef.viewangles[0] = clientRuntimeState.viewangles[0];
    Camera.refdef.viewangles[1] = clientRuntimeState.viewangles[1];
    Camera.refdef.viewangles[2] = clientRuntimeState.viewangles[2] + V.CalcRoll(ent.angles, clientRuntimeState.velocity);

    if (V.dmg_time > 0.0) {
      if (V.kicktime.value) {
        Camera.refdef.viewangles[2] += (V.dmg_time / V.kicktime.value) * V.dmg_roll;
        Camera.refdef.viewangles[0] -= (V.dmg_time / V.kicktime.value) * V.dmg_pitch;
      }
      V.dmg_time -= Host.frametime;
    }

    const ipitch = V.idlescale.value * Math.sin(clientRuntimeState.time * V.ipitch_cycle.value) * V.ipitch_level.value;
    const iyaw = V.idlescale.value * Math.sin(clientRuntimeState.time * V.iyaw_cycle.value) * V.iyaw_level.value;
    const iroll = V.idlescale.value * Math.sin(clientRuntimeState.time * V.iroll_cycle.value) * V.iroll_level.value;
    Camera.refdef.viewangles[0] += ipitch;
    Camera.refdef.viewangles[1] += iyaw;
    Camera.refdef.viewangles[2] += iroll;

    const { forward, right, up } = new Vector(finiteOrZero(-ent.angles[0]), finiteOrZero(ent.angles[1]), finiteOrZero(ent.angles[2])).angleVectors();
    Camera.refdef.vieworg[0] += V.ofsx.value * forward[0] + V.ofsy.value * right[0] + V.ofsz.value * up[0];
    Camera.refdef.vieworg[1] += V.ofsx.value * forward[1] + V.ofsy.value * right[1] + V.ofsz.value * up[1];
    Camera.refdef.vieworg[2] += V.ofsx.value * forward[2] + V.ofsy.value * right[2] + V.ofsz.value * up[2];

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
    view.origin[0] += right[0] * V.#viewmodelLookBobRight + up[0] * V.#viewmodelLookBobUp;
    view.origin[1] += right[1] * V.#viewmodelLookBobRight + up[1] * V.#viewmodelLookBobUp;
    view.origin[2] += right[2] * V.#viewmodelLookBobRight + up[2] * V.#viewmodelLookBobUp;
    view.angles[1] += V.#viewmodelLookBobRight * 0.45;
    view.angles[0] += V.#viewmodelLookBobUp * 0.35;
    view.angles[2] -= V.#viewmodelLookBobRight * 0.25;
    switch (SCR.viewsize.value) {
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

    if (clientRuntimeState.onground && (ent.origin[2] - V.oldz) > 0.0) {
      let steptime = Host.frametime;
      if (steptime < 0.0) {
        steptime = 0.0;
      }
      V.oldz += steptime * 80.0;
      if (V.oldz > ent.origin[2]) {
        V.oldz = finiteOrZero(ent.origin[2]);
      } else if ((ent.origin[2] - V.oldz) > 12.0) {
        V.oldz = finiteOrZero(ent.origin[2]) - 12.0;
      }
      Camera.refdef.vieworg[2] += V.oldz - finiteOrZero(ent.origin[2]);
      view.origin[2] += V.oldz - finiteOrZero(ent.origin[2]);
    } else {
      V.oldz = finiteOrZero(ent.origin[2]);
    }

    if (clientRuntimeState.gameAPI) {
      clientRuntimeState.gameAPI.updateRefDef(Camera.refdef);
    }

    if (Chase.active.value) {
      Chase.Update();
    }
  }

  static PreRenderView(): void {
    if (ConsoleOverlay.forcedup) {
      return;
    }
    if (clientRuntimeState.maxclients >= 2) {
      Cvar.Set('scr_ofsx', '0');
      Cvar.Set('scr_ofsy', '0');
      Cvar.Set('scr_ofsz', '0');
    }
    if (clientRuntimeState.intermission > 0) {
      V.CalcIntermissionRefdef();
    } else if (!clientRuntimeState.paused) {
      V.CalcRefdef();
    }

    // The refdef is final from here on. Derive what the frame reads from it, in the order each step needs.
    Camera.UpdateViewVectors();
    const viewleaf = Visibility.UpdateViewLeaf();
    V.SetContentsColor(viewleaf.contents);
    V.CalcBlend();
    R.PreRenderScene();
  }

  static RenderView(): void {
    if (ConsoleOverlay.forcedup) {
      return;
    }
    if (!clientRuntimeState.worldmodel) {
      return;
    }
    if (clientStaticState.signon < 4) {
      return;
    }
    DynamicLights.Push();
    R.RenderView();
  }

  static Init(): void {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Cmd.AddCommand('v_cshift', V.cshift_f);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Cmd.AddCommand('bf', V.BonusFlash_f);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Cmd.AddCommand('centerview', V.StartPitchDrift);
    V.centermove = new Cvar('v_centermove', '0.15');
    V.centerspeed = new Cvar('v_centerspeed', '500');
    V.iyaw_cycle = new Cvar('v_iyaw_cycle', '2');
    V.iroll_cycle = new Cvar('v_iroll_cycle', '0.5');
    V.ipitch_cycle = new Cvar('v_ipitch_cycle', '1');
    V.iyaw_level = new Cvar('v_iyaw_level', '0.3');
    V.iroll_level = new Cvar('v_iroll_level', '0.1');
    V.ipitch_level = new Cvar('v_ipitch_level', '0.3');
    V.idlescale = new Cvar('v_idlescale', '0');
    V.cshiftpercent = new Cvar('gl_cshiftpercent', '100');
    V.ofsx = new Cvar('scr_ofsx', '0');
    V.ofsy = new Cvar('scr_ofsy', '0');
    V.ofsz = new Cvar('scr_ofsz', '0');
    V.rollspeed = new Cvar('cl_rollspeed', '200');
    V.rollangle = new Cvar('cl_rollangle', '2.0');
    V.bob = new Cvar('cl_bob', '0.02');
    V.bobcycle = new Cvar('cl_bobcycle', '0.6');
    V.bobup = new Cvar('cl_bobup', '0.5');
    V.kicktime = new Cvar('v_kicktime', '0.5');
    V.kickroll = new Cvar('v_kickroll', '0.6');
    V.kickpitch = new Cvar('v_kickpitch', '0.6');
    V.gamma = new Cvar('gamma', '0.8', Cvar.FLAG.ARCHIVE | Cvar.FLAG.CHEAT); // CR: 1 is too dark
    V.pitchdrift = new Cvar('v_pitchdrift', '1', Cvar.FLAG.ARCHIVE, 'Vanilla Quake drift pitch when moving forward.');
  }
}
