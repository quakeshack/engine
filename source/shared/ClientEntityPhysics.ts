import type { ClientEdict } from '../engine/client/ClientEntities.ts';
import type { ClientEngineAPI as ClientEngineApiValue, GameTrace } from '../engine/common/GameAPIs.ts';

import Vector from './Vector.ts';
import PhysicsMath from './PhysicsMath.ts';

type ClientEngineAPI = typeof ClientEngineApiValue;

/**
 * Per-entity options for one {@link ClientEntityPhysics.step} call.
 */
interface ClientEntityPhysicsStepOptions {
  /**
   * Multiplier applied to `engine.CL.gravity`, mirroring the role of the server's per-entity
   * `entity.gravity` field. Defaults to `1.0`.
   */
  readonly gravityMultiplier?: number;
  /**
   * Overbounce factor passed to {@link PhysicsMath.clipVelocity} when the entity hits something.
   * `1.0` (the default) slides/absorbs like `MOVETYPE_TOSS`; values above `1.0` reflect
   * increasingly more of the impact velocity back, like `MOVETYPE_BOUNCE`.
   */
  readonly bounce?: number;
}

/**
 * Opt-in gravity + collision helper for client-only simulated entities (debris, shell casings,
 * gibs, ...), mirroring `ServerPhysics.physicsToss()`'s per-frame step without carrying over its
 * server-only concerns (water transitions, ground entity tracking, sound events, `runThink`).
 * Composed by a `BaseClientEdictHandler` the same way server entities compose `EntityWrapper`
 * helpers (`Sub`, `AI`, `DamageHandler`) -- a handler owns its `ClientEdict` 1:1 for the whole
 * edict's lifetime, so unlike `EntityWrapper` this holds a direct reference, no `WeakRef` needed.
 */
export class ClientEntityPhysics {
  #clientEdict: ClientEdict;
  #engine: ClientEngineAPI;

  constructor(clientEdict: ClientEdict, engine: ClientEngineAPI) {
    this.#clientEdict = clientEdict;
    this.#engine = engine;
  }

  /**
   * Integrates gravity and velocity for one frame, collides via `engine.Traceline()`, and clips
   * the resulting velocity with the shared `PhysicsMath.clipVelocity()` -- the same formula
   * `ServerPhysics.physicsToss()` uses. Always moves the entity through `ClientEdict.setOrigin()`
   * (never raw `.origin` mutation) so BSP leafs stay in sync with PVS culling.
   * @returns The trace for this step, so callers can react to impacts (e.g. play a bounce sound,
   * spawn a decal, come to rest).
   */
  step(frametime: number, options?: ClientEntityPhysicsStepOptions): GameTrace {
    const clientEdict = this.#clientEdict;
    const gravityMultiplier = options?.gravityMultiplier ?? 1.0;
    const overbounce = options?.bounce ?? 1.0;

    clientEdict.velocity[2] -= this.#engine.CL.gravity * gravityMultiplier * frametime;

    const end = clientEdict.origin.copy().add(clientEdict.velocity.copy().multiply(frametime));
    const trace = this.#engine.Traceline(clientEdict.origin, end);

    if (trace.solid.all) {
      clientEdict.velocity.clear();
      return trace;
    }

    clientEdict.setOrigin(trace.point);

    if (trace.fraction === 1.0) {
      return trace;
    }

    const clippedVelocity = new Vector();
    PhysicsMath.clipVelocity(clientEdict.velocity, trace.plane.normal, clippedVelocity, overbounce);
    clientEdict.velocity.set(clippedVelocity);

    return trace;
  }
}
