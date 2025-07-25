/** @typedef {typeof import('../../../engine/common/GameAPIs.mjs').ClientEngineAPI} ClientEngineAPI */

import { BaseClientEdictHandler } from '../../../shared/ClientEdict.mjs';
import Vector from '../../../shared/Vector.mjs';

const clientEdictHandlers = {
  misc_fireball_fireball: class FireballEdictHandler extends BaseClientEdictHandler {
    emit() {
      const dl = this.engine.AllocDlight(this.clientEdict.num);

      dl.color = new Vector(1, 0.75, 0.25);
      dl.origin = this.clientEdict.origin.copy();
      dl.radius = 285 + Math.random() * 15;
      dl.die = this.engine.CL.time + 0.1;

      this.engine.RocketTrail(this.clientEdict.originPrevious, this.clientEdict.origin, 1);
      this.engine.RocketTrail(this.clientEdict.originPrevious, this.clientEdict.origin, 6);
    }
  },
};

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

  draw() {
    /** @type {{[key: string]: number}} */
    const entities = {};

    for (const entity of this.engine.GetVisibleEntities()) {
      entities[entity.classname] = (entities[entity.classname] || 0) + 1;
    }

    const sortedEntities = Object.entries(entities).sort((a, b) => b[1] - a[1]);

    for (let i = 0; i < sortedEntities.length && i < 10; i++) {
      const [classname, count] = sortedEntities[i];
      this.engine.DrawString(32, 32 + i * 16, `${count.toFixed(0).padStart(3)} ${classname}`, 1.5);
    }

    this.engine.DrawString(32 + 400, 32, `Time: ${this.engine.CL.time.toFixed(3)}`, 1.5);
  }


  static GetClientEdictHandler(classname) {
    return clientEdictHandlers[classname] || null;
  }

  /**
   * @param {ClientEngineAPI} engineAPI client engine API
   */
  // eslint-disable-next-line no-unused-vars
  static Init(engineAPI) {
  }

  static Shutdown() {
  }

  static IsServerCompatible(version) {
    return version[0] === 1 && version[1] === 0 && version[2] === 0;
  }
};
