/* global Vector */

import { attn, moveType, solid } from "../Defs.mjs";
import BaseEntity from "./BaseEntity.mjs";
import { PlayerEntity } from "./Player.mjs";

/**
 * QUAKED info_null (0 0.5 0) (-4 -4 -4) (4 4 4)
 * Used as a positional target for spotlights, etc.
 */
export class NullEntity extends BaseEntity {
  static classname = 'info_null';

  spawn() {
    this.remove();
  }
};

/**
 * QUAKED info_notnull (0 0.5 0) (-4 -4 -4) (4 4 4)
 * Used as a positional target for lightning.
 */
export class InfoNotNullEntity extends BaseEntity {
  static classname = 'info_notnull';
};

/**
 * QUAKED viewthing (0 .5 .8) (-8 -8 -8) (8 8 8)
 * Just for the debugging level.  Don't use
 */
export class ViewthingEntity extends BaseEntity {
  static classname = 'viewthing';

  _precache() {
    this.game.PrecacheModel('progs/player.mdl');
  }

  spawn() {
    this.movetype = moveType.MOVETYPE_NONE;
    this.solid = solid.SOLID_NOT;

    this.setModel('progs/player.mdl');
  }
};

class BaseLightEntity extends BaseEntity {
  static START_OFF = 1;

  _declareFields() {
    this.light_lev = 0;
    this.style = 0;
  }

  use() {
    if (this.spawnflags & BaseLightEntity.START_OFF) {
      this.engine.Lightstyle(this.style, "m");
      this.spawnflags = this.spawnflags - BaseLightEntity.START_OFF;
    }
    else {
      this.engine.Lightstyle(this.style, "a");
      this.spawnflags = this.spawnflags + BaseLightEntity.START_OFF;
    }
  }

  _defaultStyle() {
    if (this.style >= 32) {
      if (this.spawnflags & BaseLightEntity.START_OFF)
        this.engine.Lightstyle(this.style, "a");
      else
        this.engine.Lightstyle(this.style, "m");
    }
  }
}

/**
 * QUAKED light (0 1 0) (-8 -8 -8) (8 8 8) START_OFF
 * Non-displayed light.
 * Default light value is 300
 * Default style is 0
 * If targeted, it will toggle between on or off.
 */
export class LightEntity extends BaseLightEntity {
  static classname = 'light';

  spawn() {
    if (!this.targetname) {	// inert light
      this.remove();
      return;
    }

    this._defaultStyle();
  }
}

/**
 * QUAKED light_fluoro (0 1 0) (-8 -8 -8) (8 8 8) START_OFF
 * Non-displayed light.
 * Default light value is 300
 * Default style is 0
 * If targeted, it will toggle between on or off.
 * Makes steady fluorescent humming sound
 */
export class LightFluoroEntity extends BaseLightEntity {
  static classname = 'light_fluoro';

  _precache() {
    this.engine.PrecacheSound('ambience/fl_hum1.wav');
  }

  spawn() {
    this._defaultStyle();

    this.spawnAmbientSound("ambience/fl_hum1.wav", 0.5, attn.ATTN_STATIC);
  }
}

/**
 * QUAKED light_fluorospark (0 1 0) (-8 -8 -8) (8 8 8)
 * Non-displayed light.
 * Default light value is 300
 * Default style is 10
 * Makes sparking, broken fluorescent sound
 */
export class LightFluorosparkEntity extends BaseLightEntity {
  static classname = 'light_fluorospark';

  _precache() {
    this.engine.PrecacheSound('ambience/buzz1.wav');
  }

  spawn() {
    if (!this.style) {
      this.style = 10;
    }

    this.spawnAmbientSound("ambience/buzz1.wav", 0.5, attn.ATTN_STATIC);
  }
}

/**
 * QUAKED light_globe (0 1 0) (-8 -8 -8) (8 8 8)
 * Sphere globe light.
 * Default light value is 300
 * Default style is 0
 */
export class LightGlobe extends BaseLightEntity {
  static class = 'light_globe';

  _precache() {
    this.engine.PrecacheModel('progs/s_light.spr');
  }

  spawn() {
    this.setModel("progs/s_light.spr");
    this.makeStatic();
  }
}

class TorchLightEntity extends BaseLightEntity {
  _precache() {
    this.engine.PrecacheModel('progs/flame.mdl');
    this.engine.PrecacheModel('progs/flame2.mdl');
    this.engine.PrecacheSound('ambience/fire1.wav');
  }

  spawn() {
    this.spawnAmbientSound("ambience/fire1.wav", 0.5, attn.ATTN_STATIC);
    this.makeStatic();
  }
}

/**
 * QUAKED light_torch_small_walltorch (0 .5 0) (-10 -10 -20) (10 10 20)
 * Short wall torch
 * Default light value is 200
 * Default style is 0
 */
export class SmallWalltorchLightEntity extends TorchLightEntity {
  static classname = 'light_torch_small_walltorch';

  spawn() {
    this.setModel("progs/flame.mdl");
    super.spawn();
  }
}

/**
 * QUAKED light_flame_large_yellow (0 1 0) (-10 -10 -12) (12 12 18)
 * Large yellow flame ball
 */
export class YellowLargeFlameLightEntity extends TorchLightEntity {
  static classname = 'light_flame_large_yellow';

  spawn() {
    this.setModel("progs/flame2.mdl");
    this.frame = 1;
    super.spawn();
  }
}

/**
 * QUAKED light_flame_small_yellow (0 1 0) (-8 -8 -8) (8 8 8) START_OFF
 * Small yellow flame ball
 */
export class YellowSmallFlameLightEntity extends TorchLightEntity {
  static classname = 'light_flame_small_yellow';

  spawn() {
    this.setModel("progs/flame2.mdl");
    super.spawn();
  }
}


/**
 * QUAKED light_flame_small_white (0 1 0) (-10 -10 -40) (10 10 40) START_OFF
 * Small white flame ball
 */
export class WhiteSmallFlameLightEntity extends TorchLightEntity {
  static classname = 'light_flame_small_white';

  spawn() {
    this.setModel("progs/flame2.mdl");
    super.spawn();
  }
}

export class FireballEntity extends BaseEntity {
  static classname = 'misc_fireball_fireball';

  _declareFields() {
    this.speed = 1000;
  }

  spawn() {
    this.solid = solid.SOLID_TRIGGER;
    this.movetype = moveType.MOVETYPE_TOSS;
    this.velocity = new Vector(
      (Math.random() * 100) - 50,
      (Math.random() * 100) - 50,
      (Math.random() * 200) + this.speed,
    );
    this.setModel('progs/lavaball.mdl');
    this.nextthink = this.game.time + 5.0;
    this.setSize(Vector.origin, Vector.origin);
  }

  think() {
    this.remove();
  }

  // eslint-disable-next-line no-unused-vars
  touch(otherEntity) {
    // TODO: T_Damage(otherEntity, this, this, 20.0)
    this.remove();
  }
}

/**
 * QUAKED misc_fireball (0 .5 .8) (-8 -8 -8) (8 8 8)
 * Lava Balls
 */
export class FireballSpawnerEntity extends BaseEntity {
  static classname = 'misc_fireball';

  _declareFields() {
    this.speed = 1000;
  }

  _precache() {
    this.engine.PrecacheModel("progs/lavaball.mdl");
  }

  spawn() {
    this.nextthink = this.game.time + Math.random() * 5.0;
  }

  think() {
    this.nextthink = this.game.time + Math.random() * 5.0;

    this.engine.SpawnEntity('fireball', {
      origin: this.origin,
      speed: this.speed,
    });
  }
}

export class DebugMarkerEntity extends BaseLightEntity {
  static classname = 'debug_marker';

  _precache() {
    this.engine.PrecacheModel('progs/s_light.spr');
  }

  spawn() {
    this.movetype = moveType.MOVETYPE_NONE;
    this.solid = solid.SOLID_TRIGGER;
    this.setSize(new Vector(-4.0, -4.0, -4.0), new Vector(4.0, 4.0, 4.0));
    this.setModel("progs/s_light.spr");
    this.nextthink = this.game.time + 5.0;

    if (this.owner instanceof PlayerEntity) {
      this.owner.centerPrint('marker set at ' + this.origin);
    }
  }

  /**
   * @param {BaseEntity} otherEntity user
   */
  touch(otherEntity) {
    if (otherEntity.equals(this.owner)) {
      this.remove();
    }
  }

  think() {
    this.remove();
  }
}
