import { damage, moveType, solid } from "../Defs.mjs";
import BaseEntity from "./BaseEntity.mjs";
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

  spawn() {
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
