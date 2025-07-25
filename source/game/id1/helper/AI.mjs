import Vector from '../../../shared/Vector.mjs';

import { damage, flags, items, range } from '../Defs.mjs';
import BaseEntity from '../entity/BaseEntity.mjs';
import { PathCornerEntity } from '../entity/Misc.mjs';
import BaseMonster from '../entity/monster/BaseMonster.mjs';
import { PlayerEntity } from '../entity/Player.mjs';
import { ServerGameAPI } from '../GameAPI.mjs';
import { EntityWrapper, Serializer } from './MiscHelpers.mjs';

/**
 * Game-wide AI state, used to coordinate AI communication.
 */
export class GameAI {
  /**
   * @param {ServerGameAPI} game gameAPI
   */
  constructor(game) {
    this._game = game;

    /** @type {?BaseEntity} */
    this._sightEntity = null;
    this._sightEntityTime = 0.0;
  }
};

/**
 * EntityAI interface.
 */
export class EntityAI extends EntityWrapper {
  /** @returns {GameAI} global AI state @protected */
  get _gameAI() {
    return this._game.gameAI;
  }

  /** @returns {BaseMonster} augmented monster @protected */
  get _entity() {
    return /** @type {BaseMonster}*/(super._entity);
  }

  clear() {
    // implement this
    console.assert(false, 'implement this');
  }

  think() {
    // implement this
    console.assert(false, 'implement this');
  }

  spawn() {
    // implement this
    console.assert(false, 'implement this');
  }

  stand() {
    // implement this
    console.assert(false, 'implement this');
  }

  // eslint-disable-next-line no-unused-vars
  walk(dist) {
    // implement this
    console.assert(false, 'implement this');
  }

  // eslint-disable-next-line no-unused-vars
  run(dist) {
    // implement this
    console.assert(false, 'implement this');
  }

  // eslint-disable-next-line no-unused-vars
  pain(dist) {
    // implement this
    console.assert(false, 'implement this');
  }

  // eslint-disable-next-line no-unused-vars
  charge(dist) {
    // implement this
    console.assert(false, 'implement this');
  }

  face() {
    // implement this
    console.assert(false, 'implement this');
  }

  /**
   * Finds a target entity for the AI to interact with.
   */
  findTarget() {
    // implement this
    console.assert(false, 'implement this');
  }

  /**
   * Signalizes that a target entity has been found.
   * @param {BaseEntity} targetEntity entity to focus on
   */
  // eslint-disable-next-line no-unused-vars
  foundTarget(targetEntity) {
    // implement this
    console.assert(false, 'implement this');
  }

  // eslint-disable-next-line no-unused-vars
  use(userEntity) {
    // implement this
    console.assert(false, 'implement this');
  }
};

/**
 * Normalizes an angle to the range [0, 360).
 * @param {number} v - The angle to normalize.
 * @returns {number} The normalized angle.
 */
function anglemod(v) {
  while (v >= 360) {
    v -= 360;
  }
  while (v < 0) {
    v += 360;
  }
  return v;
}

/**
 * @readonly
 * @enum {number}
 */
export const ATTACK_STATE = {
  AS_NONE: 0,
  AS_STRAIGHT: 1,
  AS_SLIDING: 2,
  AS_MELEE: 3,
  /** any long-range attack, can be missiles or hit scanning */
  AS_MISSILE: 4,
};

/**
 * entity local AI state based on original Quake behavior
 */
export class QuakeEntityAI extends EntityAI {
  /**
   * @param {BaseMonster} entity NPC
   */
  constructor(entity) {
    super(entity);

    this._serializer = new Serializer(this);

    this._serializer.startFields();

    /** @private */
    this._searchTime = 0;
    /** @type {?BaseEntity} previous acquired target, fallback for dead enemy @private */
    this._oldEnemy = null;
    /** @private */
    this._attackState = ATTACK_STATE.AS_NONE;

    /** @private */
    this._enemyMetadata = {
      isVisible: false, // QuakeC: enemy_vis
      infront: false, // QuakeC: enemy_infront
      range: range.RANGE_FAR, // QuakeC: enemy_range
      yaw: null, // QuakeC: enemy_yaw
    };

    Serializer.makeSerializable(this._enemyMetadata, this._engine);

    /** @private */
    this._lookingLeft = false; // QuakeC: lefty

    /** @private */
    this._moveDistance = 0;

    /** @private */
    this._initialized = false;

    this._serializer.endFields();

    Object.seal(this);
  }

  clear() {
    this._searchTime = 0;
    this._oldEnemy = null;
    this._lookingLeft = false;
    this._moveDistance = 0;
    this._attackState = ATTACK_STATE.AS_NONE;
    this._enemyMetadata.isVisible = false;
    this._enemyMetadata.infront = false;
    this._enemyMetadata.range = range.RANGE_FAR;
    this._enemyMetadata.yaw = null;
  }

  /**
   * @returns {range} the determined range of the enemy
   */
  get enemyRange() {
    return this._enemyMetadata.range;
  }

  /**
   * @returns {boolean} true if the enemy is visible
   */
  get enemyIsVisible() {
    return this._enemyMetadata.isVisible;
  }

  think() {
    if (!this._initialized) {
      this._initialize();
    }
  }

  _initialize() {
    const self = this._entity;

    self.origin[2] += 1.0; // raise off floor a bit
    self.dropToFloor();

    // check for stuck enemies
    if (!self.walkMove(0, 0)) {
      self.engine.ConsoleDebug(`${self} stuck in wall at ${self.origin}\n`);
    }

    self.takedamage = damage.DAMAGE_AIM;

    self.ideal_yaw = self.angles.dot(new Vector(0.0, 1.0, 0.0));

    if (!self.yaw_speed) {
      self.yaw_speed = 20.0;
    }

    self.view_ofs = new Vector(0.0, 0.0, 25.0);
    self.flags |= flags.FL_MONSTER;

    if (self.target) {
      const target = this._entity.findFirstEntityByFieldAndValue('targetname', self.target);
      console.assert(target !== null, 'target must resolve');

      self.goalentity = self.movetarget = target;
      self.ideal_yaw = target.origin.copy().subtract(self.origin).toYaw();

      if (target instanceof PathCornerEntity) {
        self.thinkWalk();
      } else {
        self.pausetime = Infinity;
        self.thinkStand();
      }
    } else {
      self.pausetime = Infinity;
      self.thinkStand();
    }

    // spread think times so they don't all happen at same time
    self.nextthink = self.nextthink + Math.random() * 0.5;

    this._initialized = true;
  }

  /**
   * returns the range catagorization of an entity reletive to self
   * 0 melee range, will become hostile even if back is turned
   * 1 visibility and infront, or visibility and show hostile
   * 2 infront and show hostile
   * 3 only triggered by damage
   * @param {BaseEntity} target target to check
   * @returns {range} determined range
   */
  _determineRange(target) { // QuakeC: ai.qc/range
    const spot1 = this._entity.origin.copy().add(this._entity.view_ofs);
    const spot2 = target.origin.copy().add(target.view_ofs);

    const r = spot1.distanceTo(spot2);

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
    if (this._enemyMetadata.yaw !== null) {
      this._entity.ideal_yaw = this._enemyMetadata.yaw;
    }

    return this._entity.changeYaw();
  }

  _checkClient() {
    return this._entity.getNextBestClient();
  }

  findTarget() { // QuakeC: ai.qc/FindTarget
    // if the first spawnflag bit is set, the monster will only wake up on
    // really seeing the player, not another monster getting angry

    /** @type {?BaseEntity} */
    let client = null;
    const self = this._entity;

    // spawnflags & 3 is a big hack, because zombie crucified used the first
    // spawn flag prior to the ambush flag, and I forgot about it, so the second
    // spawn flag works as well
    if (this._gameAI._sightEntityTime >= this._game.time - 0.1 && !(self.spawnflags & 3)) {
      client = this._gameAI._sightEntity;

      if (client.enemy.equals(self)) {
        return false; // CR: QuakeC introduces undefined behavior here by invoking an empty return, I hope false is okay for now
      }
    } else {
      client = this._checkClient();

      if (!client) {
        return false; // current check entity isn't in PVS
      }
    }

    // already found that one
    if (client.equals(self.enemy)) {
      return false;
    }

    // client got invisibility or has notarget set
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

    // got one, trying to resolve the enemy chain first
    self.enemy = client;
    if (!(self.enemy instanceof PlayerEntity)) {
      self.enemy = self.enemy.enemy;
      if (!(self.enemy instanceof PlayerEntity)) {
        self.enemy = this._game.worldspawn;
        // self.enemy = null; // this._game.worldspawn; // CR: unsure about null or worldspawn
        return false;
      }
    }

    this.foundTarget(self.enemy);

    return true;
  }

  /**
   * Signalizes that a target entity has been found.
   * Important: When called from thinkPain, make sure you want to break the current attack!
   * @param {BaseEntity} targetEntity enemy
   */
  foundTarget(targetEntity) { // QuakeC: ai.qc/FoundTarget
    this._entity.enemy = targetEntity;

    // console.log('NPC found target', this._entity, targetEntity);

    if (this._entity.enemy instanceof PlayerEntity) {
      // let other monsters see this monster for a while
      this._gameAI._sightEntity = this._entity;
      this._gameAI._sightEntityTime = this._game.time;
    }

    this._entity.show_hostile = this._game.time + 1.0;

    this._entity.sightSound();
    this._huntTarget();
  }

  _huntTarget() { // QuakeC: ai.qc/HuntTarget
    if (this._entity.health <= 0) {
      return;
    }

    console.assert(this._entity.enemy, 'Missing enemy');

    this._entity.goalentity = this._entity.enemy;
    this._entity.ideal_yaw = this._entity.enemy.origin.copy().subtract(this._entity.origin).toYaw();

    // NOTE: keep it at 50 ms otherwise there will be a racy condition with the animation thinker causing dead monsters attacking the player
    this._entity._scheduleThink(this._game.time + 0.05, this._entity.thinkRun);

    this._entity.attackFinished(1.0); // wait a while before first attack

    // console.log('_huntTarget', this._entity);
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
    vec.normalize();

    return vec.dot(forward) > 0.3;
  }

  // eslint-disable-next-line no-unused-vars
  _chooseTurn(dest3) { // QuakeC: ai.qc/ChooseTurn
    // NOT TO BE IMPLEMENTED, UNUSED
  }

  _isFacingIdeal() { // QuakeC: ai.qc/FacingIdeal
    const delta = anglemod(this._entity.angles[1] - this._entity.ideal_yaw);

    return !(delta > 45 && delta < 315);
  }

  painforward(dist) { // QuakeC: ai.qc/ai_painforward
    this._entity.walkMove(this._entity.ideal_yaw, dist);
  }

  /**
   * The monster is staying in one place for a while, with slight angle turns
   */
  stand() { // QuakeC: ai.qc/ai_stand
    if (this.findTarget()) {
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
    this._moveDistance = dist;

    // passing down the logic to the BaseMonster
    this._entity.walk(dist);
  }

  runMelee(){ // QuakeC: ai.qc/ai_run_melee
    this._changeYaw();

    if (this._isFacingIdeal()) {
      this._entity.thinkMelee();
      this._attackState = ATTACK_STATE.AS_STRAIGHT;
    }
  }

  runMissile() { // QuakeC: ai.qc/ai_run_missile
    this._changeYaw();

    if (this._isFacingIdeal()) {
      this._entity.thinkMissile();
      this._attackState = ATTACK_STATE.AS_STRAIGHT;
    }
  }

  runSlide() { // QuakeC: ai.qc/ai_run_slide
    this._changeYaw();

    if (this._entity.walkMove(this._entity.ideal_yaw + (this._lookingLeft ? 90 : -90), this._moveDistance)) {
      return;
    }

    this._lookingLeft = !this._lookingLeft;

    this._entity.walkMove(this._entity.ideal_yaw + (this._lookingLeft ? 90 : -90), this._moveDistance);
  }

  run(dist) { // QuakeC: ai.qc/ai_run
    // console.log('AI run', this._entity.toString(), dist);

    this._moveDistance = dist;

    // see if the enemy is dead
    if (this._entity.enemy?.health <= 0) {
      this._entity.enemy = null;
      // FIXME: look all around for other targets (original FIXME from QuakeC)
      if (this._oldenemy?.health > 0) {
        this._entity.enemy = this._oldenemy;
        this._huntTarget();
      } else {
        if (this._entity.movetarget) {
          this._entity.thinkWalk();
        } else {
          this._entity.thinkStand();
        }
        return;
      }
    }

    this._entity.show_hostile = this._game.time + 1.0; // wake up other monsters

    const isEnemyVisible = this._entity.enemy ? this._isVisible(this._entity.enemy) : false;

    // check knowledge of enemy
    if (isEnemyVisible) {
      this._searchTime = this._game.time + 5.0;
    }

    // look for other coop players
    if (this._game.coop && this._searchTime < this._game.time) {
      if (this.findTarget()) {
        return;
      }
    }

    if (this._entity.enemy) {
      this._enemyMetadata.isVisible = isEnemyVisible;
      this._enemyMetadata.infront = this._isInFront(this._entity.enemy);
      this._enemyMetadata.range = this._determineRange(this._entity.enemy);
      this._enemyMetadata.yaw = this._entity.enemy.origin.copy().subtract(this._entity.origin).toYaw();
    } else {
      this._enemyMetadata.isVisible = false;
    }

    switch (this._attackState) {
      case ATTACK_STATE.AS_MISSILE:
        this.runMissile();
        return;

      case ATTACK_STATE.AS_MELEE:
        this.runMelee();
        return;
    }

    const nextAttackState = this._checkAnyAttack(isEnemyVisible);

    if (nextAttackState !== null) {
      this._attackState = nextAttackState;
      return; // beginning an attack
    }

    if (this._attackState === ATTACK_STATE.AS_SLIDING) {
      this.runSlide();
      return;
    }

    // head straight in
    if (this._entity.goalentity) {
      this._entity.moveToGoal(dist);
    }
  }

  _checkAnyAttack(isEnemyVisible) { // QuakeC: ai.qc/CheckAnyAttack
    if (!isEnemyVisible) {
      return null;
    }

    return this._entity.checkAttack();
  }

  turn() { // QuakeC: ai.qc/ai_turn
    if (this.findTarget()) {
      return;
    }

    this._changeYaw();
  }

  charge(dist) { // QuakeC: ai.qc/ai_charge
    this.face();
    this._entity.moveToGoal(dist);
  }

  chargeSide() { // QuakeC: fight.qc/ai_charge_side
    const self = this._entity;

    // Aim to the left of the enemy for a flyby
    self.ideal_yaw = self.enemy.origin.copy().subtract(self.origin).toYaw();
    self.changeYaw();

    const { right } = self.angles.angleVectors();
    const dtemp = self.enemy.origin.copy().subtract(right.multiply(30));
    const heading = dtemp.subtract(self.origin).toYaw();

    self.walkMove(heading, 20);
  }

  melee() { // QuakeC: fight.qc/ai_melee
    if (!this._entity.enemy) {
      return; // removed before stroke
    }

    const delta = this._entity.enemy.origin.copy().subtract(this._entity.origin);

    if (delta.len() > 60) {
      return;
    }

    const ldmg = (Math.random() + Math.random() + Math.random()) * 3;
    this._entity.damage(this._entity.enemy, ldmg);
  }

  meleeSide() { // QuakeC: fight.qc/ai_melee_side
    if (!this._entity.enemy) {
      return; // removed before stroke
    }

    this.chargeSide();

    const delta = this._entity.enemy.origin.copy().subtract(this._entity.origin);

    if (delta.len() > 60) {
      return;
    }

    if (!this._entity.enemy.canReceiveDamage(this._entity)) {
      return;
    }

    const ldmg = (Math.random() + Math.random() + Math.random()) * 3;
    this._entity.damage(this._entity.enemy, ldmg);
  }

  face() {
    console.assert(this._entity.enemy instanceof BaseEntity, 'valid enemy required');
    this._entity.ideal_yaw = this._entity.enemy.origin.copy().subtract(this._entity.origin).toYaw();
    this._entity.changeYaw();
  }

  forward(dist) {
    this._entity.walkMove(this._entity.angles[1] + 180, dist);
  }

  back(dist) {
    this._entity.walkMove(this._entity.angles[1], dist);
  }

  pain(dist) {
    this.back(dist);
  }

  use(userEntity) {
    if (this._entity.enemy) {
      return;
    }

    if (this._entity.health <= 0) {
      return;
    }

    if (userEntity.items & items.IT_INVISIBILITY) {
      return;
    }

    if (userEntity.flags & flags.FL_NOTARGET) {
      return;
    }

    if (!(userEntity instanceof PlayerEntity)) {
      return;
    }

    this._entity.enemy = userEntity; // we need this in the next think and we cannot pass it along via the scope due to possible serialization
    this._entity._scheduleThink(this._game.time + 0.1, function () { this._ai.foundTarget(this.enemy); });
  }

  spawn() {
  }
};
