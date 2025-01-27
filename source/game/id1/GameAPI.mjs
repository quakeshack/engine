
import { InfoPlayerStart, PlayerEntity } from "./entity/Player.mjs";
import { BodyqueEntity, WorldspawnEntity } from "./entity/Worldspawn.mjs";
import { items } from "./Defs.mjs";
import * as misc from "./entity/Misc.mjs";
import * as door from "./entity/props/Doors.mjs";
import ArmySoldierMonster from "./entity/monster/Soldier.mjs";
import { GameAI } from "./helper/AI.mjs";
import { IntermissionCameraEntity } from "./entity/Client.mjs";
import { TriggerField } from "./entity/Subs.mjs";

// put all entity classes here:
const entityRegistry = [
  WorldspawnEntity,
  BodyqueEntity,
  PlayerEntity,

  misc.NullEntity,
  misc.InfoNotNullEntity,

  InfoPlayerStart,

  misc.ViewthingEntity,

  misc.LightEntity,
  misc.LightFluorosparkEntity,
  misc.LightFluoroEntity,
  misc.SmallWalltorchLightEntity,
  misc.YellowLargeFlameLightEntity,
  misc.YellowSmallFlameLightEntity,
  misc.WhiteSmallFlameLightEntity,

  misc.FireballSpawnerEntity,
  misc.FireballEntity,

  ArmySoldierMonster,

  IntermissionCameraEntity,

  door.DoorEntity,

  TriggerField,
];

export class ServerGameAPI {
  /**
   *
   * @param {Game.EngineInterface} engineAPI
   */
  constructor(engineAPI) {
    this._loadEntityRegistry();

    this.engine = engineAPI; // Game.EngineInterface

    this.coop = 0;
    this.deathmatch = 0;
    this.teamplay = 0;
    this.skill = 0;

    this.force_retouch = 0;

    // checkout Player.decodeLevelParms to understand this
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

    this.intermission_running = 0.0;
    this.intermission_exittime = 0.0;

    this.gameAI = new GameAI(this);

    // bodyque ref
    this.bodyque_head = null;

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
    };

    Object.seal(this);
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

  _assertClientEntityIsPlayerEntity(clientEntity) {
    if (!(clientEntity instanceof PlayerEntity)) {
      throw new Error('clientEdict must carry a PlayerEntity!');
    }
  }

  SetChangeParms(clientEdict) {
    const playerEntity = clientEdict.api;
    this._assertClientEntityIsPlayerEntity(playerEntity);
    playerEntity.setChangeParms();
  }

  PlayerPreThink(clientEdict) {
    const playerEntity = clientEdict.api;
    this._assertClientEntityIsPlayerEntity(playerEntity);
    playerEntity.playerPreThink();
  }

  PlayerPostThink(clientEdict) {
    const playerEntity = clientEdict.api;
    this._assertClientEntityIsPlayerEntity(playerEntity);
    playerEntity.playerPostThink();
  }

  ClientConnect(clientEdict) {
    const playerEntity = clientEdict.api;
    this._assertClientEntityIsPlayerEntity(playerEntity);

    this.engine.BroadcastPrint(`${playerEntity.netname} entered the game\n`);

    // a client connecting during an intermission can cause problems
    if (this.intermissionRunning) {
      // TODO: ExitIntermission()
    }
  }

  ClientDisconnect(clientEdict) {
    const playerEntity = clientEdict.api;
    this._assertClientEntityIsPlayerEntity(playerEntity);

    // TODO
  }

  PutClientInServer(clientEdict) {
    const playerEntity = clientEdict.api;
    this._assertClientEntityIsPlayerEntity(playerEntity);
    playerEntity.putPlayerInServer();
  }

  /**
   * simply optimizes the entityRegister into a map for more efficient access
   */
  _loadEntityRegistry() {
    this._entityRegistry = new Map();

    for (const entityClass of entityRegistry) {
      this._entityRegistry.set(entityClass.classname, entityClass);
    }
  }

  prepareEntity(edict, classname, initialData = {}) {
    if (!this._entityRegistry.has(classname)) {
      this.engine.ConsolePrint(`ServerGameAPI.prepareEntity: no entity factory for ${classname}!\n`);
      return false;
    }

    const entityClass = this._entityRegistry.get(classname);
    const entity = edict.api?.classname === classname ? edict.api : new entityClass(edict, this);

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
