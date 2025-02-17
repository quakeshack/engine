/* global Vector */

import { attn, channel, damage, items, moveType, solid, worldType } from "../../Defs.mjs";
import BaseEntity from "../BaseEntity.mjs";
import { PlayerEntity } from "../Player.mjs";
import { TriggerField } from "../Subs.mjs";
import { DamageHandler } from "../Weapons.mjs";
import BasePropEntity, { state } from "./BasePropEntity.mjs";

/**
 * door flags (used in spawnflags)
 */
export const flag = {
  DOOR_START_OPEN: 1,
  DOOR_DONT_LINK: 4,
  DOOR_GOLD_KEY: 8,
  DOOR_SILVER_KEY: 16,
  DOOR_TOGGLE: 32,
  DOOR_NO_TRIGGER_FIELD: 64, // QuakeShack (it’s broken lol)
};

export class BaseDoorEntity extends BasePropEntity {
  _declareFields() {
    super._declareFields();
    this._linkedDoor = null; // entity (QuakeC: enemy)
    this._triggerField = null; // trigger field
    this.noise4 = null;
  }

  /**
   * spawns a trigger infront of the door
   * @param {Vector} mins min size
   * @param {Vector} maxs max size
   */
  _spawnTriggerField(mins, maxs) {
    this.engine.SpawnEntity(TriggerField.classname, {
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
      this._linkedDoor = this.owner = null;
      return; // don't want to link this door
    }

    const cmins = this.mins, cmaxs = this.maxs;

    let startEntity = this, t = this, self = this;

    do {
      self.owner = startEntity;

      if (self.health) {
        startEntity.health = self.health;
      }

      if (self.targetname) {
        startEntity.targetname = self.targetname;
      }

      if (self.message && self.message.trim() !== '') {
        startEntity.message = self.message;
      }

      // FIXME: might find a way how to deal with this overwritten classname in QuakeC (door)
      t = t.findNextEntityByFieldAndValue('doormarker', self.classname);
      if (!t) {
        self._linkedDoor = startEntity; // make the chain a loop

        // shootable, fired, or key doors just needed the owner/enemy links,
        // they don't spawn a field

        const owner = self.owner;

        if (owner.health || owner.targetname || owner.items) {
          return;
        }

        if (!(self.flags & flag.DOOR_NO_TRIGGER_FIELD)) { // FIXME: doesn’t work properly, because linked doors behave differently
          owner._triggerField = self._spawnTriggerField(cmins, cmaxs);
        }

        return;
      }

      if (self.isTouching(t)) {
        if (t._linkedDoor) {
          throw new TypeError('cross connected doors');
        }

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

  _doorFire() {
    if (!this.owner.equals(this)) {
      throw new TypeError('door_fire: self.owner != self');
    }

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
          self._doorGoDown();
          self = self._linkedDoor;
        } while (!self.equals(this) && !self.isWorld());
        return;
      }
    }

    // trigger all paired doors
    let self = this;
    do {
      self._doorGoUp();
      self = self._linkedDoor;
    } while (!self.equals(this) && !self.isWorld());
  }

  /**
   * @param {BaseEntity} blockedByEntity blocking entity
   */
  _doorBlocked(blockedByEntity) {
    this.damage(blockedByEntity, this.dmg);

    // if a door has a negative wait, it would never come back if blocked,
    // so let it just squash the object to death real fast
    if (this.wait >= 0) {
      if (this.state === state.STATE_DOWN) {
        this._doorGoUp();
      } else {
        this._doorGoDown();
      }
    }
  }

  _doorGoDown() {
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
  }

  _doorHitBottom() {
    this.startSound(channel.CHAN_VOICE, this.noise1);
    this.state = state.STATE_BOTTOM;
    this._sub.reset();
  }

  _doorGoUp() {
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
    this._sub.useTargets(null);
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

  _doorKilled() {
    const owner = this.owner;

    owner.health = owner.max_health;
    owner.takedamage = damage.DAMAGE_NO;
    owner.use();
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

    this._doorFire();
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

  _declareFields() {
    super._declareFields();

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

    this._damageHandler = new DamageHandler(this);
  }

  // eslint-disable-next-line no-unused-vars
  thinkDie(attackerEntity) {
    this._doorKilled();
  }

  _precache() {
    switch (this.game.worldspawn.worldtype) {
      case worldType.MEDIEVAL:
        this.engine.PrecacheSound("doors/medtry.wav");
        this.engine.PrecacheSound("doors/meduse.wav");
        break;

      case worldType.RUNES:
        this.engine.PrecacheSound("doors/runetry.wav");
        this.engine.PrecacheSound("doors/runeuse.wav");
        break;

      case worldType.BASE:
        this.engine.PrecacheSound("doors/basetry.wav");
        this.engine.PrecacheSound("doors/baseuse.wav");
        break;

      default:
        break;
    }

    switch (this.sounds) {
      case 1:
        this.engine.PrecacheSound("doors/drclos4.wav");
        this.engine.PrecacheSound("doors/doormv1.wav");
        break;

      case 2:
        this.engine.PrecacheSound("doors/hydro1.wav");
        this.engine.PrecacheSound("doors/hydro2.wav");
        break;

      case 3:
        this.engine.PrecacheSound("doors/stndr1.wav");
        this.engine.PrecacheSound("doors/stndr2.wav");
        break;

      case 4:
        this.engine.PrecacheSound("doors/ddoor2.wav");
        this.engine.PrecacheSound("doors/ddoor1.wav");
        break;

      default:
        this.engine.PrecacheSound("misc/null.wav");
        break;
    }
  }

  spawn() {
    switch (this.game.worldspawn.worldtype) {
      case worldType.MEDIEVAL:
        this.noise3 = "doors/medtry.wav";
        this.noise4 = "doors/meduse.wav";
        break;

      case worldType.RUNES:
        this.noise3 = "doors/runetry.wav";
        this.noise4 = "doors/runeuse.wav";
        break;

      case worldType.BASE:
        this.noise3 = "doors/basetry.wav";
        this.noise4 = "doors/baseuse.wav";
        break;

      default:
        this.engine.DebugPrint(`DoorEntity: ${this} does not know this world: ${this.game.worldspawn.worldtype}\n`);
        break;
    }

    switch (this.sounds) {
      case 1:
        this.noise1 = "doors/drclos4.wav";
        this.noise2 = "doors/doormv1.wav";
        break;

      case 2:
        this.noise2 = "doors/hydro1.wav";
        this.noise1 = "doors/hydro2.wav";
        break;

      case 3:
        this.noise2 = "doors/stndr1.wav";
        this.noise1 = "doors/stndr2.wav";
        break;

      case 4:
        this.noise1 = "doors/ddoor2.wav";
        this.noise2 = "doors/ddoor1.wav";
        break;

      default:
        this.engine.DebugPrint(`DoorEntity: ${this} has set unknown sound set ${this.sounds}\n`);
      // eslint-disable-next-line no-fallthrough
      case 0:
        this.noise1 = "misc/null.wav";
        this.noise2 = "misc/null.wav";
        break;
    }

    this._sub.setMovedir();

    this.max_health = this.health;

    this.solid = solid.SOLID_BSP;
    this.movetype = moveType.MOVETYPE_PUSH;

    this.setOrigin(this.origin);
    this.setModel(this.model);

    // FIXME: self.classname = "door"

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
      // TODO: this.th_die = door_killed
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
    // this.engine.ConsolePrint(`DoorEntity.blocked: ${this} is blocked by ${blockedByEntity}\n`);
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
      usedByEntity.startSound(channel.CHAN_VOICE, "misc/talk.wav", 1.0, attn.ATTN_NONE);
    }

    // key door stuff
    if (this.items === 0) {
      return;
    }

    // FIXME: blink key on player's status bar (CR: TODO: push an event)
    if ((this.items & usedByEntity.items) !== this.items) {
      usedByEntity.centerPrint("You need some key to open this door");
      usedByEntity.startSound(channel.CHAN_VOICE, "misc/talk.wav", 1.0, attn.ATTN_NONE);

      // TODO: messages and sound
      return;
    }

    // remove the used key from the inventory
    usedByEntity &= ~this.items;

    // mark this (and the linked) door used
    this._doorKeyUsed = true;
    this._linkedDoor._doorKeyUsed = true;

    this.use(usedByEntity);

    // this.engine.ConsolePrint(`DoorEntity.touch: ${this} is touched by ${usedByEntity}\n`);
  }
}

export class SecretDoorEntity extends BaseDoorEntity {
  static classname = 'func_door_secret';

  static SECRET_OPEN_ONCE = 1;		// stays open
  static SECRET_1ST_LEFT = 2;		// 1st move is left of arrow
  static SECRET_1ST_DOWN = 4;		// 1st move is down from arrow
  static SECRET_NO_SHOOT = 8;		// only opened by trigger
  static SECRET_YES_SHOOT = 16;	// shootable even if targeted

  _declareFields() {
    super._declareFields();
    this.mangle = new Vector();

    this.t_width = 0;
    this.t_length = 0;

    this._dest0 = null;
    this._dest1 = null;
    this._dest2 = null;

    this.health = 0;

    this._damageHandler = new DamageHandler(this);
  }

  _precache() {
    switch (this.sounds) {
      case 1:
        this.engine.PrecacheSound("doors/latch2.wav");
        this.engine.PrecacheSound("doors/winch2.wav");
        this.engine.PrecacheSound("doors/drclos4.wav");
        break;

      case 2:
        this.engine.PrecacheSound("doors/airdoor1.wav");
        this.engine.PrecacheSound("doors/airdoor2.wav");
        break;

      default: // non-Quake default
      case 3:
        this.engine.PrecacheSound("doors/basesec1.wav");
        this.engine.PrecacheSound("doors/basesec2.wav");
        break;
    }
  }

  spawn() {
    if (this.sounds === 0) {
      this.sounds = 3;
    }

    switch (this.sounds) {
      case 1:
        this.noise1 = "doors/latch2.wav";
        this.noise2 = "doors/winch2.wav";
        this.noise3 = "doors/drclos4.wav";
        break;

      case 2:
        this.noise2 = "doors/airdoor1.wav";
        this.noise1 = "doors/airdoor2.wav";
        this.noise3 = "doors/airdoor2.wav";
        break;

      default: // non-Quake default
      case 3:
        this.noise2 = "doors/basesec1.wav";
        this.noise1 = "doors/basesec2.wav";
        this.noise3 = "doors/basesec2.wav";
        break;
    }

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
  thinkPain(attackerEntity, inflictedDamage) {
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
      touchedByEntity.startSound(channel.CHAN_BODY, "misc/talk.wav");
    }
  }

  blocked(blockedByEntity) {
    if (this.game.time < this.attack_finished) {
      return;
    }

    this.attack_finished = this.game.time + 0.5;

    this.damage(blockedByEntity, this.dmg);
  }

  use(usedByEntity) {
    // TODO: this.health = 10000;

    if (!this.origin.equals(this.oldorigin)) {
      return;
    }

    this.message = null;

    this._sub.useTargets(usedByEntity); // fire all targets / killtargets

    if (!(this.spawnflags & SecretDoorEntity.SECRET_NO_SHOOT)) {
      // TODO: self.th_pain = SUB_Null;
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
        // TODO:
        // if (!self.targetname || self.spawnflags&SECRET_YES_SHOOT)
        //   {
        //     self.health = 10000;
        //     self.takedamage = DAMAGE_YES;
        //     self.th_pain = fd_secret_use;
        //   }
        this.startSound(channel.CHAN_VOICE, this.noise3);
        break;
    }
  }
}
