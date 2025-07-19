import { attn, channel, damage, flags, moveType, solid } from '../Defs.mjs';
import BaseEntity from './BaseEntity.mjs';
import { TeleportEffectEntity } from './Misc.mjs';
import { PlayerEntity, TelefragTriggerEntity } from './Player.mjs';
import { Sub } from './Subs.mjs';
import { DamageHandler } from './Weapons.mjs';

class BaseTriggerEntity extends BaseEntity {
  /** @protected */
  static _sounds = [
    null,
    'misc/secret.wav',
    'misc/talk.wav',
    'misc/trigger1.wav',
  ];

  static SPAWNFLAG_NOTOUCH = 1;
  static SPAWNFLAG_NOMESSAGE = 1;

  _declareFields() {
    this._serializer.startFields();
    this.sounds = 0;
    this.noise = null;
    this.health = 0;
    this.max_health = 0;

    this.wait = 0;
    this.delay = 0;

    this.killtarget = null;

    this.takedamage = damage.DAMAGE_NO;

    this._serializer.endFields();

    this._sub = new Sub(this);
    this._damageHandler = new DamageHandler(this);
  }

  // eslint-disable-next-line no-unused-vars
  thinkDie(attackerEntity) {
    // defined because of _damageHandler
  }

  _precache() {
    if (this.constructor._sounds[this.sounds]) {
      this.engine.PrecacheSound(this.constructor._sounds[this.sounds]);
    }
  }

  spawn() { // QuakeC: subs.qc/InitTrigger
    this.noise = this.constructor._sounds[this.sounds];

    if (!this.angles.isOrigin()) {
      this._sub.setMovedir();
    }

    this.solid = solid.SOLID_TRIGGER;
    this.setModel(this.model); // set size and link into world
    this.movetype = moveType.MOVETYPE_NONE;
    this.model = null;
    this.modelindex = 0;
  }
};

/**
 * QUAKED trigger_relay (.5 .5 .5) (-8 -8 -8) (8 8 8)
 * This fixed size trigger cannot be touched, it can only be fired by other events.
 * It can contain killtargets, targets, delays, and messages.
 */
export class RelayTriggerEntity extends BaseTriggerEntity {
  static classname = 'trigger_relay';

  use(activatorEntity) {
    this._sub.useTargets(activatorEntity);
  }

  _precache() {
    // precache nothing
  }

  spawn() {
    // set nothing
  }
};

/**
 * QUAKED trigger_multiple (.5 .5 .5) ? notouch
 * Variable sized repeatable trigger.  Must be targeted at one or more entities.  If "health" is set, the trigger must be killed to activate each time.
 * If "delay" is set, the trigger waits some time after activating before firing.
 * "wait" : Seconds between triggerings. (.2 default)
 * If notouch is set, the trigger is only fired by other entities, not by touching.
 * NOTOUCH has been obsoleted by trigger_relay!
 * sounds
 * 1)	secret
 * 2)	beep beep
 * 3)	large switch
 * 4)
 * set "message" to text string
 */
export class MultipleTriggerEntity extends BaseTriggerEntity {
  static classname = 'trigger_multiple';

  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    /** @protected */
    this._isActive = false;

    this._serializer.endFields();
  }

  /**
   * Whether the triggering entity is actually allowed to trigger this.
   * @protected
   * @param {BaseEntity} triggeredByEntity triggering entity
   * @returns {boolean} true, if triggering was successful
   */
  // eslint-disable-next-line no-unused-vars
  _canTrigger(triggeredByEntity) {
    return true;
  }

  /**
   * Trigger avenue, can be reached through use, touch, thinkDie.
   * @protected
   * @param {BaseEntity} triggeredByEntity triggering entity
   * @returns {boolean} true, if triggering was successful
   */
  _trigger(triggeredByEntity) {
    if (this._isActive) {
      return false;
    }

    if (!this._canTrigger(triggeredByEntity)) {
      return false;
    }

    this._isActive = true;

    if (this.noise) {
      triggeredByEntity.startSound(channel.CHAN_BODY, this.noise);
    }

    this.takedamage = damage.DAMAGE_NO;

    this._sub.useTargets(triggeredByEntity);

    if (this.wait > 0) {
      this._scheduleThink(this.game.time + this.wait, () => {
        if (this.max_health > 0) {
          this.health = this.max_health;
          this.takedamage = damage.DAMAGE_YES;
          this.solid = solid.SOLID_BBOX;
        }
        this._isActive = false;
      });

      return true;
    }

    // remove the trigger after all invocations
    this.lazyRemove();

    return true;
  }

  touch(touchedByEntity) {
    if (this.spawnflags & BaseTriggerEntity.SPAWNFLAG_NOTOUCH) {
      return;
    }

    if (!(touchedByEntity instanceof PlayerEntity)) {
      return;
    }

    // if the trigger has an angles field, check player's facing direction
    if (!this.movedir.isOrigin()) {
      const { forward } = touchedByEntity.angles.angleVectors();
      if (forward.dot(this.movedir) < 0) {
        return; // not facing the right way
      }
    }

    this._trigger(touchedByEntity);
  }

  use(usedByEntity) {
    this._trigger(usedByEntity);
  }

  thinkDie(killedByEntity) {
    this._trigger(killedByEntity);
  }

  spawn() {
    super.spawn();

    if (!this.wait) {
      this.wait = 0.2;
    }

    if (this.health > 0) {
      this.max_health = this.health;
      this.takedamage = damage.DAMAGE_YES;
      this.solid = solid.SOLID_BBOX;
      this.setOrigin(this.origin); // make sure it links into the world
    }
  }
};

/**
 * QUAKED trigger_once (.5 .5 .5) ? notouch
 * Variable sized trigger. Triggers once, then removes itself.  You must set the key "target" to the name of another object in the level that has a matching
 * "targetname".  If "health" is set, the trigger must be killed to activate.
 * If notouch is set, the trigger is only fired by other entities, not by touching.
 * if "killtarget" is set, any objects that have a matching "target" will be removed when the trigger is fired.
 * if "angle" is set, the trigger will only fire when someone is facing the direction of the angle.  Use "360" for an angle of 0.
 * sounds
 * 1)	secret
 * 2)	beep beep
 * 3)	large switch
 * 4)
 * set "message" to text string
 */
export class OnceTriggerEntity extends MultipleTriggerEntity {
  static classname = 'trigger_once';

  spawn() {
    this.wait = -1;
    super.spawn();
  }
};

/**
 * QUAKED trigger_secret (.5 .5 .5) ?
 * secret counter trigger
 * sounds
 * 1)	secret
 * 2)	beep beep
 * 3)
 * 4)
 * set "message" to text string
 */
export class SecretTriggerEntity extends OnceTriggerEntity {
  static classname = 'trigger_secret';

  _canTrigger(triggeredByEntity) {
    return triggeredByEntity instanceof PlayerEntity;
  }

  _trigger(triggeredByEntity) {
    if (!super._trigger(triggeredByEntity)) {
      return false;
    }

    this.game.found_secrets++;
    this.engine.BroadcastSecretFound();
    return true;
  }

  spawn() {
    this.wait = -1;

    // keep this before super.spawn() due to sounds to noise mapping
    this.sounds = this.sounds || 1;
    this.message = this.message || 'You found a secret area!';

    this.game.total_secrets++;

    super.spawn();
  }
};

/**
 * QUAKED trigger_counter (.5 .5 .5) ? nomessage
 * Acts as an intermediary for an action that takes multiple inputs.
 *
 * If nomessage is not set, t will print "1 more.. " etc when triggered and "sequence complete" when finished.
 *
 * After the counter has been triggered "count" times (default 2), it will fire all of it's targets and remove itself.
 */
export class CountTriggerEntity extends MultipleTriggerEntity {
  static classname = 'trigger_counter';

  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    this.count = 0;

    this._serializer.endFields();
  }

  use(usedByEntity) {
    this.count--;

    if (this.count < 0) {
      return;
    }

    if (this.count > 0) {
      if ((usedByEntity instanceof PlayerEntity) && !(this.spawnflags & BaseTriggerEntity.SPAWNFLAG_NOMESSAGE)) {
        usedByEntity.centerPrint(`Only ${this.count} more to go...`);
      }
      return;
    }

    if ((usedByEntity instanceof PlayerEntity) && !(this.spawnflags & BaseTriggerEntity.SPAWNFLAG_NOMESSAGE)) {
      usedByEntity.centerPrint('Sequence completed!');
    }

    super.use(usedByEntity);
  }

  spawn() {
    this.wait = -1;
    this.count = this.count || 2;
    super.spawn();
  }
};

/**
 * QUAKED trigger_teleport (.5 .5 .5) ? PLAYER_ONLY SILENT
 * Any object touching this will be transported to the corresponding info_teleport_destination entity.
 * You must set the "target" field, and create an object with a "targetname" field that matches.
 *
 * If the trigger_teleport has a targetname, it will only teleport entities when it has been fired.
 */
export class TeleportTriggerEntity extends BaseTriggerEntity {
  static classname = 'trigger_teleport';

  static FLAG_PLAYER_ONLY = 1;
  static FLAG_SILENT = 2;

  _precache() {
    this.engine.PrecacheSound('ambience/hum1.wav');
  }

  use() {
    this.game.force_retouch = 2; // make sure even still objects get hit
    this._scheduleThink(this.game.time + 0.2, () => {});
  }

  touch(touchedByEntity) {
    if (this.targetname && this.nextthink < this.game.time) {
      return; // not fired yet
    }

    if ((this.spawnflags & TeleportTriggerEntity.FLAG_PLAYER_ONLY) && !(touchedByEntity instanceof PlayerEntity)) {
      return; // not a player
    }

    if (touchedByEntity.health <= 0 || touchedByEntity.solid !== solid.SOLID_SLIDEBOX) {
      return; // only teleport living creatures
    }

    this._sub.useTargets(touchedByEntity);

    // put a tfog where the player was
    this.engine.SpawnEntity(TeleportEffectEntity.classname, { origin: touchedByEntity.origin });

    /** @type {InfoTeleportDestination} */
    const target = this.findFirstEntityByFieldAndValue('targetname', this.target);
    console.assert(target instanceof InfoTeleportDestination, 'Target must be an InfoTeleportDestination');

    const { forward } = target.angles.angleVectors();

    // spawn a tfog flash in front of the destination
    this.engine.SpawnEntity(TeleportEffectEntity.classname, { origin: forward.copy().multiply(32.0).add(target.origin) });

    // spawn an ephemeral telefrag trigger
    this.engine.SpawnEntity(TelefragTriggerEntity.classname, {
      origin: target.origin,
      owner: touchedByEntity,
    });

    // move the player and lock him down for a little while
    if (!touchedByEntity.health) {
      touchedByEntity.origin.set(target.origin);
      touchedByEntity.velocity.set(forward.copy().multiply(touchedByEntity.velocity[0]).add(forward.copy().multiply(touchedByEntity.velocity[1])));
      return;
    }

    touchedByEntity.setOrigin(target.origin);
    touchedByEntity.angles.set(target.angles);

    if (touchedByEntity instanceof PlayerEntity) {
      touchedByEntity.fixangle = 1;
      touchedByEntity.teleport_time = this.game.time + 0.7;
      if (touchedByEntity.flags & flags.FL_ONGROUND) {
        touchedByEntity.flags &= ~flags.FL_ONGROUND;
      }
      touchedByEntity.velocity.set(forward.multiply(300));
    }

    touchedByEntity.flags &= ~flags.FL_ONGROUND;
  }

  spawn() {
    console.assert(this.target, 'Teleporter always need a target');

    super.spawn();

    if (!(this.spawnflags & TeleportTriggerEntity.FLAG_SILENT)) {
      const origin = this.mins.copy().add(this.maxs).multiply(0.5); // middle of the brush

      this.engine.SpawnAmbientSound(origin, 'ambience/hum1.wav', 0.5, attn.ATTN_STATIC);
    }
  }
};

/**
 * QUAKED info_teleport_destination (.5 .5 .5) (-8 -8 -8) (8 8 32)
 * This is the destination marker for a teleporter.  It should have a "targetname" field with the same value as a teleporter's "target" field.
 */
export class InfoTeleportDestination extends BaseEntity {
  static classname = 'info_teleport_destination';

  _declareFields() {
    this._serializer.startFields();

    this.targetname = null;

    this._serializer.endFields();
  }

  spawn() {
    console.assert(this.targetname, 'Needs a targetname');

    this.origin[2] += 27.0;
  }
};

/**
 * QUAKED trigger_onlyregistered (.5 .5 .5) ?
 * Only fires if playing the registered version, otherwise prints a message.
 */
export class OnlyRegisteredTriggerEntity extends BaseTriggerEntity {
  static classname = 'trigger_onlyregistered';

  _declareFields() {
    super._declareFields();
    this._serializer.startFields();

    this.wait = 0;

    this._serializer.endFields();
  }

  _precache() {
    this.engine.PrecacheSound('misc/talk.wav');
  }

  touch(otherEntity) {
    if (!(otherEntity instanceof PlayerEntity)) {
      return;
    }

    if (this.attack_finished > this.game.time) {
      return;
    }

    this.attack_finished = this.game.time + 2.0;

    if (this.game.registered) {
      this.message = null;
      this._sub.useTargets(otherEntity);
      this.remove();
    } else if (this.message) {
      otherEntity.centerPrint(this.message);
      otherEntity.startSound(channel.CHAN_BODY, 'misc/talk.wav');
    }
  }
};

/**
 * QUAKED trigger_setskill (.5 .5 .5) ?
 * Sets skill level to the value of "message".
 * Only used on start map.
 */
export class SetSkillTriggerEntity extends BaseTriggerEntity {
  static classname = 'trigger_setskill';

  touch(otherEntity) {
    if (!(otherEntity instanceof PlayerEntity)) {
      return;
    }

    this.engine.SetCvar('skill', this.message);
  }

  spawn() {
    console.assert(this.message, 'skill must be set in message field');

    super.spawn();
  }
};

/**
 * QUAKED trigger_changelevel (0.5 0.5 0.5) ? NO_INTERMISSION
 * When the player touches this, he gets sent to the map listed in the "map" variable.
 * Unless the NO_INTERMISSION flag is set, the view will go to the info_intermission spot and display stats.
 */
export class ChangeLevelTriggerEntity extends BaseTriggerEntity {
  static classname = 'trigger_changelevel';

  _declareFields() {
    this._serializer.startFields();

    /** @type {string} next map name */
    this.map = null;

    this._serializer.endFields();
    super._declareFields();
  }

  touch(otherEntity) {
    if (!(otherEntity instanceof PlayerEntity)) {
      return;
    }

    if (this.engine.noexit > 0 && this.game.mapname !== 'start') {
      this.damage(otherEntity, 50000);
      return;
    }

    if (this.game.coop || this.game.deathmatch) {
      this.engine.BroadcastPrint(`${otherEntity.netname} exited the level\n`);
    }

    this.game.nextmap = this.map;

    this._sub.useTargets(otherEntity);

    if ((this.spawnflags & 1) && !this.game.deathmatch) {
      this.game.loadNextMap();
    }

    this.solid = solid.SOLID_NOT;

    // we can't move people right now, because touch functions are called
    // in the middle of engine movement code, so set a think time to do it
    this._scheduleThink(this.game.time + 0.1, () => {
      this.game.startIntermission();
    });
  }

  spawn() {
    console.assert(this.map, 'map must be set');

    super.spawn();
  }
};

/**
 * QUAKED trigger_hurt (.5 .5 .5) ?
 * Any object touching this will be hurt
 * set dmg to damage amount (default: 5)
 * optional netname
 */
export class TriggerHurtEntity extends BaseTriggerEntity {
  static classname = 'trigger_hurt';

  _declareFields() {
    this._serializer.startFields();

    /** @type {?string} optional name for player’s obituary */
    this.netname = null;

    this._serializer.endFields();
    super._declareFields();
  }

  touch(touchedByEntity) {
    console.assert(touchedByEntity !== null);

    if (!touchedByEntity.takedamage) {
      return;
    }

    if (this.attack_finished > this.game.time) {
      return;
    }

    this.attack_finished = this.game.time + 1.0;

    this.damage(touchedByEntity, this.dmg);
  }

  spawn() {
    if (!this.dmg) {
      this.dmg = 5;
    }

    super.spawn();
  }
};

/**
 * QUAKED trigger_push (.5 .5 .5) ? PUSH_ONCE
 * Pushes the player and other objects
 */
export class TriggerPushEntity extends BaseTriggerEntity {
  static classname = 'trigger_push';
  static FLAG_PUSH_ONCE = 1;

  _declareFields() {
    this._serializer.startFields();

    /** @type {number} speed of the push */
    this.speed = 0;

    this._serializer.endFields();
    super._declareFields();
  }

  _precache() {
    this.engine.PrecacheSound('ambience/windfly.wav');
  }

  touch(touchedByEntity) {
    if (![moveType.MOVETYPE_BOUNCE, moveType.MOVETYPE_WALK, moveType.MOVETYPE_STEP].includes(touchedByEntity.movetype)) {
      return;
    }

    touchedByEntity.velocity.set(this.movedir.copy().multiply(this.speed * 10));

    if ((touchedByEntity instanceof PlayerEntity) && touchedByEntity.fly_time < this.game.time) {
      touchedByEntity.fly_time = this.game.time + 1.5;
      touchedByEntity.startSound(channel.CHAN_AUTO, 'ambience/windfly.wav');
    }

    if (this.spawnflags & TriggerPushEntity.FLAG_PUSH_ONCE) {
      this.remove();
    }
  }

  spawn() {
    this.speed = this.speed || 1000;

    super.spawn();
  }
};

/**
 * QUAKED trigger_monsterjump (.5 .5 .5) ?
 * Walking monsters that touch this will jump in the direction of the trigger's angle
 * "speed" default to 200, the speed thrown forward
 * "height" default to 200, the speed thrown upwards
 */
export class TriggerMonsterjumpEntity extends BaseTriggerEntity {
  static classname = 'trigger_monsterjump';

  _declareFields() {
    this._serializer.startFields();

    this.speed = 0;
    this.height = 0;

    this._serializer.endFields();
    super._declareFields();
  }

  touch(otherEntity) {
    if ((otherEntity.flags & (flags.FL_MONSTER | flags.FL_FLY | flags.FL_SWIM)) !== flags.FL_MONSTER) {
      return;
    }

    // set XY even if not on ground, so the jump will clear lips
    const velocity = this.movedir.copy().multiply(this.speed);
    otherEntity.velocity.setTo(velocity[0], velocity[1], otherEntity.velocity[2]);

    if (!(otherEntity.flags & flags.FL_ONGROUND)) {
      return;
    }

    otherEntity.flags &= ~flags.FL_ONGROUND;
    otherEntity.velocity[2] = this.height;
  }

  spawn() {
    this.speed = this.speed || 200;
    this.height = this.height || 200;

    if (this.angles.isOrigin()) {
      this.angles.setTo(0.0, 360.0, 0.0);
    }

    super.spawn();
  }
}
