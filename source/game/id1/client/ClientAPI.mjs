/* global Game */

export class ClientGameAPI {
  /**
   * @param {Game.ClientEngineInterface} engineAPI client engine API
   */
  constructor(engineAPI) {
    this.engine = engineAPI;

    Object.seal(this);
  }

  init() {
  }

  shutdown() {
  }

  static Init() {
  }

  static Shutdown() {
  }

  static IsServerCompatible(version) {
    return version[0] === 1 && version[1] === 0 && version[2] === 0;
  }
};
