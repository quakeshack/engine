import Vector from '../../../../shared/Vector.mjs';

import { damage, moveType, solid, range, colors } from '../../Defs.mjs';
import { EntityAI, ATTACK_STATE } from '../../helper/AI.mjs';
import BaseEntity from '../BaseEntity.mjs';
import { BackpackEntity } from '../Items.mjs';
import { GibEntity } from '../Player.mjs';
import { Sub } from '../Subs.mjs';
import { DamageHandler } from '../Weapons.mjs';

export default class BaseMonster extends BaseEntity {

  static _health = 0;
  static _size = [null, null];

  static _modelDefault = null;
  static _modelHead = 'progs/gib1.mdl';

  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    this.pausetime = 0;
    this.pain_finished = 0;
    /** @type {?BaseEntity} */
    this.movetarget = null; // entity
    this.health = 0;

    this.ideal_yaw = 0.0;
    this.yaw_speed = 0.0;
    this.view_ofs = new Vector();

    this.bloodcolor = colors.BLOOD;

    /** @type {?BaseEntity} acquired target */
    this.enemy = null;
    /** @type {?BaseEntity} a movetarget or an enemy */
    this.goalentity = null;

    /** @type {number} refire count for nightmare */
    this.cnt = 0;

    /** @type {EntityAI} @protected */
    this._ai = this._newEntityAI();

    this._serializer.endFields();

    this._damageHandler = new DamageHandler(this);
    this._sub = new Sub(this);
  }

  get v_angle() {
    return this.angles;
  }

  _precache() {
    // precache monster model
    this.engine.PrecacheModel(this.constructor._modelDefault);
    this.engine.PrecacheModel(this.constructor._modelHead);

    // gib assets
    this.engine.PrecacheModel('progs/gib1.mdl');
    this.engine.PrecacheModel('progs/gib2.mdl');
    this.engine.PrecacheModel('progs/gib3.mdl');
    this.engine.PrecacheSound('player/udeath.wav');
  }

  /**
   * this is used to override a better or more suitable AI for this entity
   * @protected
   * @returns {EntityAI} responsible entity AI
   */
  _newEntityAI() {
    return new EntityAI(this);
  }

  /**
   * Turns this monster into gibs.
   * @protected
   * @param {boolean} playSound play sound upon gib
   */
  _gib(playSound) {
    GibEntity.gibEntity(this, this.constructor._modelHead, playSound);
  }

  isActor() {
    return true;
  }

  clear() {
    super.clear();
    this.enemy = null;
    this.goalentity = null;
    this.movetarget = null;
    this._ai.clear();
  }

  /**
   * when stands idle
   */
  thinkStand() {
  }

  /**
   * when walking
   */
  thinkWalk() {
  }

  /**
   * when running
   */
  thinkRun() {
  }

  /**
   * when missile is flying towards
   */
  thinkMissile() {
  }

  /**
   * when fighting in melee
   */
  thinkMelee() {
  }

  /**
   * when dying
   * @param {BaseEntity} attackerEntity attacker entity
   */
  // eslint-disable-next-line no-unused-vars
  thinkDie(attackerEntity) {
  }

  /**
   * when getting attacked
   * @param {BaseEntity} attackerEntity attacker entity
   * @param {number} damage damage
   */
  // eslint-disable-next-line no-unused-vars
  thinkPain(attackerEntity, damage) {
    this._ai.foundTarget(attackerEntity);
  }

  /**
   * Called by the AI code.
   * @returns {*} desired attack state
   */
  checkAttack() { // QuakeC: fight.qc/CheckAttack
    const target = this.enemy;
    if (!target) {
      return null;
    }
    // clear shot check
    const trace = this.tracelineToEntity(target, false);
    if (trace.entity !== target) {
      return null;
    }
    if (trace.contents.inOpen && trace.contents.inWater) {
      return null;
    }
    const enemyRange = this._ai.enemyRange;
    // melee attack if supported
    if (enemyRange === range.RANGE_MELEE && this.hasMeleeAttack()) {
      return ATTACK_STATE.AS_MELEE;
    }
    // missile attack only if supported
    if (!this.hasMissileAttack()) {
      return null;
    }
    if (this.game.time < this.attack_finished)  {
      return null;
    }
    if (enemyRange === range.RANGE_FAR) {
      return null;
    }
    let chance = 0;
    if (enemyRange === range.RANGE_MELEE) {
      chance = 0.9;
      this.attackFinished(0);
    } else if (enemyRange === range.RANGE_NEAR) {
      chance = this.hasMeleeAttack() ? 0.2 : 0.4;
    } else if (enemyRange === range.RANGE_MID) {
      chance = this.hasMeleeAttack() ? 0.05 : 0.1;
    }
    if (Math.random() < chance) {
      this.attackFinished(2 * Math.random());
      return ATTACK_STATE.AS_MISSILE;
    }
    return null;
  }

  /**
   * Whether this monster supports melee attacks.
   * @protected
   * @returns {boolean} true, if supported
   */
  hasMeleeAttack() {
    return false;
  }

  /**
   * Whether this monster supports long-range attacks such as missiles or hit scanning.
   * @protected
   * @returns {boolean} true, if supported
   */
  hasMissileAttack() {
    return false;
  }

  _preSpawn() {
    if (this.game.deathmatch || this.game.nomonsters) {
      this.remove();
      return false;
    }

    return true;
  }

  _postSpawn() {
    this.game.total_monsters++;
    this._ai.spawn();

    this._scheduleThink(this.nextthink + Math.random() * 0.5, () => this._ai.think());
  }

  spawn() {
    if (!this._preSpawn()) {
      return;
    }

    const [mins, maxs] = this.constructor._size;

    console.assert(this.constructor._modelDefault, 'Monster model not set');
    console.assert(this.constructor._health > 0, 'Invalid health set');
    console.assert(mins instanceof Vector && maxs instanceof Vector, 'Invalid size set');

    this.health = this.constructor._health;
    this.takedamage = damage.DAMAGE_AIM;
    this.solid = solid.SOLID_SLIDEBOX;
    this.movetype = moveType.MOVETYPE_STEP;

    this.setModel(this.constructor._modelDefault);
    this.setSize(mins, maxs);

    this._postSpawn();
  }

  use(userEntity) {
    this._ai.use(userEntity);
  }

  deathSound() {
    // implement: startSound here
  }

  painSound() {
    // implement: startSound here
  }

  sightSound() {
    // implement: startSound here
  }

  idleSound() {
    // implement: startSound here
  }

  attackSound() {
    // implement: startSound here
  }

  walk(dist) {
    if (this._ai.findTarget()) {
      return;
    }

    // TODO: double check logic here, I added this only to prevent errors upon loading a game --CR
    if (!this.goalentity && !this.enemy) {
      return;
    }

    this.moveToGoal(dist);
  }

  /**
   * Currently only called by path_corner when touched and certain checks passed.
   * @param {import('../Misc.mjs').PathCornerEntity} markerEntity marker entity
   * @returns {boolean} true, if next target was found
   */
  moveTargetReached(markerEntity) {
    if (!markerEntity.target) {
      this.goalentity = null;
      this.movetarget = null;
      this.pausetime = Infinity;
      this.thinkStand();
      return false;
    }

    this.goalentity = this.movetarget = this.findFirstEntityByFieldAndValue('targetname', markerEntity.target);

    if (!this.goalentity) {
      this.engine.ConsoleWarning(`${markerEntity} got invalid target ("${markerEntity.target}")\n`);
      this.pausetime = Infinity;
      this.thinkStand();
      return false;
    }

    this.ideal_yaw = this.goalentity.origin.copy().subtract(this.origin).toYaw();

    return true;
  }

  attackFinished(normal) {
    // in nightmare mode, all attack_finished times become 0
    // some monsters refire twice automatically
    this.cnt = 0; // refire count for nightmare
    if (this.game.skill !== 3) {
      this.attack_finished = this.game.time + normal;
    }
  }

  _dropBackpack(backpackParameters) {
    const backpack = this.engine.SpawnEntity(BackpackEntity.classname, {
      origin: this.origin.copy(),
      regeneration_time: 0, // do not regenerate
      remove_after: 120, // remove after 2 minutes
      ...backpackParameters,
    });

    // toss it around
    backpack.toss();
  }

  /**
   * Calculates a trajectory to the target entity.
   * @param {BaseEntity} targetEntity target entity to calculate trajectory to
   * @param {Vector?} origin optional origin, if not set, will be calculated from this monster's origin
   * @param {number} travelTime travel time in seconds, default is 0.9
   * @returns {Vector} trajectory vector (use as velocity value)
   */
  calculateTrajectoryVelocity(targetEntity, origin = null, travelTime = 0.9) {
    if (!origin) {
      origin = this.origin.copy();
    }

    if (!this.game.hasFeature('correct-ballistic-grenades')) {
      // CR: this is the Quake way of calculating the trajectory
      const velocity = targetEntity.origin.copy().subtract(origin);
      velocity.normalize();
      velocity.multiply(600.0);
      velocity[2] = 200.0;
      return velocity;
    }

    const gravity = this.game.gravity;
    const target = targetEntity.view_ofs ? targetEntity.origin.copy().add(targetEntity.view_ofs) : targetEntity.centerPoint;
    const displacement = target.copy().subtract(origin);
    const velocity = displacement.copy();
    velocity.multiply(1 / travelTime);
    velocity[2] = (displacement[2] + 0.5 * gravity * travelTime * travelTime) / travelTime;
    velocity.add(new Vector(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiply(10.0));

    return velocity;
  }

  _refire(nextState) { // QuakeC: subs.qc/SUB_CheckRefire
    if (this.game.skill !== 3) {
      return;
    }

    if (this.cnt === 1) {
      return;
    }

    if (!this.enemy || !this._ai.enemyIsVisible) {
      return;
    }

    this.cnt = 1;

    this._runState(nextState);
  }
};

export class WalkMonster extends BaseMonster {
  _declareFields() {
    super._declareFields();
  }

  spawn() {
    super.spawn();
  }
};

export class FlyMonster extends BaseMonster {
  _declareFields() {
    super._declareFields();
  }

  spawn() {
    super.spawn();
  }
};

export class SwimMonster extends BaseMonster {
  _declareFields() {
    super._declareFields();
  }

  spawn() {
    super.spawn();
  }
};

export class MeatSprayEntity extends BaseEntity {
  static classname = 'misc_gib_meatspray';

  spawn() {
    this.movetype = moveType.MOVETYPE_BOUNCE;
    this.solid = solid.SOLID_NOT;
    this.velocity[2] += 250 + 50 * Math.random();
    this.avelocity = new Vector(3000, 1000, 2000);
    this.ltime = this.game.time;
    this.frame = 0;
    this.flags = 0;

    this.setModel('progs/zom_gib.mdl');
    this.setSize(Vector.origin, Vector.origin);
    this.setOrigin(this.origin);

    this._scheduleThink(this.ltime + 1.0, () => this.remove());
  }

  /**
   * Tosses around a piece of meat.
   * @param {BaseEntity} entity owner entity
   * @param {Vector?} origin optional origin, if not set, will be calculated
   * @param {Vector?} velocity optional velocity, if not set, it will be randomized
   */
  static sprayMeat(entity, origin = null, velocity = null) {
    // TODO: offload this to the client entity side
    if (!origin || !velocity) {
      const { forward, right } = entity.angles.angleVectors();

      if (!origin) {
        origin = entity.origin.copy().add(forward.multiply(16));
      }

      if (!velocity) {
        velocity = entity.velocity.copy().add(right.multiply(Math.random() * 100));
      }
    }

    entity.engine.SpawnEntity(MeatSprayEntity.classname, {
      owner: entity,
      velocity,
      origin,
    });
  }
}
