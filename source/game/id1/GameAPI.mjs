
import { InfoPlayerStart, PlayerEntity } from "./entity/Player.mjs";
import { BodyqueEntity, WorldspawnEntity } from "./entity/Worldspawn.mjs";
import { items } from "./Defs.mjs";
import * as misc from "./entity/Misc.mjs";
import ArmySoldierMonster from "./entity/monster/Soldier.mjs";
import { GameAI } from "./helper/AI.mjs";

const entityFactories = {
  worldspawn: WorldspawnEntity,
  bodyque: BodyqueEntity,
  player: PlayerEntity,

  info_null: misc.NullEntity,
  info_notnull: misc.InfoNotNullEntity,

  info_player_start: InfoPlayerStart,

  viewthing: misc.NullEntity,

  light: misc.LightEntity,
  light_fluorospark: misc.LightFluorosparkEntity,
  light_fluoro: misc.LightFluoroEntity,
  light_torch_small_walltorch: misc.SmallWalltorchLightEntity,
  light_flame_large_yellow: misc.YellowLargeFlameLightEntity,
  light_flame_small_yellow: misc.YellowSmallFlameLightEntity,
  light_flame_small_white: misc.WhiteSmallFlameLightEntity,

  misc_fireball: misc.FireballSpawnerEntity,
  fireball: misc.FireballEntity,

  monster_army: ArmySoldierMonster,
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

    this.worldspawn = null; // QuakeC: world
    this.lastspawn = null;

    this.gameAI = new GameAI(this);

    // FIXME: I’m not happy about this, this needs to be next to models
    this._modelData = {
      'progs/soldier.mdl': engineAPI.ParseQC(`
$cd id1/models/soldier3
$origin 0 -6 24
$base base
$skin skin

$frame stand1 stand2 stand3 stand4 stand5 stand6 stand7 stand8

$frame death1 death2 death3 death4 death5 death6 death7 death8
$frame death9 death10

$frame deathc1 deathc2 deathc3 deathc4 deathc5 deathc6 deathc7 deathc8
$frame deathc9 deathc10 deathc11

$frame load1 load2 load3 load4 load5 load6 load7 load8 load9 load10 load11

$frame pain1 pain2 pain3 pain4 pain5 pain6

$frame painb1 painb2 painb3 painb4 painb5 painb6 painb7 painb8 painb9 painb10
$frame painb11 painb12 painb13 painb14

$frame painc1 painc2 painc3 painc4 painc5 painc6 painc7 painc8 painc9 painc10
$frame painc11 painc12 painc13

$frame run1 run2 run3 run4 run5 run6 run7 run8

$frame shoot1 shoot2 shoot3 shoot4 shoot5 shoot6 shoot7 shoot8 shoot9

$frame prowl_1 prowl_2 prowl_3 prowl_4 prowl_5 prowl_6 prowl_7 prowl_8
$frame prowl_9 prowl_10 prowl_11 prowl_12 prowl_13 prowl_14 prowl_15 prowl_16
$frame prowl_17 prowl_18 prowl_19 prowl_20 prowl_21 prowl_22 prowl_23 prowl_24
      `),
    }
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
    // FIXME: move to PlayerEntity
    const entity = edict.api;

    entity.putPlayerInServer();
  }

  prepareEntity(edict, classname, initialData = {}) {
    if (!entityFactories[classname]) {
      this.engine.ConsolePrint(`ServerGameAPI.prepareEntity: no entity factory for ${classname}!\n`);
      return false;
    }

    const entity = edict.api?.classname === classname ? edict.api : new entityFactories[classname](edict, this);

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
