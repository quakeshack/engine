import { attn, damage, flags, moveType, solid } from "../Defs.mjs";
import BaseEntity from "./BaseEntity.mjs";
import { PlayerEntity } from "./Player.mjs";
import { Sub } from "./Subs.mjs";

class BaseTriggerEntity extends BaseEntity {
  /** @protected */
  static _sounds = [
    'misc/secret.wav',
    'misc/talk.wav',
    'misc/trigger1.wav',
  ];

  static SPAWNFLAG_NOTOUCH = 1;
  static SPAWNFLAG_NOMESSAGE = 1;

  _declareFields() {
    this.sounds = 0;
    this.noise = null;
    this.health = 0;
    this.max_health = 0;

    this.wait = 0;

    this._sub = new Sub(this);
  }

  _precache() {
    if (this.constructor._sounds[this.sound]) {
      this.engine.PrecacheSound(this.constructor._sounds[this.sound - 1]);
    }
  }

  spawn() { // QuakeC: subs.qc/InitTrigger
    this.noise = this.constructor._sounds[this.sound - 1];

    this._sub.setMovedir();
    this.solid = solid.SOLID_TRIGGER;
    this.setModel(this.model); // set size and link into world
    this.movetype = moveType.MOVETYPE_NONE;
    this.model = null;
    this.modelindex = 0;
  }
}

export class MultipleTriggerEntity extends BaseTriggerEntity {
  static classname = 'trigger_multiple';

  spawn() {
    super.spawn();

    if (!this.wait) {
      this.wait = 0.2;
    }

    if (this.health > 0) {
      this.max_health = this.health;
      // TODO: self.th_die = multi_killed;
      this.takedamage = damage.DAMAGE_YES;
      this.solid = solid.SOLID_BBOX;
      this.setOrigin(this.origin); // make sure it links into the world
    }
  }

  touch(touchedByEntity) {
    if (this.spawnflags & BaseTriggerEntity.SPAWNFLAG_NOTOUCH) {
      return;
    }

    // TODO: self.touch = multi_touch;
  }

  use(usedByEntity) {
    // TODO: self.use = multi_use;
  }
}

/**
 * QUAKED trigger_teleport (.5 .5 .5) ? PLAYER_ONLY SILENT
 * Any object touching this will be transported to the corresponding info_teleport_destination entity. You must set the "target" field, and create an object with a "targetname" field that matches.
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
    this.engine.SpawnEntity('misc_tfog', { origin: touchedByEntity.origin });

    /** @type {InfoTeleportDestination} */
    const target = this.findFirstEntityByFieldAndValue("targetname", this.target);

    if (!target) {
      this.engine.DebugPrint(`TeleportTriggerEntity: target (${this.target}) missing.\n`);
      return; // FIXME: bitch and complain that the target disappeared
    }

    const { forward } = target.angles.angleVectors();

    // spawn a tfog flash in front of the destination
    this.engine.SpawnEntity('misc_tfog', { origin: forward.copy().multiply(32.0).add(target.origin) });

    this.engine.SpawnEntity('misc_teledeath', {
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
      // CR: there’s some nonsense regarding flags in the original
      // if (touchedByEntity.flags & flags.FL_ONGROUND) {
      //   touchedByEntity &= ~flags.FL_ONGROUND;
      // }
      touchedByEntity.velocity.set(forward.multiply(300));
    }

    touchedByEntity &= ~flags.FL_ONGROUND;
  }

  spawn() {
    if (!this.target) {
      this.engine.DebugPrint('TeleportTriggerEntity: removed, because no target had been set.\n');
      this.remove();
      return;
    }

    super.spawn();

    if (!(this.spawnflags & TeleportTriggerEntity.FLAG_SILENT)) {
      const origin = this.mins.copy().add(this.maxs).multiply(0.5); // middle of the brush

      this.engine.SpawnAmbientSound(origin, 'ambience/hum1.wav', 0.5, attn.ATTN_STATIC);
    }
  }
}

/**
 * QUAKED info_teleport_destination (.5 .5 .5) (-8 -8 -8) (8 8 32)
 * This is the destination marker for a teleporter.  It should have a "targetname" field with the same value as a teleporter's "target" field.
 */
export class InfoTeleportDestination extends BaseEntity {
  static classname = 'info_teleport_destination';

  _declareFields() {
    this.targetname = null;
  }

  spawn() {
    if (!this.targetname) {
      this.engine.DebugPrint('InfoTeleportDestination: removed, because no targetname had been set.\n');
      this.remove();
      return;
    }

    this.origin[2] += 27.0;
  }
}
