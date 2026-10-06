import type { ClientEdict } from './ClientEntities.ts';
import type { GameTrace } from '../common/GameApiSupport.ts';
import type { CollisionTrace } from '../server/physics/ServerCollisionSupport.ts';

import Vector, { Quaternion } from '../../shared/Vector.ts';
import PhysicsMath from '../common/PhysicsMath.ts';
import { moveType } from '../../shared/Defs.ts';
import { getClientRegistry } from '../registry.ts';
import { eventBus } from '../common/EventBus.ts';

let { CL } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL } = getClientRegistry());
});

/**
 * Overbounce factor of `MOVETYPE_BOUNCE`, as `ServerPhysics.physicsToss()` applies it.
 */
const BOUNCE_OVERBOUNCE = 1.5;

/**
 * Overbounce factor of `MOVETYPE_TOSS`: slides along the plane it hit instead of bouncing.
 */
const TOSS_OVERBOUNCE = 1.0;

/**
 * Engine-driven physics of client-only entities (gibs, shell casings, debris, ...). An entity opts
 * in by setting `ClientEdict.movetype` to `MOVETYPE_TOSS` or `MOVETYPE_BOUNCE` (and `avelocity` for a
 * tumble); `ClientEntities.think()` then steps it every frame before its handler's `think()`, and
 * tells the handler about it through `impact()` and `rest()`. A handler never steps anything.
 *
 * It mirrors the part of `ServerPhysics.physicsToss()` that applies to cosmetic entities, without
 * the server-only concerns (water transitions, ground entity tracking, sound events, `runThink`),
 * and shares the bounce formula and the rest rule with it through `PhysicsMath`.
 */
export default class ClientEntityPhysics {
  static readonly #end = new Vector();
  static readonly #angularStep = new Vector();
  static readonly #clippedVelocity = new Vector();

  /**
   * Steps one `MOVETYPE_TOSS` or `MOVETYPE_BOUNCE` entity that is not at rest: gravity, the tumble
   * from `avelocity`, a world trace, and a velocity clip against the plane it hit. Moves the entity
   * through `ClientEdict.setOrigin()`, never by writing `origin`, so its BSP leafs stay in sync with
   * the PVS culling. An entity that starts and stays inside solid, or that hits a floor-like plane
   * slowly enough, comes to rest: `onGround` is set and it is not stepped again.
   * @param clent the entity to step
   * @param frametime seconds since the last step
   */
  static step(clent: ClientEdict, frametime: number): void {
    const bounces = clent.movetype === moveType.MOVETYPE_BOUNCE;
    clent.velocity[2] -= CL.pmove.movevars.gravity * clent.gravity * frametime;

    if (!clent.avelocity.isOrigin()) {
      ClientEntityPhysics.#angularStep.set(clent.avelocity).multiply(frametime);
      clent.angles.set(Vector.fromQuaternion(
        Quaternion.fromVector(clent.angles).multiply(Quaternion.fromVector(ClientEntityPhysics.#angularStep)),
      ));
    }

    const end = ClientEntityPhysics.#end.set(clent.velocity).multiply(frametime).add(clent.origin);
    const trace = CL.collision.traceStaticWorldLine(clent.origin, end);

    if (trace.allsolid) {
      ClientEntityPhysics.#settle(clent);
      return;
    }

    clent.setOrigin(trace.endpos);

    if (trace.fraction === 1.0) {
      return;
    }

    const clipped = ClientEntityPhysics.#clippedVelocity;
    PhysicsMath.clipVelocity(clent.velocity, trace.plane.normal, clipped, bounces ? BOUNCE_OVERBOUNCE : TOSS_OVERBOUNCE);
    clent.velocity.set(clipped);

    clent.impact(ClientEntityPhysics.#toGameTrace(trace));

    if (PhysicsMath.shouldComeToRest(trace.plane.normal[2], clent.velocity[2], bounces)) {
      ClientEntityPhysics.#settle(clent);
    }
  }

  static #settle(clent: ClientEdict): void {
    clent.velocity.clear();
    clent.avelocity.clear();
    clent.onGround = true;
    clent.rest();
  }

  static #toGameTrace(trace: CollisionTrace): GameTrace {
    return {
      solid: { all: trace.allsolid, start: trace.startsolid },
      fraction: trace.fraction,
      plane: { normal: trace.plane.normal, distance: trace.plane.dist },
      contents: { inOpen: trace.inopen, inWater: trace.inwater },
      point: trace.endpos,
      entity: null,
    };
  }
}
