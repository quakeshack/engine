import type { ClientEdict } from '../engine/client/ClientEntities.ts';
import type { ClientEngineAPI as ClientEngineApiValue } from '../engine/common/GameAPIs.ts';

type ClientEngineAPI = typeof ClientEngineApiValue;

export class BaseClientEdictHandler {
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
   */
  spawn() {
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
   * Ends this entity's life: frees the underlying client edict so the allocator can recycle it
   * and it stops thinking, emitting, and rendering as of the next frame. Safe to call from
   * think()/emit().
   */
  protected remove(): void {
    this.clientEdict.markFree();
  }
}
