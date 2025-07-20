import Vector from '../../../../shared/Vector.mjs';

import { channel, moveType, solid } from '../../Defs.mjs';
import BaseEntity from '../BaseEntity.mjs';
import { PlayerEntity } from '../Player.mjs';
import BasePropEntity, { state } from './BasePropEntity.mjs';

/**
 * QUAKED func_plat (0 .5 .8) ? PLAT_LOW_TRIGGER
 * speed	default 150
 *
 * Plats are always drawn in the extended position, so they will light correctly.
 *
 * If the plat is the target of another trigger or button, it will start out disabled in the extended position until it is trigger, when it will lower and become a normal plat.
 *
 * If the "height" key is set, that will determine the amount the plat moves, instead of being implicitly determined by the model's height.
 * Set "sounds" to one of the following:
 * 1) base fast
 * 2) chain slow
 */
export class PlatformEntity extends BasePropEntity {
  static classname = 'func_plat';

  static PLAT_LOW_TRIGGER = 1;

  static _sounds = [
    [null, null],
    ['plats/plat1.wav', 'plats/plat2.wav'],
    ['plats/medplat1.wav', 'plats/medplat2.wav'],
  ];

  _precache() {
    const sounds = this.constructor._sounds[this.sounds || 2];

    for (const sound of sounds) {
      if (sound) {
        this.engine.PrecacheSound(sound);
      }
    }
  }

  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    this.mangle = new Vector();
    this.t_length = 0;
    this.t_width = 0;

    /** @type {PlatformTriggerEntity} @private */
    this._trigger = null;

    this._serializer.endFields();
  }

  _spawnInsideTrigger() {
    this._trigger = this.engine.SpawnEntity(PlatformTriggerEntity.classname, { owner: this });
  }

  _hitBottom() {
    this.state = state.STATE_BOTTOM;
    this.startSound(channel.CHAN_VOICE, this.noise1);
  }

  _hitTop() {
    this.state = state.STATE_TOP;
    this.startSound(channel.CHAN_VOICE, this.noise1);
    this._scheduleThink(this.ltime + 3.0, () => this._goDown());
  }

  _goDown() {
    this.state = state.STATE_DOWN;
    this.startSound(channel.CHAN_VOICE, this.noise);
    this._sub.calcMove(this.pos2, this.speed, () => this._hitBottom());
  }

  _goUp() {
    this.state = state.STATE_UP;
    this.startSound(channel.CHAN_VOICE, this.noise);
    this._sub.calcMove(this.pos1, this.speed, () => this._hitTop());
  }

  _keepUp() {
    // CR: this is a hack, we are prolonging the time the platform is up by tinkering around with nextthink
    this.nextthink = this.ltime + 1.0;
  }

  blocked(blockedByEntity) {
    this.damage(blockedByEntity, 1);

    if (this.state === state.STATE_UP) {
      this._goDown();
    } else if (this.state === state.STATE_DOWN) {
      this._goUp();
    } else {
      console.assert(false, 'PlatformEntity.blocked: invalid state');
    }
  }

  // eslint-disable-next-line no-unused-vars
  use(usedByEntity) {
    if (!this.targetname) { // plat_trigger_use path
      this._goDown();
      return;
    }

    // already thinking
    if (this.nextthink > this.game.time) {
      return;
    }

    this._goDown();
  }

  spawn() {
    if (!this.t_length) {
      this.t_length = 80;
    }

    if (!this.t_width) {
      this.t_width = 10;
    }

    if (!this.speed) {
      this.speed = 150;
    }

    if (!this.sounds) {
      this.sounds = 2;
    }

    [this.noise, this.noise1] = this.constructor._sounds[this.sounds];

    this.mangle.set(this.angles);
    this.angles.clear();

    this.solid = solid.SOLID_BSP;
    this.movetype = moveType.MOVETYPE_PUSH;

    // CR: is this even necessary?
    this.setOrigin(this.origin);
    this.setModel(this.model);
    this.setSize(this.mins, this.maxs);

    this.pos1.set(this.origin);
    this.pos2.set(this.origin);

    this.pos2[2] = this.origin[2] - (this.height ? this.height : this.size[2] - 8.0);

    this._spawnInsideTrigger();

    if (this.targetname) {
      this.state = state.STATE_UP;
    } else {
      this.setOrigin(this.pos2);
      this.state = state.STATE_BOTTOM;
    }
  }
};

export class PlatformTriggerEntity extends BaseEntity {
  static classname = 'func_plat_trigger';

  spawn() {
    console.assert(this.owner instanceof PlatformEntity, 'owner must be a PlatformEntity');

    this.movetype = moveType.MOVETYPE_NONE;
    this.solid = solid.SOLID_TRIGGER;

    const tmin = new Vector(), tmax = new Vector();

    tmin.set(this.owner.mins).add(new Vector(25.0, 25.0, 0.0));
    tmax.set(this.owner.maxs).subtract(new Vector(25.0, 25.0, -8.0));
    tmin[2] = tmax[2] - (this.owner.pos1[2] - this.owner.pos2[2] + 8.0);

    if (this.owner.spawnflags & PlatformEntity.PLAT_LOW_TRIGGER) {
      tmax[2] = tmin[2] + 8.0;
    }

    if (this.owner.size[0] <= 50.0) {
      tmin[0] = (this.owner.mins[0] + this.owner.maxs[0]) / 2;
      tmax[0] = tmin[0] + 1.0;
    }

    if (this.owner.size[1] <= 50.0) {
      tmin[1] = (this.owner.mins[1] + this.owner.maxs[1]) / 2;
      tmax[1] = tmin[1] + 1.0;
    }

    this.setSize(tmin, tmax);
  }

  touch(touchedByEntity) {
    if (!(touchedByEntity instanceof PlayerEntity)) {
      return;
    }

    if (touchedByEntity.health <= 0) {
      return;
    }

    /** @type {PlatformEntity} */
    const platform = this.owner;

    switch (platform.state) {
      case state.STATE_BOTTOM:
        platform._goUp();
        break;

      case state.STATE_TOP:
        platform._keepUp();
        break;
    }
  }
};

/**
 * QUAKED func_train (0 .5 .8) ?
 * Trains are moving platforms that players can ride.
 * The targets origin specifies the min point of the train at each corner.
 * The train spawns at the first target it is pointing at.
 * If the train is the target of a button or trigger, it will not begin moving until activated.
 * speed	default 100
 * dmg		default	2
 * sounds
 * 1) ratchet metal
 */
export class TrainEntity extends BasePropEntity { // CR: this beauty is written by VS Code Copilot
  static classname = 'func_train';

  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    this.dmg = 0;
    this.wait = 0;
    this.target = null;
    this.sounds = 0; // default value (0: misc/null.wav, 1: train sounds)

    /** @private */
    this._isActivated = false;

    this._serializer.endFields();
  }

  _precache() {
    if (this.sounds === 0) {
      this.engine.PrecacheSound('misc/null.wav');
    } else if (this.sounds === 1) {
      this.engine.PrecacheSound('plats/train2.wav');
      this.engine.PrecacheSound('plats/train1.wav');
    }
  }

  spawn() {
    if (!this.speed) {
      this.speed = 100;
    }

    console.assert(this.target, 'func_train requires a target');

    if (!this.dmg) {
      this.dmg = 2;
    }

    if (this.sounds === 0) {
      this.noise = 'misc/null.wav';
      this.noise1 = 'misc/null.wav';
    } else if (this.sounds === 1) {
      this.noise = 'plats/train2.wav';
      this.noise1 = 'plats/train1.wav';
    }

    this._precache();

    this.solid = solid.SOLID_BSP;
    this.movetype = moveType.MOVETYPE_PUSH;

    this.setModel(this.model);
    this.setSize(this.mins, this.maxs);
    this.setOrigin(this.origin);

    // start by finding the first target once they all have spawned
    this._scheduleThink(this.ltime + 0.1, () => this._trainFind());
  }

  _trainFind() {
    // position the train at the first target's origin (minus our mins for alignment)
    const targetEntity = this.findFirstEntityByFieldAndValue('targetname', this.target);
    console.assert(targetEntity, 'func_train: target not found');
    this.setOrigin(targetEntity.origin.copy().subtract(this.mins));
    // if not triggered by a use.
    if (!this.targetname) {
      this._scheduleThink(this.ltime + 0.1, () => this._trainNext());
    }
  }

  _trainNext() {
    const targetEntity = this.findFirstEntityByFieldAndValue('targetname', this.target);
    console.assert(targetEntity.target, 'func_train: no next target');
    this.target = targetEntity.target; // update to point to the next target
    this.wait = targetEntity.wait ? targetEntity.wait : 0;
    this.startSound(channel.CHAN_VOICE, this.noise1);
    // move to the next target position (adjusted by our mins)
    this._sub.calcMove(targetEntity.origin.copy().subtract(this.mins), this.speed, () => this._trainWait());
  }

  _trainWait() {
    if (this.wait) {
      this.startSound(channel.CHAN_VOICE, this.noise);
    }

    // schedule the next move after "wait" seconds (defaulting to a minimal delay)
    const delay = this.wait ? this.wait : 0.1;
    this._scheduleThink(this.ltime + delay, () => this._trainNext());
  }

  blocked(blockingEntity) {
    this.damage(blockingEntity, this.dmg);
    // impose a short cooldown of 0.5 seconds to avoid repeated blockage processing
    if (this.nextthink < this.ltime + 0.5) {
      this.nextthink = this.ltime + 0.5;
    }
  }

  // eslint-disable-next-line no-unused-vars
  use(activatorEntity) {
    if (this._isActivated) {
      return;
    }

    this._isActivated = true;

    this._trainNext();
  }
}

/**
 * QUAKED misc_teleporttrain (0 .5 .8) (-8 -8 -8) (8 8 8)
 * This is used for the final boss
 */
export class TeleportTrainEntity extends TrainEntity {
  static classname = 'misc_teleporttrain';

  _precache() {
    this.engine.PrecacheSound('misc/null.wav');
    this.engine.PrecacheModel('progs/teleport.mdl');
  }

  spawn() {
    if (!this.speed) {
      this.speed = 100;
    }

    console.assert(this.target, 'func_train requires a target');

    this.solid = solid.SOLID_NOT;
    this.movetype = moveType.MOVETYPE_PUSH;
    this.avelocity.setTo(100, 200, 300);

    this.noise = 'misc/null.wav';
    this.noise1 = 'misc/null.wav';

    this.setModel('progs/teleport.mdl');

    // Ensure size and origin are set
    this.setSize(this.mins, this.maxs);
    this.setOrigin(this.origin);

    // Schedule the initial train find think
    this._scheduleThink(this.ltime + 0.1, () => this._trainFind());
  }
}
