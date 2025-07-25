import Vector from '../../../shared/Vector.mjs';

import { attn, channel, colors, content, damage, effect, moveType, solid, tentType } from '../Defs.mjs';
import { crandom } from '../helper/MiscHelpers.mjs';
import BaseEntity from './BaseEntity.mjs';
import BaseMonster from './monster/BaseMonster.mjs';
import { PlayerEntity } from './Player.mjs';
import { Sub } from './Subs.mjs';
import { DamageHandler, DamageInflictor, Explosions, Laser, Spike, Superspike } from './Weapons.mjs';

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
 * QUAKED info_intermission (1 0.5 0.5) (-16 -16 -16) (16 16 16)
 * This is the camera point for the intermission.
 * Use mangle instead of angle, so you can set pitch or roll as well as yaw.  'pitch roll yaw'
 */
export class IntermissionCameraEntity extends BaseEntity {
  static classname = 'info_intermission';

  _declareFields() {
    this._serializer.startFields();

    this.mangle = new Vector();

    this._serializer.endFields();
  }
};

/**
 * QUAKED viewthing (0 .5 .8) (-8 -8 -8) (8 8 8)
 * Just for the debugging level.  Don't use
 */
export class ViewthingEntity extends BaseEntity {
  static classname = 'viewthing';

  _precache() {
    this.engine.PrecacheModel('progs/player.mdl');
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
    this._serializer.startFields();

    this.light_lev = 0;
    this.style = 0;

    this._serializer.endFields();
  }

  use() {
    if (this.spawnflags & BaseLightEntity.START_OFF) {
      this.engine.Lightstyle(this.style, 'm');
      this.spawnflags = this.spawnflags - BaseLightEntity.START_OFF;
    }
    else {
      this.engine.Lightstyle(this.style, 'a');
      this.spawnflags = this.spawnflags + BaseLightEntity.START_OFF;
    }
  }

  _defaultStyle() {
    if (this.style >= 32) {
      if (this.spawnflags & BaseLightEntity.START_OFF) {
        this.engine.Lightstyle(this.style, 'a');
      } else {
        this.engine.Lightstyle(this.style, 'm');
      }
    }
  }
};

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

    this.spawnAmbientSound('ambience/fl_hum1.wav', 0.5, attn.ATTN_STATIC);
  }
};

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

    this.spawnAmbientSound('ambience/buzz1.wav', 0.5, attn.ATTN_STATIC);
  }
};

/**
 * QUAKED light_globe (0 1 0) (-8 -8 -8) (8 8 8)
 * Sphere globe light.
 * Default light value is 300
 * Default style is 0
 */
export class LightGlobeEntity extends BaseLightEntity {
  static class = 'light_globe';

  _precache() {
    this.engine.PrecacheModel('progs/s_light.spr');
  }

  spawn() {
    this.setModel('progs/s_light.spr');
    this.makeStatic();
  }
};

/**
 * Disappears after 700 ms.
 * TODO: This could be a client-side effect instead of an entity.
 */
export class LightGlobeDynamicEntity extends BaseLightEntity {
  static classname = 'light_globe_dynamic';

  _precache() {
    this.engine.PrecacheModel('progs/s_light.mdl');
  }

  spawn() {
    this.setModel('progs/s_light.mdl');
    this._scheduleThink(this.game.time + 0.2, () => { this.frame = 1; });
    this._scheduleThink(this.game.time + 0.3, () => { this.frame = 2; });
    this._scheduleThink(this.game.time + 0.4, () => { this.remove(); });
  }
};

export class TorchLightEntity extends BaseLightEntity {
  _precache() {
    this.engine.PrecacheModel('progs/flame.mdl');
    this.engine.PrecacheModel('progs/flame2.mdl');
    this.engine.PrecacheSound('ambience/fire1.wav');
  }

  spawn() {
    this.effects |= effect.EF_FULLBRIGHT; // always lit
    this.spawnAmbientSound('ambience/fire1.wav', 0.5, attn.ATTN_STATIC);
    this.makeStatic();
  }
};

/**
 * QUAKED light_torch_small_walltorch (0 .5 0) (-10 -10 -20) (10 10 20)
 * Short wall torch
 * Default light value is 200
 * Default style is 0
 */
export class SmallWalltorchLightEntity extends TorchLightEntity {
  static classname = 'light_torch_small_walltorch';

  spawn() {
    this.setModel('progs/flame.mdl');
    super.spawn();
  }
};

/**
 * QUAKED light_flame_large_yellow (0 1 0) (-10 -10 -12) (12 12 18)
 * Large yellow flame ball
 */
export class YellowLargeFlameLightEntity extends TorchLightEntity {
  static classname = 'light_flame_large_yellow';

  spawn() {
    this.setModel('progs/flame2.mdl');
    this.frame = 1;
    super.spawn();
  }
};

/**
 * QUAKED light_flame_small_yellow (0 1 0) (-8 -8 -8) (8 8 8) START_OFF
 * Small yellow flame ball
 */
export class YellowSmallFlameLightEntity extends TorchLightEntity {
  static classname = 'light_flame_small_yellow';

  spawn() {
    this.setModel('progs/flame2.mdl');
    super.spawn();
  }
};

/**
 * QUAKED light_flame_small_white (0 1 0) (-10 -10 -40) (10 10 40) START_OFF
 * Small white flame ball
 */
export class WhiteSmallFlameLightEntity extends TorchLightEntity {
  static classname = 'light_flame_small_white';

  spawn() {
    this.setModel('progs/flame2.mdl');
    super.spawn();
  }
};

export class FireballEntity extends BaseEntity {
  static classname = 'misc_fireball_fireball';

  _declareFields() {
    this._serializer.startFields();

    this.speed = 1000;

    this._serializer.endFields();
  }

  get netname() {
    return 'a fireball';
  }

  spawn() {
    this.solid = solid.SOLID_TRIGGER;
    this.movetype = moveType.MOVETYPE_TOSS;
    this.effects |= effect.EF_FULLBRIGHT; // always lit
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
};

/**
 * QUAKED misc_fireball (0 .5 .8) (-8 -8 -8) (8 8 8)
 * Lava Balls
 */
export class FireballSpawnerEntity extends BaseEntity {
  static classname = 'misc_fireball';

  _declareFields() {
    this._serializer.startFields();

    this.speed = 1000;

    this._serializer.endFields();
  }

  _precache() {
    this.engine.PrecacheModel('progs/lavaball.mdl');
  }

  spawn() {
    this._scheduleThink(this.game.time + Math.random() * 5.0, () => this._fire());
  }

  /** @private */
  _fire() {
    this.engine.SpawnEntity(FireballEntity.classname, {
      origin: this.origin,
      speed: this.speed,
    });

    this._scheduleThink(this.game.time + Math.random() * 5.0, () => this._fire());
  }
};

export class DebugMarkerEntity extends BaseEntity {
  static classname = 'debug_marker';

  _precache() {
    this.engine.PrecacheModel('progs/s_light.spr');
  }

  spawn() {
    this.movetype = moveType.MOVETYPE_NONE;
    this.solid = solid.SOLID_TRIGGER;
    this.setSize(new Vector(-4.0, -4.0, -4.0), new Vector(4.0, 4.0, 4.0));
    this.setModel('progs/s_light.spr');

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
};

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
  static _sfxName = 'ambience/comp1.wav';
  static _volume = 1.0;
};

/**
 * QUAKED ambient_drone (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientDrone extends BaseAmbientSound {
  static classname = 'ambient_drone';
  static _sfxName = 'ambience/drone6.wav';
  static _volume = 0.5;
};

/**
 * QUAKED ambient_suck_wind (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientSuckWind extends BaseAmbientSound {
  static classname = 'ambient_suck_wind';
  static _sfxName = 'ambience/suck1.wav';
  static _volume = 1.0;
};

/**
 * QUAKED ambient_flouro_buzz (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientFlouroBuzz extends BaseAmbientSound {
  static classname = 'ambient_flouro_buzz';
  static _sfxName = 'ambience/buzz1.wav';
  static _volume = 1.0;
};

/**
 * QUAKED ambient_drip (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientDrip extends BaseAmbientSound {
  static classname = 'ambient_drip';
  static _sfxName = 'ambience/drip1.wav';
  static _volume = 0.5;
};

/**
 * QUAKED ambient_thunder (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientThunder extends BaseAmbientSound {
  static classname = 'ambient_thunder';
  static _sfxName = 'ambience/thunder1.wav';
  static _volume = 0.5;
};

/**
 * QUAKED ambient_light_buzz (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientLightBuzz extends BaseAmbientSound {
  static classname = 'ambient_light_buzz';
  static _sfxName = 'ambience/fl_hum1.wav';
  static _volume = 0.5;
};

/**
 * QUAKED ambient_swamp1 (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientSwamp1 extends BaseAmbientSound {
  static classname = 'ambient_swamp1';
  static _sfxName = 'ambience/swamp1.wav';
  static _volume = 0.5;
};

/**
 * QUAKED ambient_swamp2 (0.3 0.1 0.6) (-10 -10 -8) (10 10 8)
 */
export class AmbientSwamp2 extends BaseAmbientSound {
  static classname = 'ambient_swamp2';
  static _sfxName = 'ambience/swamp2.wav';
  static _volume = 0.5;
};

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
};

/**
 * QUAKED func_wall (0 .5 .8) ?
 * This is just a solid wall if not inhibitted
 */
export class WallEntity extends BaseWallEntity {
  static classname = 'func_wall';
};

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
};

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
};

/**
 * QUAKED func_bossgate (0 .5 .8) ?
 * This bmodel appears unless players have all of the episode sigils.
 */
export class BossgateWallEntity extends BaseWallEntity {
  static classname = 'func_bossgate';

  spawn() {
    if ((this.game.serverflags & 15) === 15) {
      this.remove();
      return; // all episodes completed
    }

    super.spawn();
  }
};

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
};

export class BaseBarrelEntity extends BaseEntity {
  static _model = null;
  static _noise = null;

  _precache() {
    this.engine.PrecacheModel(this.constructor._model);
    this.engine.PrecacheSound(this.constructor._noise);
  }

  _declareFields() {
    this._serializer.startFields();

    this.health = 20;

    this._serializer.endFields();

    this._damageHandler = new DamageHandler(this);
    this._damageInflictor = new DamageInflictor(this);
    this._explosion = new Explosions(this);
  }

  _initStates() {
    this._explosion.initStates();
  }

  get netname() {
    return 'a barrel';
  }

  thinkDie() {
    this.takedamage = damage.DAMAGE_NO; // prevents explosion recursion
    this._damageInflictor.blastDamage(160, this, this.centerPoint, this);
    this.startSound(channel.CHAN_VOICE, this.constructor._noise);
    this.engine.StartParticles(this.origin, Vector.origin, colors.FIRE, 255);

    this.origin[2] += 32;

    this._explosion.becomeExplosion();
  }

  spawn() {
    this.solid = solid.SOLID_BBOX;
    this.movetype = moveType.MOVETYPE_NONE;
    this.takedamage = damage.DAMAGE_AIM;

    this.setModel(this.constructor._model);

    this.origin[2] += 2.0;
    this.dropToFloor();
  }
};

/**
 * QUAKED misc_explobox (0 .5 .8) (0 0 0) (32 32 64)
 */
export class BarrelEntity extends BaseBarrelEntity {
  static classname = 'misc_explobox';

  static _model = 'maps/b_explob.bsp';
  static _noise = 'weapons/r_exp3.wav';
};

/**
 * QUAKED misc_explobox2 (0 .5 .8) (0 0 0) (32 32 64)
 * Smaller exploding box, REGISTERED ONLY
 */
export class SmallBarrelEntity extends BaseBarrelEntity {
  static classname = 'misc_explobox2';

  static _model = 'maps/b_explob.bsp';
  static _noise = 'weapons/r_exp3.wav';
};

/**
 * QUAKED path_corner (0.5 0.3 0) (-8 -8 -8) (8 8 8)
 * Monsters will continue walking towards the next target corner.
 */
export class PathCornerEntity extends BaseEntity {
  static classname = 'path_corner';

  _declareFields() {
    this._serializer.startFields();

    /** @type {number} The number of seconds to spend standing or bowing for path_stand or path_bow */
    this.pausetime = 0;
    /** @type {number} Copied over to enemies or func_train entities */
    this.wait = 0;

    this._serializer.endFields();
  }

  /**
   *
   * @param {BaseMonster} otherEntity any BaseMonster
   */
  touch(otherEntity) {
    if (!(otherEntity instanceof BaseMonster)) {
      return;
    }

    if (!this.equals(otherEntity.movetarget)) {
      return;
    }

    if (otherEntity.enemy) {
      return; // fighting, not following a path
    }

    otherEntity.moveTargetReached(this);
  }

  spawn() {
    console.assert(this.targetname, 'requires targetname to function');

    this.solid = solid.SOLID_TRIGGER;
    this.setSize(new Vector(-8.0, -8.0, -8.0), new Vector(8.0, 8.0, 8.0));
  }
};

/**
 * QUAKED trap_spikeshooter (0 .5 .8) (-8 -8 -8) (8 8 8) superspike laser
 * When triggered, fires a spike in the direction set in QuakeEd.
 * Laser is only for REGISTERED.
 */
export class TrapSpikeshooterEntity extends BaseEntity {
  static classname = 'trap_spikeshooter';

  static SPAWNFLAG_SUPERSPIKE = 1;
  static SPAWNFLAG_LASER = 2;

  _declareFields() {
    this._serializer.startFields();

    this.wait = 0;

    this._serializer.endFields();

    this._sub = new Sub(this);
  }

  _precache() {
    if (this.spawnflags & TrapSpikeshooterEntity.SPAWNFLAG_LASER) {
      this.engine.PrecacheModel('progs/laser.mdl');
      this.engine.PrecacheSound('enforcer/enfire.wav');
      this.engine.PrecacheSound('enforcer/enfstop.wav');
    } else {
      this.engine.PrecacheSound('weapons/spike2.wav');
    }
  }

  // eslint-disable-next-line no-unused-vars
  use(usedByEntity) {
    if (this.spawnflags & TrapSpikeshooterEntity.SPAWNFLAG_LASER) {
      const laser = this.engine.SpawnEntity(Laser.classname, { owner: this, origin: this.origin });
      laser.effects |= effect.EF_MUZZLEFLASH;
    } else {
      this.startSound(channel.CHAN_VOICE, 'weapons/spike2.wav');
      this.engine.SpawnEntity((this.spawnflags & TrapSpikeshooterEntity.SPAWNFLAG_SUPERSPIKE) ? Superspike.classname : Spike.classname, { owner: this, speed: 500.0 });
    }
  }

  spawn() {
    this._sub.setMovedir();
  }
};

/**
 * QUAKED trap_shooter (0 .5 .8) (-8 -8 -8) (8 8 8) superspike laser
 * Continuously fires spikes.
 * "wait" time between spike (1.0 default)
 * "nextthink" delay before firing first spike, so multiple shooters can be stagered.
 */
export class TrapShooterEntity extends TrapSpikeshooterEntity {
  static classname = 'trap_shooter';

  spawn() {
    super.spawn();

    if (this.wait === 0) {
      this.wait = 1;
    }

    // CR: this is a bit of a hack, but it works
    this._scheduleThink(this.wait + this.ltime + this.nextthink, function () { this.use(this); });
  }
};

/**
 * Spawns bubbles, used for the death of the player.
 * Do not place this inside the map, use the static bubble() function instead.
 * For use inside the map, use air_bubbles instead.
 */
export class BubbleSpawnerEntity extends BaseEntity {
  static classname = 'misc_bubble_spawner';

  _declareFields() {
    this._serializer.startFields();

    /** @type {number} how many bubbles to spawn */
    this.bubble_count = 0;
    /** @type {number} how many map units to spread them apart upon spawning */
    this.spread = 0;

    this._serializer.endFields();
  }

  _precache() {
    this.engine.PrecacheModel('progs/s_bubble.spr');
  }

  _spawnBubble() {
    this.engine.SpawnEntity(BubbleEntity.classname, { owner: this });
  }

  spawn() {
    this._scheduleThink(this.game.time + this.bubble_count, function () { this.remove(); });

    while (this.bubble_count > 0) {
      this._scheduleThink(this.game.time + this.bubble_count-- * 0.1, function () { this._spawnBubble(); });
    }
  }

  /**
   * QuakeC: player.qc/DeathBubbles
   * @param {BaseEntity} entity originator entity
   * @param {number} bubbles amount of bubbles to make
   * @returns {BubbleSpawnerEntity} the bubble spawner entity
   */
  static bubble(entity, bubbles) {
    console.assert(entity instanceof BaseEntity, 'bubble() requires a BaseEntity');
    console.assert(bubbles > 0, 'bubble() requires a positive number of bubbles');
    console.assert(bubbles < 50, 'bubble() requires a number of bubbles less than 50');

    return entity.engine.SpawnEntity(BubbleSpawnerEntity.classname, {
      origin: entity.origin.copy().add(entity.view_ofs || Vector.origin),
      bubble_count: bubbles,
      spread: 5,
    });
  }
};

/**
 * QUAKED air_bubbles (0 .5 .8) (-8 -8 -8) (8 8 8)
 * testing air bubbles
 */
export class StaticBubbleSpawnerEntity extends BubbleSpawnerEntity {
  static classname = 'air_bubbles';

  _spawnBubble() {
    super._spawnBubble();
    this._scheduleThink(this.game.time + Math.random() * 1.0 + 1.0, function () { this._spawnBubble(); });
  }

  spawn() {
    this._spawnBubble();
  }
};

export class BubbleEntity extends BaseEntity {
  static classname = 'misc_bubble';

  _precache() {
    this.engine.PrecacheModel('progs/s_bubble.spr');
  }

  touch(otherEntity) {
    if (otherEntity.isWorld()) {
      this.lazyRemove();
      return;
    }
  }

  _bubble() {
    this.watertype = this.engine.DeterminePointContents(this.origin);

    if (this.watertype !== content.CONTENT_WATER) {
      this.remove();
      return;
    }

    if (this.attack_finished < this.game.time) {
      this.remove();
      return;
    }

    this.velocity[0] = crandom() * 2.0;
    this.velocity[1] = crandom() * 2.0;

    this._scheduleThink(this.game.time + 1.0, function () { this._bubble(); });
  }

  spawn() {
    console.assert(this.owner instanceof BubbleSpawnerEntity, 'BubbleEntity requires a BubbleSpawnerEntity as owner');

    // FIXME: this should be moveType.MOVETYPE_BOUNCE but with buoyancy handled by the engine

    // CR: waterlevel 3 and watertype water makes the engine not play splash sounds
    this.waterlevel = 3;
    this.watertype = content.CONTENT_WATER;

    // CR: make sure world touching the bubbles make them go away
    this.solid = solid.SOLID_TRIGGER;

    this.origin.set(this.owner.origin);
    this.origin[0] += crandom() * this.owner.spread;
    this.origin[1] += crandom() * this.owner.spread;
    this.origin[2] += crandom() * this.owner.spread;
    this.setOrigin(this.origin);
    this.setSize(new Vector(-8.0, -8.0, -8.0), new Vector(8.0, 8.0, 8.0));
    this.setModel('progs/s_bubble.spr');
    this.frame = 0;

    // CR: bubbles only live for up to 10s
    this.attack_finished = this.game.time + 10.0;

    // CR: enabling fake buoyancy effect and remove when out of water
    this.movetype = moveType.MOVETYPE_FLY;
    this.velocity = new Vector(0.0, 0.0, 15.0 + crandom());
    this._bubble();
  }
}
