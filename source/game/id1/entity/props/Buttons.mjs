import { channel, colors, damage, moveType, solid } from '../../Defs.mjs';
import BaseEntity from '../BaseEntity.mjs';
import { PlayerEntity } from '../Player.mjs';
import { DamageHandler } from '../Weapons.mjs';
import BasePropEntity, { state } from './BasePropEntity.mjs';

/**
 * QUAKED func_button (0 .5 .8) ?
 * When a button is touched, it moves some distance in the direction of it's angle, triggers all of it's targets, waits some time, then returns to it's original position where it can be triggered again.
 *
 * "angle"		determines the opening direction
 * "target"	all entities with a matching targetname will be used
 * "speed"		override the default 40 speed
 * "wait"		override the default 1 second wait (-1 = never return)
 * "lip"		override the default 4 pixel lip remaining at end of move
 * "health"	if set, the button must be killed instead of touched
 * "sounds"
 * 0) steam metal
 * 1) wooden clunk
 * 2) metallic click
 * 3) in-out
 */
export class ButtonEntity extends BasePropEntity {
  static classname = 'func_button';

  /** @protected */
  static _sounds = [
    'buttons/airbut1.wav',
    'buttons/switch21.wav',
    'buttons/switch02.wav',
    'buttons/switch04.wav',
  ];

  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    this.health = 0;
    this.max_health = 0;
    this.bloodcolor = colors.DUST;

    this._serializer.endFields();

    this._damageHandler = new DamageHandler(this);
  }

  _precache() {
    this.engine.PrecacheSound(this.constructor._sounds[this.sounds]);
  }

  _buttonDone() {
    this.state = state.STATE_BOTTOM;
  }

  _buttonReturn() {
    this.state = state.STATE_DOWN;
    this._sub.calcMove(this.pos1, this.speed, () => this._buttonDone());
    this.frame = 0; // use normal textures
    if (this.health) {
      this.takedamage = damage.DAMAGE_YES; // can be shot again
    }
  }

  /**
   *
   * @param {BaseEntity} userEntity user
   */
  _buttonWait(userEntity) {
    console.assert(userEntity !== null, 'user required');

    this.state = state.STATE_TOP;

    this._sub.useTargets(userEntity);
    this.frame = 1; // use alternate textures

    this._scheduleThink(this.ltime + this.wait, () => this._buttonReturn());
  }

  /**
   *
   * @param {BaseEntity} userEntity user
   */
  _buttonFire(userEntity) {
    console.assert(userEntity !== null, 'user required');

    if ([state.STATE_UP, state.STATE_TOP].includes(this.state)) {
      return;
    }

    this.startSound(channel.CHAN_VOICE, this.noise);

    this.state = state.STATE_UP;

    this._sub.calcMove(this.pos2, this.speed, () => this._buttonWait(userEntity));
  }

  /**
   * @param {BaseEntity} usedByEntity user
   */
  use(usedByEntity) {
    this._buttonFire(usedByEntity);
  }

  /**
   * @param {BaseEntity} touchedByEntity user
   */
  touch(touchedByEntity) {
    if (!(touchedByEntity instanceof PlayerEntity)) {
      return;
    }

    // do not handle touch for buttons supposed to be shot at
    if (this.max_health > 0) {
      return;
    }

    this._buttonFire(touchedByEntity);
  }

  thinkDie(killedByEntity) {
    this.health = this.max_health;
    this.takedamage = damage.DAMAGE_NO;

    this._buttonFire(killedByEntity);
  }

  spawn() {
    this.noise = this.constructor._sounds[this.sounds];

    this._sub.setMovedir();

    this.movetype = moveType.MOVETYPE_PUSH;
    this.solid = solid.SOLID_BSP;
    this.setModel(this.model);

    if (this.health > 0) {
      this.max_health = this.health;
      this.takedamage = damage.DAMAGE_YES;
    }

    if (!this.speed) {
      this.speed = 40.0;
    }

    if (!this.wait) {
      this.wait = 1.0;
    }

    if (!this.lip) {
      this.lip = 4.0;
    }

    this.state = state.STATE_BOTTOM;

    this.pos1 = this.origin.copy();
    this.pos2 = this.pos1.copy().add(this.movedir.copy().multiply(Math.abs(this.movedir.dot(this.size)) - this.lip));
  }
};

