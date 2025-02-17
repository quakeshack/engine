export class ClientGameAPI {
  constructor(engineAPI) {
    this.engine = engineAPI;

    Object.seal(this);
  }
};
