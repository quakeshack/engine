/* global Vector */

import { damage, flags } from "../Defs.mjs";
import { ServerGameAPI } from "../GameAPI.mjs";

/**
 * game-wide AI state, used to coordinate AI communication
 */
export class GameAI {
  /**
   * @param {ServerGameAPI} game gameAPI
   */
  constructor(game) {
    this.game = game;
  }
};

/**
 * entity local AI state
 */
export class EntityAI {
  /**
   * @param {import('../entity/monster/BaseMonster.mjs').default} entity linked entity
   */
  constructor(entity) {
    this._entity = entity;
  }

  stand() {
    console.log('AI stand', arguments);
    // TODO
  }

  walk() {
    console.log('AI walk', arguments);
    // TODO
  }

  run() {
    console.log('AI run', arguments);
    // TODO
  }

  think() {
    const self = this._entity;

    self.origin[2] += 1.0; // raise off floor a bit
    self.dropToFloor();

    // check for stuck enemies
    if (!self.walkMove(0, 0)) {
      self.engine.debugPrint(`${self} stuck in wall at ${self.origin}\n`);
    }

    self.takedamage = damage.DAMAGE_AIM;

    self.ideal_yaw = self.angles.dot(new Vector(0.0, 1.0, 0.0));

    if (!self.yaw_speed) {
      self.yaw_speed = 20.0;
    }

    self.view_ofs = new Vector(0.0, 0.0, 25.0);
    self.flags |= flags.FL_MONSTER;

    if (self.target) {
      // TODO
    }

    self.pausetime = 99999999;
    self.thinkStand();

    // spread think times so they don't all happen at same time
    self.nextthink = self.nextthink + Math.random() * 0.5;
  }

  use(userEntity) {
    // TODO: monster_use
  }

  spawn() {

  }

};
