/* global Vector */

import { attn, channel, damage, items, moveType, solid, worldType } from "../../Defs.mjs";
import { TriggerField } from "../Subs.mjs";
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
  DOOR_NO_TRIGGER_FIELD: 64, // QuakeShack
};

export class BaseDoorEntity extends BasePropEntity {
  _declareFields() {
    super._declareFields();
    this._linkedDoor = null; // entity
    this._triggerField = null; // trigger field
    this.noise4 = null;
  }

  /**
   * spawns a trigger infront of the door
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
      this.startSound(channel.CHAN_VOICE, this.noise4, 1.0, attn.ATTN_NORM);
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

  _doorBlocked() {
    // TODO: door_blocked
    this.engine.ConsolePrint(`BaseDoorEntity._doorBlocked: ${this}\n`);
  }

  _doorGoDown() {
    if (this.state === state.STATE_DOWN) {
      return; // already going up
    }

    this.startSound(channel.CHAN_VOICE, this.noise2, 1.0, attn.ATTN_NORM);
    this.state = state.STATE_DOWN;

    if (this.max_health) {
      this.takedamage = damage.DAMAGE_YES;
      this.health = this.max_health;
    }

    this._subCalcMove(this.pos1, this.speed, () => this._doorHitBottom());

    this.engine.ConsolePrint(`BaseDoorEntity._doorGoDown: ${this}\n`);
  }

  _doorHitBottom() {
    this.startSound (channel.CHAN_VOICE, this.noise1, 1.0, attn.ATTN_NORM);
    this.state = state.STATE_BOTTOM;
    this._subReset();

    this.engine.ConsolePrint(`BaseDoorEntity._doorHitBottom: ${this}\n`);
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

    this.startSound (channel.CHAN_VOICE, this.noise2, 1.0, attn.ATTN_NORM);
    this.state = state.STATE_UP;

    this._subCalcMove(this.pos2, this.speed, () => this._doorHitTop());
    this._subUseTargets();

    this.engine.ConsolePrint(`BaseDoorEntity._doorGoUp: ${this}\n`);
  }

  _doorHitTop() {
    this.startSound (channel.CHAN_VOICE, this.noise1, 1.0, attn.ATTN_NORM);
    this.state = state.STATE_TOP;

    if (this.spawnflags & flag.DOOR_TOGGLE) {
      return;		// don't come down automatically
    }

    this.nextstate = state.STATE_DOWN; // self.think = door_go_down; via state machine
    this.nextthink = this.ltime + this.wait;
    this._subReset();

    this.engine.ConsolePrint(`BaseDoorEntity._doorHitTop: ${this}\n`);
  }

  think() {
    // door state machine, state breaks think
    switch (this.nextstate) {
      case state.STATE_DOWN:
        this._doorGoDown();
        this.nextstate = state.STATE_DONE;
        return;

      case state.STATE_BOTTOM:
        this._doorHitBottom();
        this.nextstate = state.STATE_DONE;
        return;

      case state.STATE_UP:
        this._doorHitTop();
        this.nextstate = state.STATE_DONE;
        return;

      case state.STATE_TOP:
        this._doorHitTop();
        this.nextstate = state.STATE_DONE;
        return;
    }

    // handles delays for us
    this._subThink();

    // we need to handle linking doors during think, because we need to wait for all doors to arrive
    this._linkDoors();
  }

  // eslint-disable-next-line no-unused-vars
  use(usedByEntity) {
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
 * Key doors are allways wait -1.
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
    this.health = 0;
    this.wait = 0;
    this.speed = 0;
    this.dmg = 0;

    this.items = 0; // e.g. IT_KEY1, IT_KEY2

    this.max_health = 0; // “players maximum health is stored here”
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

    switch(this.sounds) {
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

    switch(this.sounds) {
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

    this._setMovedir();

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

    // self.pos1 = self.origin;
    // self.pos2 = self.pos1 + self.movedir*(fabs(self.movedir*self.size) - self.lip);

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
      this.wait = -1;
    }

    // LinkDoors can't be done until all of the doors have been spawned, so
    // the sizes can be detected properly.
    this.nextthink = this.ltime + 0.1;
  }

  blocked(blockedByEntity) {
    // TODO
    this.engine.ConsolePrint(`DoorEntity.blocked: ${this} is blocked by ${blockedByEntity}\n`);
  }

  touch(usedByEntity) {
    // TODO
    this.engine.ConsolePrint(`DoorEntity.touch: ${this} is touched by ${usedByEntity}\n`);
  }
}
