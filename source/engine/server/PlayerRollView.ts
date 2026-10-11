import type Vector from '../../shared/Vector.ts';
import type { PlayerView } from './ServerDependencies.ts';

import { calcRoll } from '../../shared/PlayerRoll.ts';
import Cvar from '../common/Cvar.ts';

/**
 * The player view a server without a client in its realm uses. The roll cvars carry the names and
 * defaults the client registers, so setting `cl_rollangle` in a config reaches the server as before.
 */
export default class PlayerRollView implements PlayerView {
  readonly #cvars: { readonly rollspeed: Cvar; readonly rollangle: Cvar };

  /**
   * @param cvars Where to read the roll from, for a realm whose client creates these variables itself. Read when
   * a roll is asked for, so the object can be filled in later. The variables are created here when left out.
   */
  constructor(cvars?: { readonly rollspeed: Cvar; readonly rollangle: Cvar }) {
    this.#cvars = cvars ?? { rollspeed: new Cvar('cl_rollspeed', '200'), rollangle: new Cvar('cl_rollangle', '2.0') };
  }

  CalcRoll(angles: Vector, velocity: Vector): number {
    return calcRoll(angles, velocity, this.#cvars.rollspeed.value, this.#cvars.rollangle.value);
  }
}
