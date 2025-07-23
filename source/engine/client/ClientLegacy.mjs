/**
 * Legacy client-side code for the engine.
 * Classes from this file are used by the client, when the game is not providing a ClientGameAPI implementation.
 */

import Vector from '../../shared/Vector.mjs';
import { effect, modelFlags } from '../../shared/Defs.mjs';
import { BaseClientEdictHandler } from '../../shared/ClientEdict.mjs';

import { registry, eventBus } from '../registry.mjs';

let { CL, R } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  R = registry.R;
});

/**
 * Default client-side edict handler.
 * This class provides the default behavior for client-side entities, in case
 * no specific game implementation is provided.
 */
export class DefaultClientEdictHandler extends BaseClientEdictHandler {
  emit() {
    const clent = this.clientEdict;
    const oldorg = clent.originPrevious;

    if ((clent.model.flags & modelFlags.MF_ROTATE) !== 0) {
      clent.angles[1] = Vector.anglemod(CL.state.time * 100.0);
    }
    if ((clent.effects & effect.EF_BRIGHTFIELD) !== 0) {
      R.EntityParticles(clent);
    }
    if ((clent.effects & effect.EF_MUZZLEFLASH) !== 0) {
      const dl = CL.AllocDlight(clent.num);
      const fv = clent.angles.angleVectors().forward;
      dl.origin = new Vector(
        clent.origin[0] + 18.0 * fv[0],
        clent.origin[1] + 18.0 * fv[1],
        clent.origin[2] + 16.0 + 18.0 * fv[2],
      );
      dl.radius = 200.0 + Math.random() * 32.0;
      dl.minlight = 32.0;
      dl.die = CL.state.mtime[0] + 0.1;
      // dl.color = new Vector(1.0, 0.95, 0.85);
    }
    if ((clent.effects & effect.EF_BRIGHTLIGHT) !== 0) {
      const dl = CL.AllocDlight(clent.num);
      dl.origin = new Vector(clent.origin[0], clent.origin[1], clent.origin[2] + 16.0);
      dl.radius = 400.0 + Math.random() * 32.0;
      dl.die = CL.state.time + 0.001;
    }
    if ((clent.effects & effect.EF_DIMLIGHT) !== 0) {
      const dl = CL.AllocDlight(clent.num);
      dl.origin = new Vector(clent.origin[0], clent.origin[1], clent.origin[2] + 16.0);
      dl.radius = 200.0 + Math.random() * 32.0;
      dl.die = CL.state.time + 0.001;
      // dl.color = new Vector(0.5, 0.5, 1.0);
    }
    if ((clent.model.flags & modelFlags.MF_GIB) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 2);
    } else if ((clent.model.flags & modelFlags.MF_ZOMGIB) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 4);
    } else if ((clent.model.flags & modelFlags.MF_TRACER) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 3);
    } else if ((clent.model.flags & modelFlags.MF_TRACER2) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 5);
    } else if ((clent.model.flags & modelFlags.MF_ROCKET) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 0);
      const dl = CL.AllocDlight(clent.num);
      dl.origin = new Vector(clent.origin[0], clent.origin[1], clent.origin[2]);
      dl.radius = 200.0;
      dl.die = CL.state.time + 0.01;
    } else if ((clent.model.flags & modelFlags.MF_GRENADE) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 1);
    } else if ((clent.model.flags & modelFlags.MF_TRACER3) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 6);
    }
  }

  think() {
    // Default implementation does nothing.
    // Override this method in a subclass to provide custom logic.
  }
};
