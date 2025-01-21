
import { PlayerEntity } from "./entity/Player.mjs";
import { BodyqueEntity, WorldspawnEntity } from "./entity/Worldspawn.mjs";
import { damage, flags, items, moveType, solid } from "./Defs.mjs";
import * as misc from "./entity/Misc.mjs";

const entityFactories = {
  worldspawn: WorldspawnEntity,
  bodyque: BodyqueEntity,
  player: PlayerEntity,

  info_null: misc.NullEntity,
  info_notnull: misc.InfoNotNullEntity,

  viewthing: misc.NullEntity,

  light: misc.LightEntity,
  light_fluorospark: misc.LightFluorosparkEntity,
  light_fluoro: misc.LightFluoroEntity,
  light_torch_small_walltorch: misc.SmallWalltorchLightEntity,
  light_flame_large_yellow: misc.YellowLargeFlameLightEntity,
  light_flame_small_yellow: misc.YellowSmallFlameLightEntity,
  light_flame_small_white: misc.WhiteSmallFlameLightEntity,
};

export class ServerGameAPI {
  /**
   *
   * @param {Game.EngineInterface} engineAPI
   */
  constructor(engineAPI) {
    this.engine = engineAPI; // Game.EngineInterface

    this.coop = 0;
    this.deathmatch = 0;
    this.teamplay = 0;
    this.skill = 0;

    this.force_retouch = 0;

    this.parm1 = 0;
    this.parm2 = 0;
    this.parm3 = 0;
    this.parm4 = 0;
    this.parm5 = 0;
    this.parm6 = 0;
    this.parm7 = 0;
    this.parm8 = 0;
    this.parm9 = 0;
    this.parm10 = 0;
    this.parm11 = 0;
    this.parm12 = 0;
    this.parm13 = 0;
    this.parm14 = 0;
    this.parm15 = 0;

    this.serverflags = 0;

    this.time = 0;
    this.framecount = 0;

    this.other = null; // just a QuakeC engine crutch
    this.worldspawn = null; // QuakeC: world
    this.lastworldspawn = null; // QuakeC: lastspawn
  }

  StartFrame() {
    this.teamplay = this.engine.GetCvar('teamplay').value;
    this.skill = this.engine.GetCvar('skill').value;
    this.framecount++;
  }

  SetNewParms() {
    this.parm1 = items.IT_SHOTGUN | items.IT_AXE;
    this.parm2 = 100;
    this.parm3 = 0;
    this.parm4 = 25;
    this.parm5 = 0;
    this.parm6 = 0;
    this.parm7 = 0;
    this.parm8 = 1;
    this.parm9 = 0;
  };

  PlayerPreThink(edict) {

  }

  PlayerPostThink(edict) {

  }

  ClientConnect(clientEdict) {
    this.engine.BroadcastPrint(`${clientEdict.api.netname} entered the game\n`);

    // a client connecting during an intermission can cause problems
    if (this.intermissionRunning) {
      // TODO: ExitIntermission()
    }
  }

  ClientDisconnect(clientEdict) {

  }

  PutClientInServer(edict) {

    edict.api.classname = "player";
    edict.api.health = 100;
    edict.api.takedamage = damage.DAMAGE_AIM;
    edict.api.solid = solid.SOLID_SLIDEBOX;
    edict.api.movetype = moveType.MOVETYPE_WALK;
    edict.api.show_hostile = 0;
    edict.api.max_health = 100;
    edict.api.flags = flags.FL_CLIENT;
    edict.api.air_finished = this.time + 12;
    edict.api.dmg = 2;   		// initial water damage
    edict.api.super_damage_finished = 0;
    edict.api.radsuit_finished = 0;
    edict.api.invisible_finished = 0;
    edict.api.invincible_finished = 0;
    edict.api.effects = 0;
    edict.api.invincible_time = 0;
  }

  prepareEntity(edict, classname, initialData = {}) {
    if (!entityFactories[classname]) {
      this.engine.ConsolePrint(`ServerGameAPI.prepareEntity: no entity factory for ${classname}!\n`);
      return false;
    }

    const entity = new entityFactories[classname](edict, this);

    entity.assignInitialData(initialData);

    return true;
  }

  spawnPreparedEntity(edict) {
    if (!edict.api) {
      this.engine.ConsolePrint('Cannot spawn empty edict.');
      return false;
    }

    edict.api.spawn();

    return true;
  }
};
