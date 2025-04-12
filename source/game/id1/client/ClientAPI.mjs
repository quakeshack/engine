/* global Game */

export class ClientGameAPI {
  /**
   * @param {Game.ClientEngineInterface} engineAPI client engine API
   */
  constructor(engineAPI) {
    this.engine = engineAPI;

    Object.seal(this);
  }



};
