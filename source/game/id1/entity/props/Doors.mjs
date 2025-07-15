import Vector from '../../../../shared/Vector.mjs';

import { attn, channel, colors, damage, items, moveType, solid, worldType } from '../../Defs.mjs';
import BaseEntity from '../BaseEntity.mjs';
import { itemNames } from '../Items.mjs';
import { PlayerEntity } from '../Player.mjs';
import { TriggerFieldEntity } from '../Subs.mjs';
import { DamageHandler } from '../Weapons.mjs';
import BasePropEntity, { state } from './BasePropEntity.mjs';

/**
 * door flags (used in spawnflags)
 */
export const flag = {
  DOOR_START_OPEN: 1,
  DOOR_DONT_LINK: 4,
  DOOR_GOLD_KEY: 8,
  DOOR_SILVER_KEY: 16,
  DOOR_TOGGLE: 32,
};

export class BaseDoorEntity extends BasePropEntity {
  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    /** @type {?BaseDoorEntity} linked door @protected */
    this._linkedDoor = null; // entity (QuakeC: enemy)
    /** @type {?TriggerFieldEntity} trigger field @protected */
    this._triggerField = null; // trigger field
    /** @type {?string} */
    this.noise4 = null;

    this._serializer.endFields();

    /** used during linking doors for crossing entity classes @readonly @private */
    this._doormarker = 'door';
  }

  /**
   * spawns a trigger infront of the door
   * @param {Vector} mins min size
   * @param {Vector} maxs max size
   * @returns {TriggerFieldEntity} trigger field
   */
  _spawnTriggerField(mins, maxs) {
    return this.engine.SpawnEntity(TriggerFieldEntity.classname, {
      owner: this,
      mins,
      maxs,
    });
  }

  /**
   * QuakeC: LinkDoors
   */
  _linkDoors() {
    if (this._linkedDoor) {
      // already linked by another door
      return;
    }

    if (this.spawnflags & flag.DOOR_DONT_LINK) {
      this._linkedDoor = this.owner = this;
      return; // don't want to link this door
    }

    const cmins = this.mins, cmaxs = this.maxs;

    let t = this, self = this;

    do {
      self.owner = this; // master door

      if (self.health) {
        this.health = self.health;
      }

      if (self.targetname) {
        this.targetname = self.targetname;
      }

      if (self.message) {
        this.message = self.message;
      }

      t = t.findNextEntityByFieldAndValue('_doormarker', 'door');
      if (!t) {
        self._linkedDoor = this; // make the chain a loop

        // shootable, fired, or key doors just needed the owner/enemy links,
        // they don't spawn a field

        self = self.owner;

        if (self.health || self.targetname || self.items) {
          return;
        }

        self.owner._triggerField = self._spawnTriggerField(cmins, cmaxs);

        return;
      }

      if (self.isTouching(t)) {
        console.assert(!this._linkedDoor, 'no cross connected doors');

        self._linkedDoor = t;
        self = t;

        for (let i = 0; i < 3; i++) {
          if (t.mins[i] < cmins[i]) {
            cmins[i] = t.mins[i];
          }

          if (t.maxs[i] > cmaxs[i]) {
            cmaxs[i] = t.maxs[i];
          }
        }
      }
      // eslint-disable-next-line no-constant-condition
    } while (true);
  }

  _doorFire(usedByEntity) {
    console.assert(usedByEntity !== null, 'user required');

    // CR: triggers on E1M4 for some reason
    // console.assert(this.owner.equals(this), 'Doors must be linked back to itself');

    if (this.items) {
      this.startSound(channel.CHAN_VOICE, this.noise4);
    }

    this.message = null;

    // CR: code below is almost verbatim QuakeC, don’t blame me for its beauty

    if (this.spawnflags & flag.DOOR_TOGGLE) {
      // is open or opening
      if (this.state === state.STATE_UP || this.state === state.STATE_TOP) {
        let self = this;
        do {
          self._doorGoDown(usedByEntity);
          self = self._linkedDoor;
        } while (self && !self.equals(this) && !self.isWorld());
        return;
      }
    }

    // trigger all paired doors
    let self = this;
    do {
      self._doorGoUp(usedByEntity);
      self = self._linkedDoor;
    } while (self && !self.equals(this) && !self.isWorld());
  }

  /**
   * @param {BaseEntity} blockedByEntity blocking entity
   */
  _doorBlocked(blockedByEntity) {
    console.assert(blockedByEntity !== null, 'blocking entity required');

    this.damage(blockedByEntity, this.dmg, null, blockedByEntity.centerPoint);

    // if a door has a negative wait, it would never come back if blocked,
    // so let it just squash the object to death real fast
    if (this.wait >= 0) {
      if (this.state === state.STATE_DOWN) {
        this._doorGoUp(blockedByEntity);
      } else {
        this._doorGoDown(blockedByEntity);
      }
    }
  }

  _doorGoDown(usedByEntity) {
    console.assert(usedByEntity !== null, 'user required');

    if (this.state === state.STATE_DOWN) {
      return; // already going up
    }

    this.startSound(channel.CHAN_VOICE, this.noise2);
    this.state = state.STATE_DOWN;

    if (this.max_health) {
      this.takedamage = damage.DAMAGE_YES;
      this.health = this.max_health;
    }

    this._sub.calcMove(this.pos1, this.speed, () => this._doorHitBottom());
    this._sub.useTargets(usedByEntity); // CR: I added this
  }

  _doorHitBottom() {
    this.startSound(channel.CHAN_VOICE, this.noise1);
    this.state = state.STATE_BOTTOM;
    this._sub.reset();
  }

  _doorGoUp(usedByEntity) {
    console.assert(usedByEntity !== null, 'user required');

    if (this.state === state.STATE_UP) {
      return; // already going up
    }

    if (this.state === state.STATE_TOP) {
      // reset top wait time
      this.nextthink = this.ltime + this.wait;
      return;
    }

    this.startSound(channel.CHAN_VOICE, this.noise2);
    this.state = state.STATE_UP;

    this._sub.calcMove(this.pos2, this.speed, () => this._doorHitTop());
    this._sub.useTargets(usedByEntity);
  }

  _doorHitTop() {
    this.startSound(channel.CHAN_VOICE, this.noise1);
    this.state = state.STATE_TOP;

    if (this.spawnflags & flag.DOOR_TOGGLE) {
      return;		// don't come down automatically
    }

    this._sub.reset();
    this._scheduleThink(this.ltime + this.wait, () => this._doorGoDown());
  }

  _doorKilled(attackerEntity) {
    const owner = this.owner;

    owner.health = owner.max_health;
    owner.takedamage = damage.DAMAGE_NO;
    owner.use(attackerEntity);
  }

  /**
   * @param {BaseEntity} usedByEntity user
   */
  use(usedByEntity) {
    if (!usedByEntity.isActor()) {
      return;
    }

    this.message = null;

    if (this.owner) {
      this.owner.message = null;
    }

    if (this._linkedDoor) {
      this._linkedDoor.message = null;
    }

    this._doorFire(usedByEntity);
  }
};

/**
 * QUAKED func_door (0 .5 .8) ? START_OPEN x DOOR_DONT_LINK GOLD_KEY SILVER_KEY TOGGLE
 * if two doors touch, they are assumed to be connected and operate as a unit.
 *
 * TOGGLE causes the door to wait in both the start and end states for a trigger event.
 *
 * START_OPEN causes the door to move to its destination when spawned, and operate in reverse.  It is used to temporarily or permanently close off an area when triggered (not usefull for touch or takedamage doors).
 *
 * Key doors are always wait -1.
 *
 * "message"	is printed when the door is touched if it is a trigger door and it hasn't been fired yet
 * "angle"		determines the opening direction
 * "targetname" if set, no touch field will be spawned and a remote button or trigger field activates the door.
 * "health"	if set, door must be shot open
 * "speed"		movement speed (100 default)
 * "wait"		wait before returning (3 default, -1 = never return)
 * "lip"		lip remaining at end of move (8 default)
 * "dmg"		damage to inflict when blocked (2 default)
 * "sounds"
 * 0)	no sound
 * 1)	stone
 * 2)	base
 * 3)	stone chain
 * 4)	screechy metal
 */
export class DoorEntity extends BaseDoorEntity {
  static classname = 'func_door';

  static _sounds = [
    ['misc/null.wav', 'misc/null.wav'],
    ['doors/drclos4.wav', 'doors/doormv1.wav'],
    ['doors/hydro2.wav', 'doors/hydro1.wav'],
    ['doors/stndr2.wav', 'doors/stndr1.wav'],
    ['doors/ddoor2.wav', 'doors/ddoor1.wav'],
  ];

  static _lockSounds = {
    [worldType.MEDIEVAL]: ['doors/medtry.wav', 'doors/meduse.wav'],
    [worldType.RUNES]: ['doors/runetry.wav', 'doors/runeuse.wav'],
    [worldType.BASE]: ['doors/basetry.wav', 'doors/baseuse.wav'],
  };

  get netname() {
    return 'a door';
  }

  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    // defaults set in spawn
    this.message = null;
    this.angle = new Vector();
    this.targetname = null;
    this.dmg = 0;

    this.items = 0; // e.g. IT_KEY1, IT_KEY2

    this.health = 0;
    this.max_health = 0; // “players maximum health is stored here”

    /** @protected */
    this._doorKeyUsed = false;

    this._serializer.endFields();

    this._damageHandler = new DamageHandler(this);
  }

  thinkDie(attackerEntity) {
    this._doorKilled(attackerEntity);
  }

  _precache() {
    const sounds = [];

    sounds.push(...this.constructor._lockSounds[this.game.worldspawn.worldtype]);
    sounds.push(...this.constructor._sounds[this.sounds]);

    for (const sfx of new Set(sounds)) {
      if (!sfx) {
        continue;
      }

      this.engine.PrecacheSound(sfx);
    }
  }

  spawn() {
    const lockSounds = this.constructor._lockSounds[this.game.worldspawn.worldtype];

    console.assert(lockSounds instanceof Array && lockSounds.length === 2, 'exactly two lock sounds for given world type required');

    [this.noise3, this.noise4] = lockSounds;

    const sounds = this.constructor._sounds[this.sounds];

    console.assert(sounds instanceof Array && sounds.length === 2, 'exactly two lock sounds for given world type required');

    [this.noise1, this.noise2] = sounds;

    console.assert(typeof(this.noise1) === 'string', 'noise1 must be a string');
    console.assert(typeof(this.noise2) === 'string', 'noise2 must be a string');
    console.assert(typeof(this.noise3) === 'string', 'noise3 must be a string');
    console.assert(typeof(this.noise4) === 'string', 'noise4 must be a string');

    this._sub.setMovedir();

    this.max_health = this.health;

    this.solid = solid.SOLID_BSP;
    this.movetype = moveType.MOVETYPE_PUSH;

    this.setOrigin(this.origin);
    this.setModel(this.model);

    if (this.spawnflags & flag.DOOR_SILVER_KEY) {
      this.items = items.IT_KEY1;
    } else if (this.spawnflags & flag.DOOR_GOLD_KEY) {
      this.items = items.IT_KEY2;
    }

    if (!this.speed) {
      this.speed = 100;
    }

    if (!this.wait) {
      this.wait = 3;
    }

    if (!this.lip) {
      this.lip = 8;
    }

    if (!this.dmg) {
      this.dmg = 2;
    }

    this.pos1 = this.origin.copy();
    this.pos2 = this.pos1.copy().add(this.movedir.copy().multiply(Math.abs(this.movedir.dot(this.size)) - this.lip));

    // DOOR_START_OPEN is to allow an entity to be lighted in the closed position
    // but spawn in the open position

    if (this.spawnflags & flag.DOOR_START_OPEN) {
      this.setOrigin(this.pos2);
      this.pos2 = this.pos1.copy();
      this.pos1 = this.origin.copy();
    }

    this.state = state.STATE_BOTTOM;

    if (this.health > 0) {
      this.takedamage = damage.DAMAGE_YES;
    }

    if (this.items) {
      this.wait = -1.0;
    }

    // LinkDoors can't be done until all of the doors have been spawned, so
    // the sizes can be detected properly.
    this._scheduleThink(this.ltime + 0.1, () => this._linkDoors());
  }

  /**
   * @param {BaseEntity} blockedByEntity blocking entity
   */
  blocked(blockedByEntity) {
    this._doorBlocked(blockedByEntity);
  }

  touch(usedByEntity) {
    if (!(usedByEntity instanceof PlayerEntity)) {
      return;
    }

    if (this._doorKeyUsed) {
      return;
    }

    if (this.owner.attack_finished > this.game.time) {
      return;
    }

    // make sure to only fire every two seconds at most
    this.owner.attack_finished = this.game.time + 2.0;

    if (this.owner.message) {
      usedByEntity.centerPrint(this.owner.message);
      usedByEntity.startSound(channel.CHAN_VOICE, 'misc/talk.wav', 1.0, attn.ATTN_NONE);
    }

    // key door stuff
    if (this.items === 0) {
      return;
    }

    // FIXME: blink key on player's status bar (CR: push an event)
    if ((this.items & usedByEntity.items) !== this.items) {
      const requiredKeys = Object.entries(itemNames)
        .filter(([item]) => (this.items & item) !== 0)
        .map(([, name]) => name);

      usedByEntity.centerPrint(`You need the ${requiredKeys.join(', ')}`);
      usedByEntity.startSound(channel.CHAN_VOICE, 'misc/talk.wav', 1.0, attn.ATTN_NONE);
      return;
    }

    // remove the used key from the inventory
    usedByEntity.items &= ~this.items;

    // mark this (and the linked) door used
    this._doorKeyUsed = true;
    this._linkedDoor._doorKeyUsed = true;

    this.use(usedByEntity);
  }
};

/**
 * QUAKED func_door_secret (0 .5 .8) ? open_once 1st_left 1st_down no_shoot always_shoot
 * Basic secret door. Slides back, then to the side. Angle determines direction.
 * wait  = # of seconds before coming back
 * 1st_left = 1st move is left of arrow
 * 1st_down = 1st move is down from arrow
 * always_shoot = even if targeted, keep shootable
 * t_width = override WIDTH to move back (or height if going down)
 * t_length = override LENGTH to move sideways
 * "dmg"		damage to inflict when blocked (2 default)
 *
 * If a secret door has a targetname, it will only be opened by it's botton or trigger, not by damage.
 * "sounds"
 * 1) medieval
 * 2) metal
 * 3) base
 */
export class SecretDoorEntity extends BaseDoorEntity {
  static classname = 'func_door_secret';

  static SECRET_OPEN_ONCE = 1;		// stays open
  static SECRET_1ST_LEFT = 2;		// 1st move is left of arrow
  static SECRET_1ST_DOWN = 4;		// 1st move is down from arrow
  static SECRET_NO_SHOOT = 8;		// only opened by trigger
  static SECRET_YES_SHOOT = 16;	// shootable even if targeted

  /** @protected */
  static _sounds = [
    [null, null, null],
    ['doors/latch2.wav', 'doors/winch2.wav', 'doors/drclos4.wav'],
    ['doors/airdoor2.wav', 'doors/airdoor1.wav', 'doors/airdoor2.wav'],
    ['doors/basesec2.wav', 'doors/basesec1.wav', 'doors/basesec2.wav'],
  ];

  get netname() {
    return 'a secret door';
  }

  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    this.mangle = new Vector();

    this.t_width = 0;
    this.t_length = 0;

    this._dest0 = null;
    this._dest1 = null;
    this._dest2 = null;

    this.health = 0;
    this.bloodcolor = colors.DUST;

    this._serializer.endFields();

    this._damageHandler = new DamageHandler(this);
  }

  _precache() {
    const sfxlist = this.constructor._sounds[this.sounds];

    for (const sfx of sfxlist) {
      if (!sfx) {
        continue;
      }

      this.engine.PrecacheSound(sfx);
    }
  }

  spawn() {
    if (this.sounds <= 0 || this.sounds >= this.constructor._sounds.length) {
      this.sounds = 3;
    }

    console.assert(this.constructor._sounds[this.sounds] !== undefined, 'sounds must be defined in the sounds list');

    [this.noise1, this.noise2, this.noise3] = this.constructor._sounds[this.sounds];

    console.assert(typeof(this.noise1) === 'string', 'noise1 must be a string');
    console.assert(typeof(this.noise2) === 'string', 'noise2 must be a string');
    console.assert(typeof(this.noise3) === 'string', 'noise3 must be a string');

    if (this.dmg === 0) {
      this.dmg = 2;
    }

    this.mangle.set(this.angles);
    this.angles.clear();
    this.solid = solid.SOLID_BSP;
    this.movetype = moveType.MOVETYPE_PUSH;

    this.setModel(this.model);
    this.setOrigin(this.origin);

    this.speed = 50.0;

    if (!this.targetname || this.spawnflags & SecretDoorEntity.SECRET_YES_SHOOT) {
      this.health = 10000;
      this.takedamage = damage.DAMAGE_YES;
    }

    this.oldorigin.set(this.origin);

    if (!this.wait) {
      this.wait = 5.0;
    }
  }

  thinkDie(attackerEntity) {
    this.use(attackerEntity);
  }

  // eslint-disable-next-line no-unused-vars
  thinkPain(attackerEntity, damage) {
    this.use(attackerEntity);
  }

  touch(touchedByEntity) {
    if (!(touchedByEntity instanceof PlayerEntity)) {
      return;
    }

    if (this.attack_finished > this.game.time) {
      return;
    }

    this.attack_finished = this.game.time + 2.0;

    if (this.message) {
      touchedByEntity.centerPrint(this.message);
      touchedByEntity.startSound(channel.CHAN_BODY, 'misc/talk.wav');
    }
  }

  blocked(blockedByEntity) {
    if (this.game.time < this.attack_finished) {
      return;
    }

    this.attack_finished = this.game.time + 0.5;

    this.damage(blockedByEntity, this.dmg, null, blockedByEntity.centerPoint);
  }

  use(usedByEntity) {
    this.health = 10000;

    if (!this.origin.equals(this.oldorigin)) {
      return;
    }

    this.message = null; // no more message

    this._sub.useTargets(usedByEntity); // fire all targets / killtargets

    if (!(this.spawnflags & SecretDoorEntity.SECRET_NO_SHOOT)) {
      this.takedamage = damage.DAMAGE_NO;
    }

    this.velocity.clear();

    // Make a sound, wait a little...
    this.startSound(channel.CHAN_VOICE, this.noise1);

    const temp = 1 - (this.spawnflags & SecretDoorEntity.SECRET_1ST_LEFT); // 1 or -1

    const { forward, up, right } = this.mangle.angleVectors();

    if (!this.t_width) {
      if (this.spawnflags & SecretDoorEntity.SECRET_1ST_DOWN) {
        this.t_width = Math.abs(up.dot(this.size));
      } else {
        this.t_width = Math.abs(right.dot(this.size));
      }
    }

    if (!this.t_length) {
      this.t_length = Math.abs(forward.dot(this.size));
    }

    if (this.spawnflags & SecretDoorEntity.SECRET_1ST_DOWN) {
      this._dest1 = this.origin.copy().subtract(up.multiply(this.t_width));
    } else {
      this._dest1 = this.origin.copy().add(right.multiply(this.t_width * temp));
    }

    this._dest2 = this._dest1.copy().add(forward.multiply(this.t_length));

    this._sub.calcMove(this._dest1, this.speed, () => this._stepMove(1));
    this.startSound(channel.CHAN_VOICE, this.noise2);
  }

  /**
   * this is the open secret sequence
   * @param {number} step what step to perform
   */
  _stepMove(step) {
    switch (step) {
      case 1: // Wait after first movement...
        this.startSound(channel.CHAN_VOICE, this.noise3);
        this._scheduleThink(this.ltime + 1.0, () => this._stepMove(2));
        break;

      case 2: // Start moving sideways w/sound...
        this.startSound(channel.CHAN_VOICE, this.noise2);
        this._sub.calcMove(this._dest2, this.speed, () => this._stepMove(3));
        break;

      case 3: // Wait here until time to go back...
        this.startSound(channel.CHAN_VOICE, this.noise3);
        if (!(this.spawnflags & SecretDoorEntity.SECRET_OPEN_ONCE)) {
          this._scheduleThink(this.ltime + this.wait, () => this._stepMove(4));
        }
        break;

      case 4: // Move backward...
        this.startSound(channel.CHAN_VOICE, this.noise2);
        this._sub.calcMove(this._dest1, this.speed, () => this._stepMove(5));
        break;

      case 5: // Wait 1 second...
        this.startSound(channel.CHAN_VOICE, this.noise3);
        this._scheduleThink(this.ltime + 1.0, () => this._stepMove(6));
        break;

      case 6: // Move back in place...
        this.startSound(channel.CHAN_VOICE, this.noise2);
        this._sub.calcMove(this.oldorigin, this.speed, () => this._stepMove(7));
        break;

      case 7:
        if (!this.targetname || (this.spawnflags & SecretDoorEntity.SECRET_YES_SHOOT)) {
          this.health = 10000;
          this.takedamage = damage.DAMAGE_YES;
        }
        this.startSound(channel.CHAN_VOICE, this.noise3);
        break;
    }
  }
};
