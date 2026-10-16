import type { BrushModel } from '../../common/model/BSP.ts';

import type Vector from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';

/**
 * Returns the contents at the specified world position through the point hull of the world model.
 * @param worldmodel World model that owns hull 0.
 * @param p Position to sample.
 * @returns World content, with the current volumes counted as water.
 */
export function pointContents(worldmodel: BrushModel, p: Vector): number {
  const cont = worldmodel.hulls[0].pointContents(p, 0);

  if (cont <= Defs.content.CONTENT_CURRENT_0 && cont >= Defs.content.CONTENT_CURRENT_DOWN) {
    return Defs.content.CONTENT_WATER;
  }

  return cont;
}
