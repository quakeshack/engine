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
 * @readonly
 * @enum {number}
 */
export const QAI_ATTACK_STATE = {
  AS_NONE: 0,
  AS_STRAIGHT: 1,
  AS_SLIDING: 2,
  AS_MELEE: 3,
  AS_MISSILE: 4,
};


/**
 * entity local AI state based on original Quake behavior
 */
export class QuakeEntityAI extends EntityAI {
  _declareFields() {
    /** @type {?BaseEntity} */
    this._sightEntity = null;
    this._sightEntityTime = 0.0;

    this._searchTime = 0;
    /** @type {?BaseEntity} previous acquired target, fallback for dead enemy */
    this._oldEnemy = null;

    this._attackState = QAI_ATTACK_STATE.AS_NONE;
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
        return false; // CR: QuakeC introduces undefined behavior here by invoking an empty return, I hope false is okay for now
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

    self._scheduleThink(this._game.time + 0.1, (entity) => entity.thinkRun());

    self.attackFinished(1.0);	// wait a while before first attack

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

  /**
   * The monster is staying in one place for a while, with slight angle turns
   */
  stand() { // QuakeC: ai.qc/ai_stand
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

  walk(dist) { // QuakeC: ai.qc/ai_walk
    // console.log('AI walk', this._entity.toString(), dist);
    // TODO
  }

  run(dist) { // QuakeC: ai.qc/ai_run
    const self = this._entity;
    // console.log('AI run', this._entity.toString(), dist);
    // TODO

    // movedist = dist;

    // see if the enemy is dead
    if (self.enemy.health <= 0) {
      self.enemy = this._game.worldspawn;
      // FIXME: look all around for other targets (original FIXME from QuakeC)
      if (this._oldenemy?.health > 0) {
        self.enemy = this._oldenemy;
        this._huntTarget();
      } else {
        if (self.movetarget) {
          self.thinkWalk();
        } else {
          self.thinkStand();
        }
        return;
      }
    }

    self.show_hostile = this._game.time + 1.0; // wake up other monsters

    const isEnemyVisible = this._isVisible(self.enemy);

    // check knowledge of enemy
    if (isEnemyVisible) {
      this._searchTime = this._game.time + 5.0;
    }

    // look for other coop players
    if (this._game.coop && this._searchTime < this._game.time) {
      if (this._findTarget()) {
        return;
      }
    }

    // TODO: enemy_infront = infront(self.enemy);
    // TODO: enemy_range = range(self.enemy);
    // TODO: enemy_yaw = vectoyaw(self.enemy.origin - self.origin);

    switch (this._attackState) {
      case QAI_ATTACK_STATE.AS_MISSILE:
        // TODO: ai_run_missile ();
        break;

      case QAI_ATTACK_STATE.AS_MELEE:
        // TODO: ai_run_melee ();
        break;

      case QAI_ATTACK_STATE.AS_SLIDING:
        if (this._checkAnyAttack(isEnemyVisible)) {
          return; // beginning an attack
        }
        // TODO: ai_run_slide ();
        break;

      default:
        if (this._checkAnyAttack(isEnemyVisible)) {
          return; // beginning an attack
        }

        // head straight in
        self.moveToGoal(dist);
        break;
    }
  }

  _checkAnyAttack(isEnemyVisible) { // QuakeC: ai.qc/CheckAnyAttack
    // TODO
    return false;
  }

  turn() { // QuakeC: ai.qc/ai_turn
    if (this._findTarget()) {
      return;
    }

    this._changeYaw();
  }

  use(userEntity) {
    // TODO: monster_use
  }

  spawn() {
  }
};
