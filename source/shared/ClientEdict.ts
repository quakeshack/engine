import type { ClientEdict } from '../engine/client/ClientEntities.ts';
import type { ClientEngineAPI } from '../engine/client/ClientEngineAPI.ts';
import type { GameTrace } from '../engine/common/GameApiSupport.ts';
import type { ClientSerializableValue } from './ClientSerialization.ts';
import type { SerializedData, ServerEngineAPI } from './GameInterfaces.ts';

/**
 * Per-instance inputs a game hands to a client-only entity's {@link BaseClientEdictHandler.spawn},
 * such as a start delay. Supports the same value shapes as `ClientSerialization`.
 */
export type ClientSpawnParameters = Readonly<Record<string, ClientSerializableValue>>;

export class BaseClientEdictHandler {
  /**
   * Declares what the server has to precache for this entity, such as the models it shows: a
   * client only knows the models and sounds the server precached. Called once per map by the
   * game's handler registry, like `BaseEntity._precache()` is for server entities. The default
   * implementation precaches nothing.
   */
  static _precache(_engineAPI: ServerEngineAPI): void {
  }

  /**
   * Client edict instance.
   */
  clientEdict: ClientEdict;

  /**
   * Client engine API.
   */
  engine: ClientEngineAPI;

  constructor(clientEdict: ClientEdict, engineAPI: ClientEngineAPI) {
    this.clientEdict = clientEdict;
    this.engine = engineAPI;
  }

  /**
   * Called when the entity is spawned.
   * @param _parameters Per-instance inputs from whoever spawned the entity, `undefined` for
   * entities that come from the network, a map or a save game.
   */
  spawn(_parameters?: ClientSpawnParameters) {
  }

  /**
   * Called when the entity is emitted (to be placed in the world) for a frame.
   * This is where you can handle visual effects, particles, etc.
   * It’s similar to `think`, but only invoked when the entity is visible or relevant for rendering.
   */
  emit() {
  }

  /**
   * Called every frame to update the entity. This happens regardless of whether the entity is visible or not.
   */
  think() {
  }

  /**
   * Called by the engine when the engine-driven physics (`ClientEdict.movetype` of
   * `MOVETYPE_TOSS` or `MOVETYPE_BOUNCE`) hit the world, after the velocity was clipped against the
   * plane. Use it for a bounce sound or a decal. The default implementation does nothing.
   * @param _trace The world hit.
   */
  impact(_trace: GameTrace): void {
  }

  /**
   * Called by the engine once the engine-driven physics came to rest, on a floor-like plane or
   * because the entity is stuck in solid. It is not stepped again after that. The default
   * implementation does nothing.
   */
  rest(): void {
  }

  /**
   * Ends this entity's life: frees the underlying client edict so the allocator can recycle it
   * and it stops thinking, emitting, and rendering as of the next frame. Safe to call from
   * think()/emit().
   */
  protected remove(): void {
    this.clientEdict.markFree();
  }

  /**
   * Captures this handler's own extra state for save/load, alongside the `ClientEdict`'s universal
   * classname/origin/angles/velocity that `ClientEntities.serialize()` already captures on its own.
   * Only called for entities allocated via `ClientEntities.allocateSimulatedEntity()`
   * (`ClientEdict.persistent`); map-baked `svc_spawnstatic` decorations are never saved, since
   * `SV.SpawnServer()` regenerates them from scratch on the next signon. Build the returned value
   * with `ClientSerialization.serialize()` (`source/shared/ClientSerialization.ts`), giving times
   * relative to `engine.CL.time` the same way `R.SerializeParticles()` does for `die`, so they
   * re-anchor correctly against a new session's clock on load. The default implementation saves
   * nothing.
   * @returns This handler's saved extras, or `null` when there is nothing to save.
   */
  serialize(): SerializedData | null {
    return null;
  }

  /**
   * Restores this handler's extra state from the value `serialize()` returned, after
   * `ClientEntities.deserialize()` has already re-created the edict (`allocateSimulatedEntity()` +
   * `setOrigin()`/angles/velocity + `spawn()`) and before it starts thinking again. Use
   * `ClientSerialization.deserialize()` to unwrap the value, re-anchoring any relative times
   * against the new session's `engine.CL.time`. The default implementation does nothing.
   */
  deserialize(_data: SerializedData): void {
  }
}
