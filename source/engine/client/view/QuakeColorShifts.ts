import { content } from '../../../shared/Defs.ts';
import Q from '../../../shared/Q.ts';
import type Vector from '../../../shared/Vector.ts';
import Cmd from '../../common/Cmd.ts';
import * as Def from '../../common/Def.ts';
import Host from '../../common/Host.ts';
import { clientRuntimeState } from '../ClientState.ts';
import PostProcess from '../renderer/postprocess/PostProcess.ts';

/** One shift in Quake's units: red, green and blue 0 to 255, and the alpha 0 to 255. */
type ColorShift = [number, number, number, number];

/** The channel the engine's shifts are set on, which keeps them apart from the ones of a game. */
const CHANNEL = 'engine.color-shifts';

/** The channel of the one-frame tint of a dynamic light the eye is inside of. */
const CORONA_CHANNEL = 'engine.corona';

/**
 * The color shifts the engine tints the view with when a game does not set its own: the liquid the eye is in, the
 * powerup the items say the player has, the damage flash, the pickup flash and four slots for a game. Quake's
 * set, with Quake's colors and decay rates (damage 150, the rest 100 alpha units per second), here until the
 * game's client code sets them (plans/scr-v-split.md, phase 5).
 *
 * The state is the eight slots of `clientRuntimeState.cshifts`. Every frame they decay and are handed to the
 * post-process stack as entries of the `color-shift` effect, one per slot that covers something, in slot order,
 * which is the order Quake mixes them in.
 */
export default class QuakeColorShifts {
  static readonly cshift_empty: ColorShift = [130.0, 80.0, 50.0, 0.0];
  static readonly cshift_water: ColorShift = [130.0, 80.0, 50.0, 128.0];
  static readonly cshift_slime: ColorShift = [0.0, 25.0, 5.0, 150.0];
  static readonly cshift_lava: ColorShift = [255.0, 80.0, 0.0, 150.0];

  /**
   * Registers the console commands that set a shift: `v_cshift` edits the tint of clear air and `bf` flashes
   * the pickup color.
   */
  static Init(): void {
    Cmd.AddCommand('v_cshift', QuakeColorShifts.cshift_f);
    Cmd.AddCommand('bf', QuakeColorShifts.BonusFlash_f);
  }

  /**
   * Console command: sets the color and alpha of the tint of clear air, 0 to 255 each.
   */
  static cshift_f(this: void, ...args: string[]): void {
    const cshift = QuakeColorShifts.cshift_empty;

    for (let i = 0; i < Math.min(args.length, cshift.length); i++) {
      cshift[i] = Q.atoi(args[i]);
    }
  }

  /**
   * Console command: flashes the pickup color.
   */
  static BonusFlash_f(this: void): void {
    const cshift = clientRuntimeState.cshifts[Def.contentShift.bonus];

    cshift[0] = 215.0;
    cshift[1] = 186.0;
    cshift[2] = 69.0;
    cshift[3] = 50.0;
  }

  /**
   * Sets one slot from a game: it takes the color and the alpha at once and decays at 100 alpha units per second.
   * @param slot The slot, `Def.contentShift`.
   * @param color Red, green and blue, each 0 to 1.
   * @param alpha 0 to 1.
   */
  static ContentShift(slot: number, color: Vector, alpha: number): void {
    const cshift = clientRuntimeState.cshifts[slot];

    cshift[0] = color[0] * 255.0;
    cshift[1] = color[1] * 255.0;
    cshift[2] = color[2] * 255.0;
    cshift[3] = alpha * 255.0;
  }

  /**
   * Adds the damage flash on top of what is left of the previous one: 3 alpha units per point of `count`, at
   * most 150, in a color that tells armor from flesh.
   * @param armor How much damage the armor took.
   * @param blood How much damage reached the player.
   * @param count Half the damage, at least 10.
   */
  static Damage(armor: number, blood: number, count: number): void {
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
  }

  /**
   * Picks the tint of the liquid the eye is in. Contents that have no tint keep the previous one.
   * @param contents The contents at the eye.
   */
  static SetContentsColor(contents: content): void {
    switch (contents) {
      case content.CONTENT_EMPTY:
        clientRuntimeState.cshifts[Def.contentShift.contents] = QuakeColorShifts.cshift_empty;
        return;
      case content.CONTENT_LAVA:
        clientRuntimeState.cshifts[Def.contentShift.contents] = QuakeColorShifts.cshift_lava;
        return;
      case content.CONTENT_SLIME:
        clientRuntimeState.cshifts[Def.contentShift.contents] = QuakeColorShifts.cshift_slime;
        return;
      case content.CONTENT_WATER:
        clientRuntimeState.cshifts[Def.contentShift.contents] = QuakeColorShifts.cshift_water;
        return;
    }
  }

  /**
   * Runs one frame of the shifts: the powerup tint from the items, the decay of the flashes, and the result
   * handed to the post-process stack.
   */
  static Update(): void {
    const cshifts = clientRuntimeState.cshifts;
    const powerup = cshifts[Def.contentShift.powerup];

    if ((clientRuntimeState.items & Def.it.quad) !== 0) {
      powerup[0] = 0.0;
      powerup[1] = 0.0;
      powerup[2] = 255.0;
      powerup[3] = 30.0;
    } else if ((clientRuntimeState.items & Def.it.suit) !== 0) {
      powerup[0] = 0.0;
      powerup[1] = 255.0;
      powerup[2] = 0.0;
      powerup[3] = 20.0;
    } else if ((clientRuntimeState.items & Def.it.invisibility) !== 0) {
      powerup[0] = 100.0;
      powerup[1] = 100.0;
      powerup[2] = 100.0;
      powerup[3] = 100.0;
    } else if ((clientRuntimeState.items & Def.it.invulnerability) !== 0) {
      powerup[0] = 255.0;
      powerup[1] = 255.0;
      powerup[2] = 0.0;
      powerup[3] = 30.0;
    } else {
      powerup[3] = 0.0;
    }

    cshifts[Def.contentShift.damage][3] = Math.max(cshifts[Def.contentShift.damage][3] - Host.frametime * 150.0, 0.0);
    cshifts[Def.contentShift.bonus][3] = Math.max(cshifts[Def.contentShift.bonus][3] - Host.frametime * 100.0, 0.0);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    for (let i = Def.contentShift.user1; i < cshifts.length; i++) {
      cshifts[i][3] = Math.max(cshifts[i][3] - Host.frametime * 100.0, 0.0);
    }

    // one entry per slot that covers something, in slot order; the tint of an empty stack costs nothing
    const entries = [];

    for (const cshift of cshifts) {
      if (cshift[3] > 0.0) {
        entries.push({
          id: 'color-shift' as const,
          settings: { color: [cshift[0] / 255.0, cshift[1] / 255.0, cshift[2] / 255.0], alpha: cshift[3] / 255.0 },
        });
      }
    }

    PostProcess.setStack(entries, { channel: CHANNEL });
  }

  /**
   * Tints the frame that is being drawn by the glare of a dynamic light the eye is inside of. One frame only,
   * after the shifts of the engine.
   * @param alpha How much the light covers the view, 0 to 1.
   */
  static Corona(alpha: number): void {
    PostProcess.pulse({
      id: 'color-shift',
      settings: { color: [1.0, 0.5, 0.0], alpha },
      timing: {},
    }, { channel: CORONA_CHANNEL });
  }

  /**
   * Takes the engine's shifts off the screen, while there is no 3D view to tint.
   */
  static Clear(): void {
    PostProcess.clearStack(CHANNEL);
  }
}
