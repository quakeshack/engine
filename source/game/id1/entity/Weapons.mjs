import Vector, { DirectionalVectors } from '../../../shared/Vector.mjs';

import { attn, channel, colors, content, damage, flags, items, moveType, solid, tentType } from '../Defs.mjs';
import { crandom, EntityWrapper } from '../helper/MiscHelpers.mjs';
import BaseEntity from './BaseEntity.mjs';
import { PlayerEntity } from './Player.mjs';

/**
 * called by worldspawn
 * @param {*} engine engine API
 */
export function Precache(engine) {
  // FIXME: move “use in c code” precache commands back to the engine
  engine.PrecacheSound('weapons/r_exp3.wav');	// new rocket explosion
  engine.PrecacheSound('weapons/rocket1i.wav');	// spike gun
  engine.PrecacheSound('weapons/sgun1.wav');
  engine.PrecacheSound('weapons/guncock.wav');	// player shotgun
  engine.PrecacheSound('weapons/ric1.wav');	// ricochet (used in c code)
  engine.PrecacheSound('weapons/ric2.wav');	// ricochet (used in c code)
  engine.PrecacheSound('weapons/ric3.wav');	// ricochet (used in c code)
  engine.PrecacheSound('weapons/spike2.wav');	// super spikes
  engine.PrecacheSound('weapons/tink1.wav');	// spikes tink (used in c code)
  engine.PrecacheSound('weapons/grenade.wav');	// grenade launcher
  engine.PrecacheSound('weapons/bounce.wav');		// grenade bounce
  engine.PrecacheSound('weapons/shotgn2.wav');	// super shotgun
};

/**
 * handy map to manage weapon slots
 */
export const weaponConfig = new Map([
  [items.IT_AXE, { currentammo: null, weaponmodel: 'progs/v_axe.mdl', priority: 0, weaponframe: 0 }],
  [items.IT_SHOTGUN, { currentammo: 'ammo_shells', weaponmodel: 'progs/v_shot.mdl', items: 'IT_SHELLS', priority: 1, weaponframe: 0 }],
  [items.IT_SUPER_SHOTGUN, { currentammo: 'ammo_shells', weaponmodel: 'progs/v_shot2.mdl', items: 'IT_SHELLS', priority: 2, weaponframe: 0 }],
  [items.IT_NAILGUN, { currentammo: 'ammo_nails', weaponmodel: 'progs/v_nail.mdl', items: 'IT_NAILS', priority: 3, weaponframe: 0 }],
  [items.IT_SUPER_NAILGUN, { currentammo: 'ammo_nails', weaponmodel: 'progs/v_nail2.mdl', items: 'IT_NAILS', priority: 4, weaponframe: 0 }],
  [items.IT_GRENADE_LAUNCHER, { currentammo: 'ammo_rockets', weaponmodel: 'progs/v_rock.mdl', items: 'IT_ROCKETS', priority: 5, weaponframe: 0 }],
  [items.IT_ROCKET_LAUNCHER, { currentammo: 'ammo_rockets', weaponmodel: 'progs/v_rock2.mdl', items: 'IT_ROCKETS', priority: 6, weaponframe: 0 }],
  [items.IT_LIGHTNING, { currentammo: 'ammo_cells', weaponmodel: 'progs/v_light.mdl', items: 'IT_CELLS', priority: 7, weaponframe: 0 }],
]);

/** struct holding items and ammo */
export class Backpack {
  constructor() {
    this.ammo_shells = 0;
    this.ammo_nails = 0;
    this.ammo_rockets = 0;
    this.ammo_cells = 0;
    this.items = 0;
    this.weapon = 0;
  }
};

export class Explosions extends EntityWrapper {
  initStates() {
    this._entity._defineState('s_explode1', 0, 's_explode2');
    this._entity._defineState('s_explode2', 1, 's_explode3');
    this._entity._defineState('s_explode3', 2, 's_explode4');
    this._entity._defineState('s_explode4', 3, 's_explode5');
    this._entity._defineState('s_explode5', 4, 's_explode6');
    this._entity._defineState('s_explode6', 5, null, function () { this.remove(); });
  }

  becomeExplosion() {
    this._engine.DispatchTempEntityEvent(tentType.TE_EXPLOSION, this._entity.origin);

    this._entity.movetype = moveType.MOVETYPE_NONE;
    this._entity.solid = solid.SOLID_NOT; // disables touch handling
    this._entity.takedamage = damage.DAMAGE_NO; // disables receiving damage
    this._entity.velocity.clear();

    this._entity.setModel('progs/s_explod.spr');

    this._entity._runState('s_explode1');
  }
};

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
   * @param {DirectionalVectors} angleVectors v_angle.angleVectors (forward, right, up)
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
    this._clearMultiDamage();
  }

  /**
   * Emits gunshot event.
   * @param {?Vector} origin position (will fallback to player origin)
   */
  dispatchGunshotEvent(origin = null) {
    this._engine.DispatchTempEntityEvent(tentType.TE_GUNSHOT, origin ? origin : this._entity.origin);
  }

  /**
   * Emits a beam event.
   * @param {number} beamType temporary entity type
   * @param {Vector} endOrigin end position
   * @param {?Vector} startOrigin starting position (will fallback to player origin)
   */
  dispatchBeamEvent(beamType, endOrigin, startOrigin = null) {
    this._engine.DispatchBeamEvent(beamType, this._entity.edictId, startOrigin ? startOrigin : this._entity.origin, endOrigin);
  }

  /**
   * @param {number} damage damage points
   * @param {?BaseEntity} attackerEntity attacking entity
   * @param {?Vector} hitPoint exact hit point (defaults to attacker’s origin)
   * @param {?BaseEntity} ignore (optionally) entity to not hurt
   */
  blastDamage(damage, attackerEntity, hitPoint = attackerEntity.origin, ignore = null) { // QuakeC: combat.qc/T_RadiusDamage
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
      let points = 0.5 * this._entity.origin.distanceTo(org);

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

      let points = Math.max(0, 0.5 * this._entity.origin.distanceTo(victim.origin));

      points = damage - points;

      if (victim.equals(this._entity)) {
        points *= 0.5;
      }

      if (points > 0 && victim._damageHandler && victim._damageHandler.canReceiveDamage(this._entity)) {
        this._entity.damage(victim, points * victim._damageHandler.receiveDamageFactor.beam, null, hitPoint);
      }
    }
  }

  lightningDamage(startOrigin, endOrigin, damage) {
    const f = endOrigin.copy().subtract(startOrigin);
    f.normalize();
    f[0] = -f[1];
    f[1] = f[0];
    f[2] = 0.0;
    f.multiply(16.0);

    const trace1 = this._entity.traceline(startOrigin, endOrigin, false);
    if (trace1.entity !== null && trace1.entity.takedamage) {
      this._engine.StartParticles(trace1.point, new Vector(0.0, 0.0, 100.0), colors.SPARK, damage * 4);
      this._entity.damage(trace1.entity, damage);

      // CR: ported over a fixed version, but commented out for now
      // if (this._entity.classname === 'player' && trace1.entity.classname === 'player') {
      //   trace1.entity.velocity[2] += 400.0;
      // }
    }

    const trace2 = this._entity.traceline(startOrigin.copy().add(f), endOrigin.copy().add(f), false);
    if (trace2.entity !== null && !trace2.entity.equals(trace1.entity) && trace2.entity.takedamage) {
      this._engine.StartParticles(trace2.point, new Vector(0.0, 0.0, 100.0), colors.SPARK, damage * 4);
      this._entity.damage(trace2.entity, damage);
    }

    const trace3 = this._entity.traceline(startOrigin.copy().subtract(f), endOrigin.copy().subtract(f), false);
    if (trace3.entity !== null && !trace3.entity.equals(trace1.entity) && !trace3.entity.equals(trace2.entity) && trace3.entity.takedamage) {
      this._engine.StartParticles(trace3.point, new Vector(0.0, 0.0, 100.0), colors.SPARK, damage * 4);
      this._entity.damage(trace3.entity, damage);
    }
  }
};

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
  /** @type {{[key: string]: number}} multiplier for damping received damage */
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
      this._entity.takedamage = damage.DAMAGE_NO; // CR: not Quake vanilla behavior here
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

    this._entity.takedamage = damage.DAMAGE_NO;
    // FIXME: this._entity.touch = SUB_Null; -- we need to solve this differently?

    this._entity.thinkDie(attackerEntity);
  }

  /**
   * Spawns trail of blood.
   * @param {number} damage inflicted damage in HP
   * @param {Vector} origin where does the trail of blood come from?
   * @param {?Vector} velocity optionally a custom blood trail velocity
   */
  spawnBlood(damage, origin, velocity = null) {
    this._engine.StartParticles(origin, velocity !== null ? velocity : this._entity.velocity.copy().multiply(0.01 * damage), typeof (this._entity.bloodcolor) === 'number' ? this._entity.bloodcolor : colors.BLOOD, damage * 2);
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

    // check for godmode
    if (this._entity.flags & flags.FL_GODMODE) {
      return;
    }

    // check for invincibility and play protection sounds to indicate invincibility
    if (this._entity.invincible_finished >= this._game.time) {
      if ((this._entity.invincible_sound_time[inflictorEntity.edictId] || 0) < this._game.time) {
        this._entity.startSound(channel.CHAN_ITEM, 'items/protect3.wav');
        this._entity.invincible_sound_time[inflictorEntity.edictId] = this._game.time + 2.0;
      }
      return;
    }

    // no friendly fire
    if (this._game.teamplay === 1 && this._entity.team > 0 && this._entity.team === attackerEntity.team) {
      return;
    }

    // spawn blood
    this.spawnBlood(inflictedDamage, hitPoint);

    // do the actual damage and check for a kill
    this._entity.health -= take;

    // negative health is a kill
    if (this._entity.health <= 0) {
      this._killed(attackerEntity);
      return;
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
      new Vector(0.0, 0.0, 0.0),
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
      //      UPDATE: I figured it out, it was the botched Edict/Entity check over in the engine, it works now. Though, I’m keeping the check.
      if (trace.fraction === 1.0 || this._entity.equals(trace.entity)) {
        return true;
      }
    }

    return false;
  }
};

export class BaseProjectile extends BaseEntity {
  static classname = 'weapon_projectile_abstract';

  _declareFields() {
    this._damageInflictor = new DamageInflictor(this);
    /** @private */
    this._explosions = new Explosions(this);
  }

  _initStates() {
    this._explosions.initStates();
  }

  /** @protected */
  _becomeExplosion() {
    this._explosions.becomeExplosion();
  }

  /**
   * @param {BaseEntity} touchedByEntity impacted entity
   */
  touch(touchedByEntity) {
    if (this.solid === solid.SOLID_NOT) {
      return;
    }

    // sky swallows any projectile
    // CR:  DOES NOT WORK, it’s always CONTENT_EMPTY, also does not work in vanilla Quake
    //      UPDATE: IT DOES WORK, it’s the stupid Quake maps having some content info wrong!
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
   * It simplifies the velocity and origin calculation, if the owner is not a PlayerEntity. It will use the owner’s movedir property to set the velocity.
   */
  spawn() {
    this.solid = solid.SOLID_BBOX;

    // direction
    if (this.owner instanceof PlayerEntity) {
      const { forward } = this.owner.v_angle.angleVectors();
      this.velocity.set(this.aim(forward));

      this.setOrigin(this.owner.origin.copy().add(forward.multiply(8.0)).add(new Vector(0.0, 0.0, 16.0)));
    } else {
      this.velocity.set(this.owner.movedir);

      this.setOrigin(this.owner.origin);
    }

    this.angles.set(this.velocity.toAngles());
    this.setSize(Vector.origin, Vector.origin);

    // remove after 6s
    this._scheduleThink(this.game.time + 6.0, () => this.remove());
  }
};

export class Grenade extends BaseProjectile {
  static classname = 'weapon_projectile_grenade';

  /** @private */
  _explode() {
    this.resetThinking();

    // nerfing grenade damage for NPCs
    const damage = this.owner instanceof PlayerEntity ? 120 : 40;

    this._damageInflictor.blastDamage(damage, this.owner, this.origin);

    this.velocity.normalize();
    this.origin.subtract(this.velocity.multiply(8.0));

    this._becomeExplosion();
  }

  touch(touchedByEntity) {
    if (this.solid === solid.SOLID_NOT) {
      return;
    }

    if (this.owner && touchedByEntity.equals(this.owner)) {
      return; // don't explode on owner
    }

    if (touchedByEntity.takedamage === damage.DAMAGE_AIM) {
      this._explode();
      return;
    }

    // CR: in the original the grenade bounces off and makes a splash sound
    if (this.engine.DeterminePointContents(this.origin) === content.CONTENT_SKY) {
      this.remove();
      return;
    }

    this.startSound(channel.CHAN_WEAPON, 'weapons/bounce.wav');

    if (this.velocity.isOrigin()) {
      this.avelocity.clear();
    } else {
      this.avelocity.set(this.velocity);
    }
  }

  spawn() {
    this.solid = solid.SOLID_BBOX;
    this.movetype = moveType.MOVETYPE_BOUNCE;

    if (this.velocity.len() > 0) {
      this.angles.set(this.velocity.toAngles());
    }

    this.setModel('progs/grenade.mdl');
    this.setSize(Vector.origin, Vector.origin);
    this.setOrigin(this.owner.origin);

    this._scheduleThink(this.game.time + 2.5, () => this._explode());
  }
};

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
    console.assert(this.owner, 'Needs an owner');

    super.spawn();

    this.movetype = moveType.MOVETYPE_FLYMISSILE;

    this.velocity.multiply(1000.0); // fast projectile

    this.setModel('progs/missile.mdl');
    this.setSize(Vector.origin, Vector.origin);
  }
};

export class BaseSpike extends BaseProjectile {
  static _damage = 0;
  static _tentType = null;
  static _model = 'progs/s_spike.mdl';

  _declareFields() {
    this._serializer.startFields();

    /** @type {number} speed, default: 1000.0 units */
    this.speed = 0;

    this._serializer.endFields();
    super._declareFields();
  }

  /**
   * @param {BaseEntity} touchedByEntity impacted entity
   * @protected
   */
  _handleImpact(touchedByEntity) {
    if (this.owner && touchedByEntity.equals(this.owner)) {
      return; // don't explode on owner
    }

    if (touchedByEntity.solid === solid.SOLID_TRIGGER) {
      return; // do not trigger fields
    }

    if (touchedByEntity.health > 0) {
      this.damage(touchedByEntity, this.constructor._damage, this.owner, this.origin);
    }

    this.engine.DispatchTempEntityEvent(this.constructor._tentType, this.origin);

    // delay the remove, the projectile might still be needed for some touch evaluations
    this.lazyRemove();
  }

  spawn() {
    console.assert(this.owner, 'Needs an owner');

    super.spawn();

    this.movetype = moveType.MOVETYPE_FLYMISSILE;

    this.velocity.multiply(this.speed || 1000.0); // fast projectile

    this.setModel(this.constructor._model);
    this.setSize(Vector.origin, Vector.origin);
  }
};

export class Spike extends BaseSpike {
  static classname = 'weapon_projectile_spike';
  static _damage = 9;
  static _tentType = tentType.TE_SPIKE;

  spawn() {
    super.spawn();

    if (!(this.owner instanceof PlayerEntity)) {
      return;
    }

    const { right } = this.owner.v_angle.angleVectors();
    this.setOrigin(this.origin.add(right.multiply((this.owner.weaponframe % 2) === 1 ? 4.0 : -4.0)));
  }
};

export class Superspike extends BaseSpike {
  static classname = 'weapon_projectile_superspike';
  static _damage = 18;
  static _tentType = tentType.TE_SUPERSPIKE;
};

export class Laser extends BaseSpike {
  static classname = 'weapon_projectile_laser';
  static _damage = 15;
  static _tentType = tentType.TE_GUNSHOT;
  static _model = 'progs/laser.mdl';

  _handleImpact(touchedByEntity) {
    super._handleImpact(touchedByEntity);

    this.startSound(channel.CHAN_WEAPON, 'enforcer/enfstop.wav', 1.0, attn.ATTN_STATIC);
  }

  spawn() {
    super.spawn();

    this.owner.startSound(channel.CHAN_WEAPON, 'enforcer/enfire.wav');
  }
};

/**
 * This class outsources all weapon related duties from PlayerEntity in its own separate component.
 * Ammo, however, is still managed over at PlayerEntity due to some clusterfun entaglement with engine code.
 */
export class PlayerWeapons extends EntityWrapper {
  /**
   * @param {import('./Player.mjs').PlayerEntity} playerEntity player
   */
  constructor(playerEntity) {
    super(playerEntity);

    /** @private */
    this._damageInflictor = new DamageInflictor(playerEntity);

    /** @private */
    this._state = {
      lightningSoundTime: 0,
    };

    Object.seal(this._state);
    Object.seal(this);
  }

  /**
   * @private
   * @returns {import('./Player.mjs').PlayerEntity} player
   */
  get _player() {
    return this._entity;
  }

  /**
   * Starts sound on player’s weapon channel.
   * @param {string} sfxName sound
   * @param {?number} chan alternative channel, useful for play multiple sounds in parallel
   * @private
   */
  _startSound(sfxName, chan = channel.CHAN_WEAPON) {
    this._player.startSound(chan, sfxName);
  }

  /**
   * @returns {boolean} true, if the current weapon is okay to use
   */
  checkAmmo() { // QuakeC: weapons.qc/W_CheckNoAmmo
    if (this._player.weapon === items.IT_AXE) {
      return true;
    }

    const key = weaponConfig.get(this._player.weapon).currentammo;

    if (key && this._player[key] > 0) {
      return true;
    }

    this._player.selectBestWeapon();

    return false;
  }

  fireAxe() {
    // CR: no check ammo, it’s always true

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
    if (!this.checkAmmo()) {
      return;
    }

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

    if (!this.checkAmmo()) {
      return;
    }

    this._startSound('weapons/shotgn2.wav');
    this._player.currentammo = this._player.ammo_shells = this._player.ammo_shells - 2;
    this._player.punchangle[0] -= 4.0;

    const { forward } = this._player.v_angle.angleVectors();
    const direction = this._player.aim(forward);

    this._damageInflictor.fireBullets(14, direction, new Vector(0.14, 0.08, 0.0));
  }

  fireNailgun() {
    if (!this.checkAmmo() || this._player.weapon !== items.IT_NAILGUN) {
      return;
    }

    this._startSound('weapons/rocket1i.wav');
    this._player.currentammo = this._player.ammo_nails = this._player.ammo_nails - 1;
    this._player.punchangle[0] -= 0.5;

    this._player._scheduleThink(this._game.time + 0.1, function () { if (this.button0) { this._weapons.fireNailgun(); } });

    this._engine.SpawnEntity(Spike.classname, { owner: this._player });
  }

  fireSuperNailgun() {
    if (!this.checkAmmo() || this._player.weapon !== items.IT_SUPER_NAILGUN) {
      return;
    }

    this._startSound('weapons/spike2.wav');
    this._player.currentammo = this._player.ammo_nails = this._player.ammo_nails - 2;
    this._player.punchangle[0] -= 0.5;

    if (this._player.currentammo >= 0) {
      this._player._scheduleThink(this._game.time + 0.1, function () { if (this.button0) { this._weapons.fireSuperNailgun(); } });

      this._engine.SpawnEntity(Superspike.classname, { owner: this._player });
    } else {
      this._engine.SpawnEntity(Spike.classname, { owner: this._player });
    }
  }

  fireRocket() {
    if (!this.checkAmmo()) {
      return;
    }

    this._startSound('weapons/sgun1.wav');
    this._player.currentammo = this._player.ammo_rockets = this._player.ammo_rockets - 1;
    this._player.punchangle[0] = -2;

    this._engine.SpawnEntity(Missile.classname, { owner: this._player });
  }

  fireGrenade() {
    if (!this.checkAmmo()) {
      return;
    }

    this._startSound('weapons/grenade.wav');
    this._player.currentammo = this._player.ammo_rockets = this._player.ammo_rockets - 1;
    this._player.punchangle[0] = -2;

    const velocity = new Vector();
    const { forward, up, right } = this._player.v_angle.angleVectors();

    if (this._player.v_angle[0] !== 0.0) {
      velocity.add(forward.multiply(600.0));
      velocity.add(up.copy().multiply(200.0));
      velocity.add(right.multiply(10.0 * crandom()));
      velocity.add(up.multiply(10.0 * crandom()));
    } else {
      velocity.set(this._player.aim(forward).multiply(600.0));
      velocity[2] = 200.0;
    }

    this._engine.SpawnEntity(Grenade.classname, { owner: this._player, velocity });
  }

  fireLightning(attackContinuation = false) {
    if (!attackContinuation) {
      this._startSound('weapons/lstart.wav', channel.CHAN_AUTO);
    }

    if (!this.checkAmmo()) {
      return;
    }

    // explode if under water
    if (this._player.waterlevel > 1) {
      const ammo = this._player.ammo_cells;
      this._damageInflictor.blastDamage(ammo * 35, this._player, this._player.centerPoint);
      this._player.currentammo = this._player.ammo_cells = 0;
      return;
    }

    if (attackContinuation && this._state.lightningSoundTime < this._game.time) {
      this._startSound('weapons/lhit.wav');
      this._state.lightningSoundTime = this._game.time + 0.6;
    }

    this._player.punchangle[0] -= 1.0;

    this._player.currentammo = this._player.ammo_cells = this._player.ammo_cells - 1;

    const origin = (new Vector(0.0, 0.0, 16.0)).add(this._player.origin);
    const { forward } = this._player.v_angle.angleVectors();

    const trace = this._player.traceline(origin, forward.multiply(600.0).add(origin), true);

    this._damageInflictor.dispatchBeamEvent(tentType.TE_LIGHTNING2, trace.point, origin);
    this._damageInflictor.lightningDamage(origin, trace.point.add(forward.multiply(4.0 / 600.0)), 30);

    this._player._scheduleThink(this._game.time + 0.1, function () { if (this.button0) { this._weapons.fireLightning(true); } });
  }
};
