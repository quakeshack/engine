import type { ClientEdict } from '../engine/client/ClientEntities.mjs';

type ClientEngineAPI = typeof import('../engine/common/GameAPIs.mjs').ClientEngineAPI;

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
}
