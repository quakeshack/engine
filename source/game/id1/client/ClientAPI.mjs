/** @typedef {typeof import('../../../engine/common/GameAPIs.mjs').ClientEngineAPI} ClientEngineAPI */

export class ClientGameAPI {
  /**
   * @param {ClientEngineAPI} engineAPI client engine API
   */
  constructor(engineAPI) {
    this.engine = engineAPI;

    Object.seal(this);
  }

  init() {
  }

  shutdown() {
  }

  /**
   * @param {ClientEngineAPI} engineAPI client engine API
   */
  static Init(engineAPI) {
    const eventBus = engineAPI.eventBus;

    eventBus.subscribe('host.ready', () => {
      console.log('engine ready', engineAPI.gameFlavors);
    });
  }

  static Shutdown() {
  }

  static IsServerCompatible(version) {
    return version[0] === 1 && version[1] === 0 && version[2] === 0;
  }
};
