import BaseEntity from "./BaseEntity.mjs";

/**
 * QUAKED info_null (0 0.5 0) (-4 -4 -4) (4 4 4)
 * Used as a positional target for spotlights, etc.
 */
export class NullEntity extends BaseEntity {
  classname = 'info_null';

  spawn() {
    this.remove();
  }
};

/**
 * QUAKED info_notnull (0 0.5 0) (-4 -4 -4) (4 4 4)
 * Used as a positional target for lightning.
 */
export class InfoNotNullEntity extends BaseEntity {
  classname = 'info_notnull';
};

class BaseLightEntity extends BaseEntity {
  static START_OFF = 1;

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
      if (this.spawnflags & LightEntity.START_OFF)
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
  classname = 'light';

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
  classname = 'light_fluoro';

  spawn() {
    this._defaultStyle();

    this.spawnAmbientSound("ambience/fl_hum1.wav");
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
  classname = 'light_fluorospark';

  spawn() {
    if (!this.style) {
      this.style = 10;
    }

    this.spawnAmbientSound("ambience/buzz1.wav");
  }
}

/**
 * QUAKED light_globe (0 1 0) (-8 -8 -8) (8 8 8)
 * Sphere globe light.
 * Default light value is 300
 * Default style is 0
 */
export class LightGlobe extends BaseLightEntity {
  class = 'light_globe';

  spawn() {
    this.setModel("progs/s_light.spr");
    this.makeStatic();
  }
}

class TorchLightEntity extends BaseLightEntity {
  spawn() {
    this.spawnAmbientSound("ambience/fire1.wav");
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
  classname = 'light_torch_small_walltorch';

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
  classname = 'light_flame_large_yellow';

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
  classname = 'light_flame_small_yellow';

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
  classname = 'light_flame_small_white';

  spawn() {
    this.setModel("progs/flame2.mdl");
    super.spawn();
  }
}
