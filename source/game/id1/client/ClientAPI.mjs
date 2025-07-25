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
    return;

    for (const entity of this.engine.GetEntities(true)) {
      if (entity.classname === 'player' || entity.classname === null || entity.classname === 'worldspawn') {
        continue;
      }

      const { x, y, visible } = this.engine.WorldToScreen(entity.origin);

      if (!visible) {
        continue;
      }

      this.engine.DrawString(x - 20, y - 20, entity.num.toString());
      this.engine.DrawRect(x - 20, y - 20, 40, 40, new Vector(0, 0, 0), 0.8);
    }



    return;
    this.engine.DrawString(32, 32, 'hello from ClientGameAPI', 4, new Vector(1, 1, 0));
    this.engine.DrawString(32, 96, `${this.engine.VID.width} x ${this.engine.VID.height}`, 1);

    const { forward } = this.engine.CL.viewangles.angleVectors();
    const start = this.engine.CL.vieworigin;
    const end = start.copy().add(forward.multiply(256));

    const trace = this.engine.Traceline(start, end);

    if (trace.fraction < 1) {
      this.engine.DrawString(32, 128, `looking at ${trace.ent}`, 1);
    }
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
