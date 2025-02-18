/* global Vector */

import { channel, damage, flags, items, moveType, tentType } from '../Defs.mjs';

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
  /** @protected */
  _assertEntity() {
    console.assert(this._entity.health !== undefined);
    console.assert(this._entity.thinkDie !== undefined);
  }

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
   */
  spawnBlood(damage, origin) {
    this._engine.StartParticles(origin, this._entity.velocity.copy().multiply(0.01 * damage), typeof (this._entity.bloodcolor) === 'number' ? this._entity.bloodcolor : 73, damage * 2); // FIXME: hardcoded color code (73)
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
    if (!inflictorEntity.isWorld() && this._entity.movetype !== moveType.MOVETYPE_WALK) {
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
}

/**
 * this class outsources all weapon related duties from PlayerEntity in its own separate component
 * ammo, however, is still managed over at PlayerEntity due to some clusterfun entaglement with engine code
 */
export class PlayerWeapons {
  /**
   *
   * @param {import('./Player.mjs').PlayerEntity} playerEntity player
   */
  constructor(playerEntity) {
    /** @protected */
    this._player = playerEntity;
    /** @protected */
    this._game = this._player.game;
    /** @protected */
    this._engine = this._player.engine;
    Object.seal(this);
  }

  /**
   * starts sound on player’s weapon channel
   * @param {string} sfxName sound
   * @private
   */
  _startSound(sfxName) {
    this._player.startSound(channel.CHAN_WEAPON, sfxName);
  }

  /**
   * emits gunshot event
   * @param {?Vector} origin position (will fallback to player origin)
   * @private
   */
  _dispatchGunshotEvent(origin) {
    this._engine.DispatchTempEntityEvent(tentType.TE_GUNSHOT, origin ? origin : this._player.origin);
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
      this._dispatchGunshotEvent(origin);
    }
  }

  fireShotgun() {
    this._startSound('weapons/guncock.wav');
    this._player.currentammo = this._player.ammo_shells = this._player.ammo_shells - 1;
    this._player.punchangle[0] -= 2.0;

    const { forward } = this._player.v_angle.angleVectors();
    const direction = this._player.aim(forward);

    // TODO: FireBullets (6, direction, '0.04 0.04 0');
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

    // TODO: FireBullets (14, dir, '0.14 0.08 0');
  }
}


