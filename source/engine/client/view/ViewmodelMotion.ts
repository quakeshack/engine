import { shortestAngleDelta, smoothValue } from '../../../shared/smoothing.ts';
import Host from '../../common/Host.ts';
import { clientRuntimeState } from '../ClientState.ts';
import viewCvars from './ViewCvars.ts';

/**
 * How the weapon model moves against the view: it follows the walking bob of the eye, smoothed, and lags a little
 * behind when the view is turned.
 */
export default class ViewmodelMotion {
  /** The walking bob of the weapon, smoothed. */
  static bob = 0.0;

  /** How far the weapon is pushed to the right by turning, in units. */
  static lookBobRight = 0.0;

  /** How far the weapon is pushed up by looking up or down, in units. */
  static lookBobUp = 0.0;

  static #bobInitialized = false;
  static #previousPitch = 0.0;
  static #previousYaw = 0.0;
  static #lookBobInitialized = false;

  /**
   * Computes the walking bob of the eye from the speed on the ground and the time, Quake's V_CalcBob.
   * @returns How far the eye is raised, from -7 to 4 units; 0 when the bob cvars switch it off.
   */
  static CalcBob(): number {
    if ((viewCvars.bobcycle.value <= 0.0)
      || (viewCvars.bobcycle.value >= 1.0)
      || (viewCvars.bobup.value <= 0.0)
      || (viewCvars.bobup.value >= 1.0)
      || (viewCvars.bob.value === 0.0)) {
      return 0.0;
    }

    let cycle = (clientRuntimeState.time - Math.floor(clientRuntimeState.time / viewCvars.bobcycle.value) * viewCvars.bobcycle.value) / viewCvars.bobcycle.value;
    if (cycle < viewCvars.bobup.value) {
      cycle = Math.PI * cycle / viewCvars.bobup.value;
    } else {
      cycle = Math.PI + Math.PI * (cycle - viewCvars.bobup.value) / (1.0 - viewCvars.bobup.value);
    }
    let bob = Math.hypot(clientRuntimeState.velocity[0], clientRuntimeState.velocity[1]) * viewCvars.bob.value;
    bob = bob * 0.3 + bob * 0.7 * Math.sin(cycle);
    if (bob > 4.0) {
      bob = 4.0;
    } else if (bob < -7.0) {
      bob = -7.0;
    }
    return bob;
  }

  /**
   * Computes where the weapon is pushed to by the turn of the view in a frame.
   * @param pitchDelta Pitch change of the frame in degrees.
   * @param yawDelta Yaw change of the frame in degrees.
   * @returns The right and the up target, in units.
   */
  static ComputeLookBobTargets(pitchDelta: number, yawDelta: number): [number, number] {
    const rightTarget = Math.max(-1.8, Math.min(1.8, -yawDelta * 0.07));
    const upTarget = Math.max(-1.2, Math.min(1.2, pitchDelta * 0.05));
    return [rightTarget, upTarget];
  }

  /**
   * Moves the smoothed bob and the look bob one frame toward where the view says they should be. The first
   * frame after a reset takes the values as they are.
   * @param bob The walking bob of the eye this frame.
   * @param viewPitch Pitch of the view in degrees.
   * @param viewYaw Yaw of the view in degrees.
   */
  static Advance(bob: number, viewPitch: number, viewYaw: number): void {
    if (!ViewmodelMotion.#bobInitialized) {
      ViewmodelMotion.bob = bob;
      ViewmodelMotion.#bobInitialized = true;
    } else {
      ViewmodelMotion.bob = smoothValue(ViewmodelMotion.bob, bob, 72.0, Host.frametime);
    }

    if (!ViewmodelMotion.#lookBobInitialized) {
      ViewmodelMotion.#previousPitch = viewPitch;
      ViewmodelMotion.#previousYaw = viewYaw;
      ViewmodelMotion.lookBobRight = 0.0;
      ViewmodelMotion.lookBobUp = 0.0;
      ViewmodelMotion.#lookBobInitialized = true;
      return;
    }

    const pitchDelta = viewPitch - ViewmodelMotion.#previousPitch;
    const yawDelta = shortestAngleDelta(ViewmodelMotion.#previousYaw, viewYaw);
    const [rightTarget, upTarget] = ViewmodelMotion.ComputeLookBobTargets(pitchDelta, yawDelta);

    ViewmodelMotion.lookBobRight = smoothValue(ViewmodelMotion.lookBobRight, rightTarget, 18.0, Host.frametime);
    ViewmodelMotion.lookBobUp = smoothValue(ViewmodelMotion.lookBobUp, upTarget, 18.0, Host.frametime);
    ViewmodelMotion.#previousPitch = viewPitch;
    ViewmodelMotion.#previousYaw = viewYaw;
  }

  /**
   * Forgets the motion, so that the next frame starts from where the view is: after a map change the weapon
   * must not glide in from where it was in the last one.
   */
  static Reset(): void {
    ViewmodelMotion.bob = 0.0;
    ViewmodelMotion.lookBobRight = 0.0;
    ViewmodelMotion.lookBobUp = 0.0;
    ViewmodelMotion.#bobInitialized = false;
    ViewmodelMotion.#lookBobInitialized = false;
  }
}
