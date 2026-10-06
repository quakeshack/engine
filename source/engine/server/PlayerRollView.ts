import type Vector from '../../shared/Vector.ts';
import type { PlayerView } from './ServerDependencies.ts';

import { calcRoll } from '../../shared/PlayerRoll.ts';
import Cvar from '../common/Cvar.ts';

/**
 * The player view a server without a client in its realm uses. The roll cvars carry the names and
 * defaults the client registers, so setting `cl_rollangle` in a config reaches the server as before.
 */
export default class PlayerRollView implements PlayerView {
  readonly #rollspeed = new Cvar('cl_rollspeed', '200');
  readonly #rollangle = new Cvar('cl_rollangle', '2.0');

  CalcRoll(angles: Vector, velocity: Vector): number {
    return calcRoll(angles, velocity, this.#rollspeed.value, this.#rollangle.value);
  }
}
