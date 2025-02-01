/* global Vector */

import { damage, flags, items, range } from "../Defs.mjs";
import BaseEntity from "../entity/BaseEntity.mjs";
import { PlayerEntity } from "../entity/Player.mjs";
import { ServerGameAPI } from "../GameAPI.mjs";

/**
 * game-wide AI state, used to coordinate AI communication
 */
export class GameAI {
  /**
   * @param {ServerGameAPI} game gameAPI
   */
  constructor(game) {
    this._game = game;
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
    this._game = entity.game;
    this._initialized = false;
    this._declareFields();
  }

  _declareFields() {
  }

  _initialize() {
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

    this._initialized = true;
  }

  /**
   * returns the range catagorization of an entity reletive to self
   * 0	melee range, will become hostile even if back is turned
   * 1	visibility and infront, or visibility and show hostile
   * 2	infront and show hostile
   * 3	only triggered by damage
   * @param {BaseEntity} target target to check
   * @returns {range} determined range
   */
  _determineRange(target) { // QuakeC: ai.qc/range
    const self = this._entity;
    const spot1 = self.origin.copy().add(self.view_ofs);
    const spot2 = target.origin.copy().add(target.view_ofs);

    const r = spot1.subtract(spot2).len();

    if (r < 120) {
      return range.RANGE_MELEE;
    }

    if (r < 500) {
      return range.RANGE_NEAR;
    }

    if (r < 1000) {
      return range.RANGE_MID;
    }

    return range.RANGE_FAR;
  }

  _changeYaw() {
    return this._entity.changeYaw();
  }

  _checkClient() {
    return this._entity.getNextBestClient();
  }

  think() {
    if (!this._initialized) {
      this._initialize();
    }
  }

  spawn() {
  }

  stand() {
    // implement this
  }

  // eslint-disable-next-line no-unused-vars
  walk(dist) {
    // implement this
  }

  // eslint-disable-next-line no-unused-vars
  run(dist) {
    // implement this
  }
};

const QAI_STATE = {
  STAND: 'stand',
  RUN: 'run',
  WALK: 'walk',
};

/**
 * entity local AI state based on original Quake behavior
 */
export class QuakeEntityAI extends EntityAI {
  _declareFields() {
    /** @type {?BaseEntity} */
    this._sightEntity = null;
    this._sightEntityTime = 0.0;
  }

  _findTarget() { // QuakeC: ai.qc/FindTarget
    // if the first spawnflag bit is set, the monster will only wake up on
    // really seeing the player, not another monster getting angry

    /** @type {?BaseEntity} */
    let client = null;
    const self = this._entity;

    // spawnflags & 3 is a big hack, because zombie crucified used the first
    // spawn flag prior to the ambush flag, and I forgot about it, so the second
    // spawn flag works as well
    if (this._sightEntityTime >= this._game.time - 0.1 && !(self.spawnflags & 3)) {
      client = this._sightEntity;

      if (client.enemy.equals(self)) {
        return false;
      }
    } else {
      client = this._checkClient();

      if (!client) {
        return false; // current check entity isn't in PVS
      }
    }

    if (client.equals(self.enemy)) {
      return false;
    }

    if ((client.flags & flags.FL_NOTARGET) || client.items & items.IT_INVISIBILITY) {
      return false;
    }

    const r = this._determineRange(client);

    if (r === range.RANGE_FAR) {
      return false;
    }

    if (!this._isVisible(client)) {
      return false;
    }

    if (r === range.RANGE_NEAR) {
      if (client.show_hostile < this._game.time && !this._isInFront(client)) {
        return false;
      }
    } else if (r === range.RANGE_MID) {
      if (!this._isInFront(client)) {
        return false;
      }
    }

    //
    // got one
    //
    self.enemy = client;
    if (!(self.enemy instanceof PlayerEntity)) {
      self.enemy = self.enemy.enemy;
      if (!(self.enemy instanceof PlayerEntity)) {
        self.enemy = null; // this._game.worldspawn; // CR: unsure about null or worldspawn
        return false;
      }
    }

    this._foundTarget();

    return true;
  }

  _foundTarget() { // QuakeC: ai.qc/FoundTarget
    const self = this._entity;

    console.log('_foundTarget', this._entity.toString(), self.enemy);

    if (self.enemy instanceof PlayerEntity) {
      // let other monsters see this monster for a while
      // FIXME: needs to be global
      this._sightEntity = self;
      this._sightEntityTime = this._game.time;
    }

    self.show_hostile = this._game.time + 1.0;

    this._entity.sightSound();
    this._huntTarget();
  }

  _huntTarget() { // QuakeC: ai.qc/HuntTarget
    const self = this._entity;

    self.goalentity = self.enemy;
    self.ideal_yaw = self.enemy.origin.copy().subtract(self.origin).toYaw();
    self.nextthink = this._game.time + 0.1;

    // TODO: SUB_AttackFinished (1);	// wait a while before first attack

    // TODO
    console.log('_huntTarget', this._entity);
  }

  /**
   * @param {BaseEntity} target target entity
   * @returns {boolean} target is visible
   */
  _isVisible(target) { // QuakeC: ai.qc/visible
    const trace = this._entity.tracelineToEntity(target, true);

    if (trace.contents.inOpen && trace.contents.inWater) {
      return false; // sight line crossed contents
    }

    return target.equals(trace.entity); // FIXME: this does not work trace.fraction === 1.0;
  }

  _isInFront(target) { // QuakeC: ai.qc/infront
    const { forward } = this._entity.angles.angleVectors();

    const vec = target.origin.copy().subtract(this._entity.origin);
    const dot = vec.dot(forward);

    return dot > 0.3;
  }

  _chooseTurn(dest3) { // QuakeC: ai.qc/ChooseTurn
    // TODO
  }

  stand() {
    if (this._findTarget()) {
      return;
    }

    if (this._game.time > this._entity.pausetime) {
      this._entity.thinkWalk();
      return;
    }

    // change angle slightly
    // CR: no code here in QuakeC
  }

  walk(dist) {

    // console.log('AI walk', this._entity.edictId, this._entity._stateCurrent, dist);
    // TODO
  }

  run(dist) {
    // console.log('AI run', this._entity.edictId, this._entity._stateCurrent, dist);
    // TODO
  }

  turn() {
    if (this._findTarget()) {
      return;
    }

    this._changeYaw();
  }

  use(userEntity) {
    // TODO: monster_use
  }

  think() {
    super.think();

    switch(this._state) {
      case QAI_STATE.RUN:

    }
  }

  spawn() {
  }
};
