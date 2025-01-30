import BaseEntity from "../entity/BaseEntity.mjs";
import { ServerGameAPI } from "../GameAPI.mjs";

export class GameAI {
  /**
   *
   * @param {ServerGameAPI} game
   */
  constructor(game) {
    this.game = game;
  }
};

export class EntityAI {
  /**
   * @param {BaseEntity} entity
   */
  constructor(entity) {
    this.entity = entity;
  }

  stand() {
    // TODO
  }

  walk() {
    // TODO
  }

};
