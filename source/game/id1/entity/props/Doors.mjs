/* global Vector */

import { attn, channel, damage, items, moveType, solid, worldType } from "../../Defs.mjs";
import { PlayerEntity } from "../Player.mjs";
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
};

export class BaseDoorEntity extends BasePropEntity {
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
        this.engine.DebugPrint(`BaseDoorEntity: ${this} does not know this world: ${this.game.worldspawn.worldtype}\n`);
        break;
    }
  }

  spawn() {
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
        this.engine.DebugPrint(`BaseDoorEntity: ${this} does not know sound set #${this.sounds}\n`);
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

    this.state = state.STATE_TOP;

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

  think() {
    // TODO: LinkDoors
  }

  blocked(blockedByEntity) {
    // TODO
    this.engine.ConsolePrint(`DoorEntity.blocked: ${this} is blocked by ${blockedByEntity}\n`);
  }

  use(usedByEntity) {
    // TODO
    this.engine.ConsolePrint(`DoorEntity.use: ${this} is used by ${usedByEntity}\n`);

    if (usedByEntity instanceof PlayerEntity) {
      usedByEntity.startSound(channel.CHAN_BODY, "misc/talk.wav", 1.0, attn.ATTN_NORM);
      usedByEntity.centerPrint('NOT IMPLEMENTED');
    }
  }

  touch(usedByEntity) {
    // TODO
    this.engine.ConsolePrint(`DoorEntity.touch: ${this} is touched by ${usedByEntity}\n`);
  }
}
