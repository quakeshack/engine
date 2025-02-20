/* global Vector */

import { channel, content, damage, flags, items, moveType, solid, tentType } from '../Defs.mjs';
import { crandom } from '../helper/MiscHelpers.mjs';
import BaseEntity from './BaseEntity.mjs';

/**
 * called by worldspawn
 * @param engine
 */
export function Precache(engine) {
  // TODO: move “use in c code” precache commands back to the engine
  engine.PrecacheSound("weapons/r_exp3.wav");	// new rocket explosion
  engine.PrecacheSound("weapons/rocket1i.wav");	// spike gun
  engine.PrecacheSound("weapons/sgun1.wav");
  engine.PrecacheSound("weapons/guncock.wav");	// player shotgun
  engine.PrecacheSound("weapons/ric1.wav");	// ricochet (used in c code)
  engine.PrecacheSound("weapons/ric2.wav");	// ricochet (used in c code)
  engine.PrecacheSound("weapons/ric3.wav");	// ricochet (used in c code)
  engine.PrecacheSound("weapons/spike2.wav");	// super spikes
  engine.PrecacheSound("weapons/tink1.wav");	// spikes tink (used in c code)
  engine.PrecacheSound("weapons/grenade.wav");	// grenade launcher
  engine.PrecacheSound("weapons/bounce.wav");		// grenade bounce
  engine.PrecacheSound("weapons/shotgn2.wav");	// super shotgun
}

/** struct holding items and ammo */
export class Backpack {
  constructor() {
    this.ammo_shells = 0;
    this.ammo_nails = 0;
    this.ammo_rockets = 0;
    this.ammo_cells = 0;
    this.items = 0;
  }
}

class EntityWrapper {
  /**
   * @param {import('./BaseEntity.mjs').default} entity wrapped entity
   */
  constructor(entity) {
    /** @protected */
    this._entity = entity;
    /** @protected */
    this._game = this._entity.game;
    /** @protected */
    this._engine = this._entity.engine;

    this._assertEntity();
  }

  /** @protected */
  _assertEntity() {
  }
}

/**
 * Methods to cause damage to something else, e.g. fire bullets etc.
 */
export class DamageInflictor extends EntityWrapper {
  /** @type {BaseEntity} */
  _multiEntity = null;
  /** @type {number} */
  _multiDamage = 0;

  /** @private */
  _clearMultiDamage() {
    this._multiEntity = null;
    this._multiDamage = 0;
  }

  /** @private */
  _applyMultiDamage() {
    if (!this._multiEntity) {
      return;
    }

    this._entity.damage(this._multiEntity, this._multiDamage);
  }


  /**
   * @private
   * @param {BaseEntity} hitEntity traced entity
   * @param {number} damage damage points
   */
  _addMultiDamage(hitEntity, damage) {
    if (!hitEntity.equals(this._multiEntity)) {
      this._applyMultiDamage();
      this._multiEntity = hitEntity;
      this._multiDamage = damage;
    } else {
      this._multiDamage += damage;
    }
  }

  /**
   * @private
   * @param {number} damage damage points
   * @param {Vector} direction shooting direction
   * @param {*} angleVectors v_angle.angleVectors (forward, right, up)
   * @param {*} trace traceline result
   */
  _traceAttack(damage, direction, angleVectors, trace) {
    // FIXME: that velocity thing is out of whack

    // const velocity = direction.copy()
    //   .add(angleVectors.up.copy().multiply(crandom()))
    //   .add(angleVectors.right.copy().multiply(crandom()));

    // velocity.normalize();
    // velocity.add(trace.plane.normal.copy().multiply(2.0)).multiply(40.0);

    const origin = trace.point.subtract(direction.copy().multiply(4.0));

    if (trace.entity && trace.entity.takedamage) {
      /** @type {DamageHandler} */
      const damageHandler = trace.entity._damageHandler;

      if (damageHandler) {
        damageHandler.spawnBlood(damage, origin); // , velocity);
        this._addMultiDamage(trace.entity, damage);
      }
    } else {
      this.dispatchGunshotEvent(origin);
    }
  }

  /**
   * Fires bullets.
   * @param {number} shotcount amount of “bullets”
   * @param {Vector} dir shooting directions
   * @param {Vector} spread spread
   */
  fireBullets(shotcount, dir, spread) {
    const angleVectors = this._entity.v_angle.angleVectors();

    const start = this._entity.origin.copy().add(angleVectors.forward.copy().multiply(10.0));
    start[2] = this._entity.absmin[2] + this._entity.size[2] * 0.7;

    this._clearMultiDamage();

    while (shotcount > 0) {
      const direction = dir.copy()
        .add(angleVectors.right.copy().multiply(spread[0] * crandom()))
        .add(angleVectors.up.copy().multiply(spread[1] * crandom()));

      const trace = this._entity.traceline(start, direction.copy().multiply(2048.0).add(start), false);

      if (trace.fraction !== 1.0) {
        this._traceAttack(4.0, direction, angleVectors, trace);
      }

      shotcount--;
    }

    this._applyMultiDamage();
  }

  /**
   * Emits gunshot event.
   * @param {?Vector} origin position (will fallback to player origin)
   */
  dispatchGunshotEvent(origin) {
    this._engine.DispatchTempEntityEvent(tentType.TE_GUNSHOT, origin ? origin : this._entity.origin);
  }

  /**
   * @param {*} damage damage points
   * @param {?BaseEntity} attackerEntity
   * @param {*} hitPoint exact hit point
   * @param {?BaseEntity} ignore
   */
  blastDamage(damage, attackerEntity, hitPoint, ignore = null) { // QuakeC: combat.qc/T_RadiusDamage
    // TODO: T_RadiusDamage

    // this._entity = missile
    // attackerEntity = missile’s owner (e.g. player)

    for (const victimEdict of this._engine.FindInRadius(this._entity.origin, damage + 40)) {
      const victim = victimEdict.entity;

      if (!victim.takedamage) {
        continue;
      }

      if (victim.equals(ignore)) {
        continue;
      }

      const org = victim.origin.copy().add(victim.mins.copy().add(victim.maxs).multiply(0.5));
      let points = 0.5 * this._entity.origin.copy().subtract(org).len();

      points = damage - points;

      if (victim.equals(attackerEntity)) {
        points *= 0.5;
      }

      if (points > 0 && victim._damageHandler && victim._damageHandler.canReceiveDamage(this._entity)) {
        this._entity.damage(victim, points * victim._damageHandler.receiveDamageFactor.blast, attackerEntity, hitPoint);
      }
    }
  }

  /**
   * @param {*} damage damage points
   * @param {*} hitPoint exact hit point
   */
  beamDamage(damage, hitPoint) { // QuakeC: combat.qc/T_BeamDamage
    for (const victimEdict of this._engine.FindInRadius(this._entity.origin, damage + 40)) {
      const victim = victimEdict.entity;

      if (!victim.takedamage) {
        continue;
      }

      let points = Math.max(0, 0.5 * this._entity.origin.copy().subtract(victim.origin).len());

      points = damage - points;

      if (victim.equals(this._entity)) {
        points *= 0.5;
      }

      if (points > 0 && victim._damageHandler && victim._damageHandler.canReceiveDamage(this._entity)) {
        this._entity.damage(victim, points * victim._damageHandler.receiveDamageFactor.beam, null, hitPoint);
      }
    }
  }
}

/**
 * Methods to handle damage on an entity, wrapped entity must support:
 * - takedamage
 * - dmg_attacker, dmg_inflictor, dmg_take, dmg_save
 * - health
 * - thinkDie
 * - armortype, armorvalue (optional)
 * - thinkPain (optional)
 * - pain_finished (optional)
 * - enemy (optional)
 * - invincible_finished, invincible_sound (optional)
 * - bloodcolor (optional)
 *
 * `this._damageHandler = new DamageHandler(this);` must be placed in `_declareFields` last!
 */
export class DamageHandler extends EntityWrapper {
  /** @type {Map<string, number>} multiplier for damping received damage */
  receiveDamageFactor = {
    regular: 1.0,
    blast: 1.0,
    beam: 1.0,
  };

  /** @protected */
  _assertEntity() {
    console.assert(this._entity.health !== undefined);
    console.assert(this._entity.thinkDie !== undefined);
  }

  /**
   * @private
   * @param {BaseEntity} attackerEntity attacker
   */
  _killed(attackerEntity) {
    // don't let sbar look bad if a player
    this._entity.health = Math.max(-99, this._entity.health);

    // doors, triggers, etc.
    if ([moveType.MOVETYPE_PUSH, moveType.MOVETYPE_NONE].includes(this._entity.movetype)) {
      this._entity.thinkDie(attackerEntity);
      return;
    }

    if (typeof (this._entity.enemy) !== 'undefined') {
      this._entity.enemy = attackerEntity;
    }

    // bump the monster counter
    if (this._entity.flags & flags.FL_MONSTER) {
      this._game.killed_monsters++;
      this._engine.BroadcastMonsterKill();
    }

    // CR: ClientObituary(self, attacker); is handled by PlayerEntity.thinkDie now

    this.takedamage = damage.DAMAGE_NO;
    // TODO: this._entity.touch = SUB_Null; -- we need to solve this differently

    // TODO: monster_death_use();
    this._entity.thinkDie(attackerEntity);
  }

  /**
   * Spawns trail of blood.
   * @param {number} damage inflicted damage in HP
   * @param {Vector} origin where does the trail of blood come from?
   * @param {?Vector} velocity optionally a custom blood trail velocity
   */
  spawnBlood(damage, origin, velocity = null) {
    this._engine.StartParticles(origin, velocity !== null ? velocity : this._entity.velocity.copy().multiply(0.01 * damage), typeof (this._entity.bloodcolor) === 'number' ? this._entity.bloodcolor : 73, damage * 2); // FIXME: hardcoded color code (73)
  }

  /**
   * The damage is coming from inflictor, but get mad at attacker
   * This should be the only function that ever reduces health.
   * @param {import('./BaseEntity.mjs').default} inflictorEntity inflictor – what is causing the damage
   * @param {import('./BaseEntity.mjs').default} attackerEntity attacker – who is causing the damage
   * @param {number} inflictedDamage damage caused
   * @param {Vector} hitPoint exact hit point
   */
  damage(inflictorEntity, attackerEntity, inflictedDamage, hitPoint) {
    if (this._entity.takedamage === damage.DAMAGE_NO) {
      // this entity cannot take any damage (anymore)
      return;
    }

    // apply damping factor
    inflictedDamage *= this.receiveDamageFactor.regular;

    // used by buttons and triggers to set activator for target firing
    this._entity.dmg_attacker = attackerEntity;

    if (attackerEntity.super_damage_finished > this._game.time) {
      inflictedDamage *= 4.0; // QUAD DAMAGE
    }

    // // CR: here we could ask the entity to assess the damage point (e.g. headshot = 3x the damage), naive calculation below:
    // if (hitPoint[2] - this._entity.origin[2] > this._entity.view_ofs[2]) {
    //   inflictedDamage *= 100;
    // }

    // save damage based on the target's armor level
    let save = 0, take = 0;
    if (typeof (this._entity.armortype) !== 'undefined' &&
      typeof (this._entity.armorvalue) !== 'undefined') {
      save = Math.ceil(this._entity.armortype * inflictedDamage);

      if (save >= this._entity.armorvalue) {
        save = this._entity.armorvalue;
        this._entity.armortype = 0; // lost all armor
        this._entity.items &= ~(items.IT_ARMOR1 | items.IT_ARMOR2 | items.IT_ARMOR3);
      }

      this._entity.armorvalue -= save;
      take = Math.ceil(inflictedDamage - save);
    } else {
      // no armor path
      take = inflictedDamage;
    }

    // add to the damage total for clients, which will be sent as a single
    // message at the end of the frame
    // FIXME: remove after combining shotgun blasts?

    if (this._entity.flags & flags.FL_CLIENT) {
      this._entity.dmg_take += take;
      this._entity.dmg_save += save;
      this._entity.dmg_inflictor = inflictorEntity;
    }

    // figure momentum add
    if (!inflictorEntity.isWorld() && this._entity.movetype === moveType.MOVETYPE_WALK) {
      const direction = this._entity.origin.copy().subtract(inflictorEntity.centerPoint);
      direction.normalize();
      this._entity.velocity.add(direction.multiply(8.0 * inflictedDamage));
    }

    // check for godmode or invincibility
    if (this._entity.flags & flags.FL_GODMODE) {
      return;
    }

    // check for invincibility and play protection sounds to indicate invincibility
    if (this._entity.invincible_finished >= this._game.time) {
      if (typeof (inflictorEntity.invincible_sound) !== 'undefined') {
        this.entity.startSound(channel.CHAN_ITEM, 'items/protect3.wav');
        inflictorEntity.invincible_sound = this._game.time + 2.0;
        return;
      }
    }

    // no friendly fire
    if (this._game.teamplay === 1 && this._entity.team > 0 && this._entity.team === attackerEntity.team) {
      return;
    }

    // spawn blood
    this.spawnBlood(inflictedDamage, hitPoint);

    // do the actual damage and check for a kill
    this._entity.health -= take;

    if (this._entity.health <= 0) {
      this._killed(attackerEntity);
      return;
    }

    if ((this._entity.flags & flags.FL_MONSTER) && !attackerEntity.isWorld()) {
      // TODO: must bubble down to the AI logic and it’s its job to handle accordingly
    }

    if (this._entity.thinkPain) {
      this._entity.thinkPain(attackerEntity, inflictedDamage);

      // nightmare mode monsters don't go into pain frames often
      if (typeof (this._entity.pain_finished) !== 'undefined' && this._game.skill === 3) {
        this._entity.pain_finished = this._game.time + 5.0;
      }
    }
  }

  /**
   * Returns true if the inflictor can directly damage the target.  Used for explosions and melee attacks.
   * @param {BaseEntity} inflictorEntity inflictor entity
   * @returns {boolean} true, if the inflictor can directly damage the target
   */
  canReceiveDamage(inflictorEntity) { // QuakeC: combat.qc/CanDamage
    // bmodels need special checking because their origin is 0,0,0
    if (this._entity.movetype === moveType.MOVETYPE_PUSH) {
      const trace = inflictorEntity.tracelineToVector(this._entity.centerPoint, true);

      if (trace.fraction === 1.0 || this._entity.equals(trace.entity)) {
        return true;
      }

      return false;
    }

    // CR: it’s basically missile measurements
    for (const offset of [
      Vector.origin,
      new Vector(15.0, 15.0, 0.0),
      new Vector(-15.0, -15.0, 0.0),
      new Vector(-15.0, 15.0, 0.0),
      new Vector(15.0, -15.0, 0.0),
    ]) {
      const point = offset.add(this._entity.origin);
      const trace = inflictorEntity.traceline(inflictorEntity.origin, point, true);

      // CR:  trace.fraction is *almost* 1.0, it’s weird and I do not really get it debugged.
      //      Over in vanilla Quake this seems to work?
      //      Anyway, added entity checks.
      if (trace.fraction === 1.0 || this._entity.equals(trace.entity)) {
        return true;
      }

      // console.log('canReceiveDamage', this._entity.edictId, inflictorEntity.edictId, `[${inflictorEntity.origin}]`, `[${point.toString()}]`, trace.fraction, trace.entity.edictId);
    }

    return false;
  }
}

class BaseProjectile extends BaseEntity {
  static classname = 'weapon_projectile_abstract';

  _declareFields() {
    this._damageInflictor = new DamageInflictor(this);
  }

  _initStates() {
    this._defineState('s_explode1', 0, 's_explode2');
    this._defineState('s_explode2', 1, 's_explode3');
    this._defineState('s_explode3', 2, 's_explode4');
    this._defineState('s_explode4', 3, 's_explode5');
    this._defineState('s_explode5', 4, 's_explode6');
    this._defineState('s_explode6', 5, null, () => this.remove());
  }

  /** @protected */
  _becomeExplosion() {
    this.engine.DispatchTempEntityEvent(tentType.TE_EXPLOSION, this.origin);

    this.movetype = moveType.MOVETYPE_NONE;
    this.solid = solid.SOLID_NOT; // disables touch handling
    this.velocity.clear();

    this.setModel('progs/s_explod.spr');

    this._runState('s_explode1');
  }

  /**
   * @param {BaseEntity} touchedByEntity impacted entity
   */
  touch(touchedByEntity) {
    if (this.solid === solid.SOLID_NOT) {
      return;
    }

    // sky swallows any projectile
    // CR: DOES NOT WORK, it’s always CONTENT_EMPTY, also does not work in vanilla Quake
    if (this.engine.DeterminePointContents(this.origin) === content.CONTENT_SKY) {
      this.remove();
      return;
    }

    this._handleImpact(touchedByEntity);
  }

  /**
   * @param {BaseEntity} touchedByEntity impacted entity
   * @protected
   */
  // eslint-disable-next-line no-unused-vars
  _handleImpact(touchedByEntity) {
    // implement impact here
  }

  /**
   * Prepares the projectile by setting velocity (direction only), adjusts origin a bit, adds removal thinker.
   */
  spawn() {
    // direction
    const { forward } = this.owner.v_angle.angleVectors();
    this.velocity.set(this.aim(forward));
    this.angles = this.velocity.toAngles();
    this.setSize(Vector.origin, Vector.origin);

    // position
    this.setOrigin(this.owner.origin.copy().add(forward.multiply(8.0)).add(new Vector(0.0, 0.0, 16.0)));

    // remove after 5s
    this._scheduleThink(this.game.time + 5.0, () => this.remove());
  }
}

export class Missile extends BaseProjectile {
  static classname = 'weapon_projectile_missile';

  /**
   * @param {BaseEntity} touchedByEntity impacted entity
   * @protected
   */
  _handleImpact(touchedByEntity) {
    if (this.owner && touchedByEntity.equals(this.owner)) {
      return; // don't explode on owner
    }

    const damage = 100 + Math.random() * 20;

    if (touchedByEntity.health > 0) {
      this.damage(touchedByEntity, damage, this.owner, this.origin); // FIXME: better hitpoint
    }

    // don't do radius damage to the other, because all the damage
    // was done in the impact
    this._damageInflictor.blastDamage(120, this.owner, this.origin, touchedByEntity);

    this.velocity.normalize();
    this.origin.subtract(this.velocity.multiply(8.0));

    this._becomeExplosion();
  }

  spawn() {
    if (!this.owner) {
      this.engine.DebugPrint(`Missile.spawn: missing owner on ${this}, removing entity\n`);
      this.remove();
      return;
    }

    super.spawn();

    this.velocity.multiply(1000.0); // fast projectile

    this.movetype = moveType.MOVETYPE_FLYMISSILE;
    this.solid = solid.SOLID_BBOX; // CR: why not SOLID_TRIGGER?

    this.setModel('progs/missile.mdl');
    this.setSize(Vector.origin, Vector.origin);
  }
}

/**
 * this class outsources all weapon related duties from PlayerEntity in its own separate component
 * ammo, however, is still managed over at PlayerEntity due to some clusterfun entaglement with engine code
 */
export class PlayerWeapons {
  /**
   * @param {import('./Player.mjs').PlayerEntity} playerEntity player
   */
  constructor(playerEntity) {
    /** @private */
    this._player = playerEntity;
    /** @private */
    this._game = this._player.game;
    /** @private */
    this._engine = this._player.engine;

    /** @private */
    this._damageInflictor = new DamageInflictor(playerEntity);

    Object.seal(this);
  }

  /**
   * Starts sound on player’s weapon channel.
   * @param {string} sfxName sound
   * @private
   */
  _startSound(sfxName) {
    this._player.startSound(channel.CHAN_WEAPON, sfxName);
  }

  fireAxe() {
    const { forward } = this._player.v_angle.angleVectors();
    const source = this._player.origin.copy().add(new Vector(0.0, 0.0, 16.0));

    const trace = this._player.traceline(source, forward.copy().multiply(64.0).add(source), false);

    if (trace.fraction === 1.0) {
      return;
    }

    const origin = trace.point.subtract(forward.copy().multiply(4.0));

    if (trace.entity.takedamage !== damage.DAMAGE_NO) {
      this._player.damage(trace.entity, 20.0, null, trace.point);
    } else {
      // hit wall
      this._startSound('player/axhit2.wav');
      this._damageInflictor.dispatchGunshotEvent(origin);
    }
  }

  fireShotgun() {
    this._startSound('weapons/guncock.wav');
    this._player.currentammo = this._player.ammo_shells = this._player.ammo_shells - 1;
    this._player.punchangle[0] -= 2.0;

    const { forward } = this._player.v_angle.angleVectors();
    const direction = this._player.aim(forward);

    this._damageInflictor.fireBullets(6, direction, new Vector(0.04, 0.04, 0.0));
  }

  fireSuperShotgun() {
    if (this._player.currentammo === 1) {
      this.fireShotgun();
      return;
    }

    this._startSound('weapons/shotgn2.wav');
    this._player.currentammo = this._player.ammo_shells = this._player.ammo_shells - 2;
    this._player.punchangle[0] -= 4.0;

    const { forward } = this._player.v_angle.angleVectors();
    const direction = this._player.aim(forward);

    this._damageInflictor.fireBullets(14, direction, new Vector(0.14, 0.08, 0.0));
  }

  fireRocket() {
    this._startSound('weapons/sgun1.wav');
    this._player.currentammo = this._player.ammo_rockets = this._player.ammo_rockets - 1;
    this._player.punchangle[0] = -2;

    this._engine.SpawnEntity('weapon_projectile_missile', { owner: this._player });
  }
}


