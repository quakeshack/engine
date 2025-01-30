/* global Vector */

import { attn, channel, damage, moveType, solid } from "../../Defs.mjs";
import BaseEntity from "../BaseEntity.mjs";
import BasePropEntity, { state } from "./BasePropEntity.mjs";

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

  _precache() {
    switch (this.sounds) {
      case 0:
        this.engine.PrecacheSound("buttons/airbut1.wav");
        break;

      case 1:
        this.engine.PrecacheSound("buttons/switch21.wav");
        break;

      case 2:
        this.engine.PrecacheSound("buttons/switch02.wav");
        break;

      case 3:
        this.engine.PrecacheSound("buttons/switch04.wav");
        break;
    }
  }

  think() {
    switch (this.state) {
      case state.STATE_TOP:
        this._buttonReturn();
        break;

      default:
        this._sub.think();
    }
  }

  _buttonDone() {
    this.state = state.STATE_BOTTOM;
  }

  _buttonReturn() {
    this.state = state.STATE_DOWN;
    this._sub.calcMove(this.pos1, this.speed, () => this._buttonDone());
    this.frame = 0; // use normal textures
    if (this.health) {
      self.takedamage = damage.DAMAGE_YES; // can be shot again
    }
  }

  /**
   *
   * @param {BaseEntity} userEntity user
   */
  _buttonWait(userEntity) {
    this.state = state.STATE_TOP;
    this.nextthink = this.game.time + this.wait;
    this._sub.useTargets(userEntity);
    this.frame = 1; // use alternate textures
  }

  /**
   *
   * @param {BaseEntity} userEntity user
   */
  _buttonFire(userEntity) {
    if ([state.STATE_UP, state.STATE_TOP].includes(this.state)) {
      return;
    }

    this.startSound(channel.CHAN_VOICE, this.noise, 1.0, attn.ATTN_NORM);

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
    // do not handle touch for buttons supposed to be shot at
    if (this.max_health > 0) {
      return;
    }

    this._buttonFire(touchedByEntity);
  }

  spawn() {
    switch (this.sounds) {
      case 0:
        this.noise = "buttons/airbut1.wav";
        break;

      case 1:
        this.noise = "buttons/switch21.wav";
        break;

      case 2:
        this.noise = "buttons/switch02.wav";
        break;

      case 3:
        this.noise = "buttons/switch04.wav";
        break;
    }

    this._sub.setMovedir();

    this.movetype = moveType.MOVETYPE_PUSH;
    this.solid = solid.SOLID_BSP;
    this.setModel(this.model);

    if (this.health > 0) {
      this.max_health = this.health;
      // TODO: self.th_die = button_killed;
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

