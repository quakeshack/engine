/* global Vector */

import { attn, channel, moveType, solid, tentType } from "../Defs.mjs";
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

export class BaseLightEntity extends BaseEntity {
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

export class TorchLightEntity extends BaseLightEntity {
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
    this.setSize(Vector.origin, Vector.origin);

    this._scheduleThink(this.game.time + 5.0, () => this.remove());
  }

  touch(otherEntity) {
    this.damage(otherEntity, 20.0);
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
    this._scheduleThink(this.game.time + Math.random() * 5.0, () => this._fire());
  }

  /** @private */
  _fire() {
    this.engine.SpawnEntity('misc_fireball_fireball', {
      origin: this.origin,
      speed: this.speed,
    });

    this._scheduleThink(this.game.time + Math.random() * 5.0, () => this._fire());
  }
}

export class DebugMarkerEntity extends BaseEntity {
  static classname = 'debug_marker';

  _precache() {
    this.engine.PrecacheModel('progs/s_light.spr');
  }

  spawn() {
    this.movetype = moveType.MOVETYPE_NONE;
    this.solid = solid.SOLID_TRIGGER;
    this.setSize(new Vector(-4.0, -4.0, -4.0), new Vector(4.0, 4.0, 4.0));
    this.setModel("progs/s_light.spr");

    if (this.owner instanceof PlayerEntity) {
      this.owner.centerPrint('marker set at ' + this.origin);
    }

    this._scheduleThink(this.game.time + 5.0, () => this.remove());
  }

  /**
   * @param {BaseEntity} otherEntity user
   */
  touch(otherEntity) {
    if (otherEntity.equals(this.owner)) {
      this.remove();
    }
  }
}

export class BaseAmbientSound extends BaseEntity {
  static _sfxName = null;
  static _volume = 0;

  _precache() {
    this.engine.PrecacheSound(this.constructor._sfxName);
  }

  spawn() {
    this.spawnAmbientSound(this.constructor._sfxName, this.constructor._volume, attn.ATTN_STATIC);
  }
};

/**
 * QUAKED ambient_comp_hum (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientCompHum extends BaseAmbientSound {
  static classname = 'ambient_comp_hum';
  static _sfxName = "ambience/comp1.wav";
  static _volume = 1.0;
}

/**
 * QUAKED ambient_drone (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientDrone extends BaseAmbientSound {
  static classname = 'ambient_drone';
  static _sfxName = "ambience/drone6.wav";
  static _volume = 0.5;
}

/**
 * QUAKED ambient_suck_wind (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientSuckWind extends BaseAmbientSound {
  static classname = 'ambient_suck_wind';
  static _sfxName = "ambience/suck1.wav";
  static _volume = 1.0;
}

/**
 * QUAKED ambient_flouro_buzz (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientFlouroBuzz extends BaseAmbientSound {
  static classname = 'ambient_flouro_buzz';
  static _sfxName = "ambience/buzz1.wav";
  static _volume = 1.0;
}

/**
 * QUAKED ambient_drip (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientDrip extends BaseAmbientSound {
  static classname = 'ambient_drip';
  static _sfxName = "ambience/drip1.wav";
  static _volume = 0.5;
}

/**
 * QUAKED ambient_thunder (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientThunder extends BaseAmbientSound {
  static classname = 'ambient_thunder';
  static _sfxName = "ambience/thunder1.wav";
  static _volume = 0.5;
}

/**
 * QUAKED ambient_light_buzz (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientLightBuzz extends BaseAmbientSound {
  static classname = 'ambient_light_buzz';
  static _sfxName = "ambience/fl_hum1.wav";
  static _volume = 0.5;
}

/**
 * QUAKED ambient_swamp1 (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientSwamp1 extends BaseAmbientSound {
  static classname = 'ambient_swamp1';
  static _sfxName = "ambience/swamp1.wav";
  static _volume = 0.5;
}

/**
 * QUAKED ambient_swamp2 (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientSwamp2 extends BaseAmbientSound {
  static classname = 'ambient_swamp2';
  static _sfxName = "ambience/swamp2.wav";
  static _volume = 0.5;
}

export class BaseWallEntity extends BaseEntity {
  // eslint-disable-next-line no-unused-vars
  use(usedByEntity) {
    this.frame = 1 - this.frame;
  }

  spawn() {
    this.angles.clear();
    this.movetype = moveType.MOVETYPE_PUSH; // so it doesn't get pushed by anything
    this.solid = solid.SOLID_BSP;
    this.setModel(this.model);
  }
}

/**
 * QUAKED func_wall (0 .5 .8) ?
 * This is just a solid wall if not inhibitted
 */
export class WallEntity extends BaseWallEntity {
  static classname = 'func_wall';
}

/**
 * QUAKED func_illusionary (0 .5 .8) ?
 * A simple entity that looks solid but lets you walk through it.
 */
export class IllusionaryWallEntity extends BaseWallEntity {
  static classname = 'func_illusionary';

  // eslint-disable-next-line no-unused-vars
  use(usedByEntity) {
    // nothing
  }

  spawn() {
    this.setModel(this.model);
    this.makeStatic();
  }
}

/**
 * QUAKED func_episodegate (0 .5 .8) ? E1 E2 E3 E4
 * This bmodel will appear if the episode has allready been completed, so players can't reenter it.
 */
export class EpisodegateWallEntity extends BaseWallEntity {
  static classname = 'func_episodegate';

  spawn() {
    if (!(this.game.serverflags & this.spawnflags)) {
      this.remove();
      return; // can still enter episode
    }

    super.spawn();
  }
}

/**
 * QUAKED func_bossgate (0 .5 .8) ?
 * This bmodel appears unless players have all of the episode sigils.
 */
export class BossgateWallEntity extends BaseWallEntity {
  static classname = 'func_bossgate';

  spawn() {
    if ((this.game.serverflags & 15) == 15) {
      this.remove();
      return; // all episodes completed
    }

    super.spawn();
  }
}

/**
 * Ephemeral teleport fog effect.
 */
export class TeleportEffectEntity extends BaseEntity {
  static classname = 'misc_tfog';

  /** @protected */
  _playTeleport() {
    this.startSound(channel.CHAN_VOICE, `misc/r_tele${Math.floor(Math.random() * 5) + 1}.wav`);
    this.remove();
  }

  spawn() {
    this._scheduleThink(this.game.time + 0.2, () => this._playTeleport());

    this.engine.DispatchTempEntityEvent(tentType.TE_TELEPORT, this.origin);
  }
}
