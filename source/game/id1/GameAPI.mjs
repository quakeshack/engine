
import { GibEntity, InfoPlayerStart, InfoPlayerStartCoop, InfoPlayerStartDeathmatch, PlayerEntity, qc as playerModelQC, TelefragTriggerEntity } from './entity/Player.mjs';
import { BodyqueEntity, WorldspawnEntity } from './entity/Worldspawn.mjs';
import { items, spawnflags } from './Defs.mjs';
import * as misc from './entity/Misc.mjs';
import * as door from './entity/props/Doors.mjs';
import * as platform from './entity/props/Platforms.mjs';
import * as trigger from './entity/Triggers.mjs';
import { ArmySoldierMonster, ArmyEnforcerMonster, qc as soldierModelQCs } from './entity/monster/Soldier.mjs';
import { GameAI } from './helper/AI.mjs';
import * as sub from './entity/Subs.mjs';
import { ButtonEntity } from './entity/props/Buttons.mjs';
import * as item from './entity/Items.mjs';
import BaseEntity from './entity/BaseEntity.mjs';
import * as weapon from './entity/Weapons.mjs';
import DogMonsterEntity, { qc as dogModelQC } from './entity/monster/Dog.mjs';
import { Serializer } from './helper/MiscHelpers.mjs';
import DemonMonster, { qc as demonModelQC } from './entity/monster/Demon.mjs';
import { MeatSprayEntity } from './entity/monster/BaseMonster.mjs';
import ZombieMonster, { ZombieGibGrenade, qc as zombieModelQC } from './entity/monster/Zombie.mjs';
import { KnightMonster, HellKnightMonster, qc as knightModelQCs, KnightSpike } from './entity/monster/Knights.mjs';
import OgreMonsterEntity, { qc as ogreModelQC } from './entity/monster/Ogre.mjs';
import ShalrathMonsterEntity, { ShalrathMissileEntity, qc as shalrathModelQC } from './entity/monster/Shalrath.mjs';
import ShamblerMonsterEntity, { qc as shamblerModelQC } from './entity/monster/Shambler.mjs';
import TarbabyMonsterEntity, { qc as tbabyModelQC } from './entity/monster/Tarbaby.mjs';

/** @typedef {typeof import("../../engine/common/GameAPIs.mjs").ServerEngineAPI} ServerEngineAPI */
/** @typedef {import("../../engine/common/Cvar.mjs").default} Cvar */

const featureFlags = [
  'correct-ballistic-grenades', // enables zombie gib and ogre grenade trajectory fix
];

// put all entity classes here:
const entityRegistry = [
  WorldspawnEntity,
  BodyqueEntity,
  PlayerEntity,

  misc.NullEntity,
  misc.InfoNotNullEntity,
  misc.IntermissionCameraEntity,

  InfoPlayerStart,
  InfoPlayerStartCoop,
  InfoPlayerStartDeathmatch,
  GibEntity,
  MeatSprayEntity,

  weapon.Missile,
  weapon.Spike,
  weapon.Superspike,
  weapon.Grenade,
  weapon.Laser,

  misc.ViewthingEntity,
  misc.DebugMarkerEntity,

  misc.LightEntity,
  misc.LightFluorosparkEntity,
  misc.LightFluoroEntity,
  misc.SmallWalltorchLightEntity,
  misc.YellowLargeFlameLightEntity,
  misc.YellowSmallFlameLightEntity,
  misc.WhiteSmallFlameLightEntity,
  misc.LightGlobeEntity,
  misc.LightGlobeDynamicEntity,

  misc.FireballSpawnerEntity,
  misc.FireballEntity,

  misc.AmbientCompHum,
  misc.AmbientDrone,
  misc.AmbientSuckWind,
  misc.AmbientFlouroBuzz,
  misc.AmbientDrip,
  misc.AmbientThunder,
  misc.AmbientLightBuzz,
  misc.AmbientSwamp1,
  misc.AmbientSwamp2,

  misc.WallEntity,
  misc.IllusionaryWallEntity,
  misc.EpisodegateWallEntity,
  misc.BossgateWallEntity,

  misc.PathCornerEntity,

  misc.TeleportEffectEntity,
  misc.BubbleEntity,
  misc.BubbleSpawnerEntity,
  misc.StaticBubbleSpawnerEntity,

  misc.BarrelEntity,
  misc.SmallBarrelEntity,

  misc.TrapShooterEntity,
  misc.TrapSpikeshooterEntity,

  trigger.MultipleTriggerEntity,
  trigger.InfoTeleportDestination,
  trigger.TeleportTriggerEntity,
  trigger.SecretTriggerEntity,
  trigger.OnceTriggerEntity,
  trigger.RelayTriggerEntity,
  trigger.CountTriggerEntity,
  trigger.OnlyRegisteredTriggerEntity,
  trigger.SetSkillTriggerEntity,
  trigger.ChangeLevelTriggerEntity,
  trigger.TriggerHurtEntity,
  trigger.TriggerPushEntity,
  trigger.TriggerMonsterjumpEntity,

  TelefragTriggerEntity,

  ArmySoldierMonster,
  ArmyEnforcerMonster,
  DogMonsterEntity,
  DemonMonster,
  ZombieMonster,
  ZombieGibGrenade,
  KnightMonster,
  HellKnightMonster,
  KnightSpike,
  OgreMonsterEntity,
  ShalrathMonsterEntity,
  ShalrathMissileEntity,
  ArmyEnforcerMonster,
  ShamblerMonsterEntity,
  TarbabyMonsterEntity,

  door.DoorEntity,
  door.SecretDoorEntity,

  platform.PlatformEntity,
  platform.PlatformTriggerEntity,
  platform.TrainEntity,
  platform.TeleportTrainEntity,

  ButtonEntity,

  sub.TriggerFieldEntity,
  sub.DelayedThinkEntity,

  item.BackpackEntity,
  item.ItemShellsEntity,
  item.ItemSpikesEntity,
  item.ItemRocketsEntity,
  item.ItemCellsEntity,

  item.GoldKeyEntity,
  item.SilverKeyEntity,

  item.InvisibilityEntity,
  item.InvulnerabilityEntity,
  item.RadsuitEntity,
  item.SuperDamageEntity,

  item.SigilEntity,

  item.HealthItemEntity,
  item.HeavyArmorEntity,
  item.LightArmorEntity,
  item.StrongArmorEntity,

  item.WeaponSuperShotgun,
  item.WeaponGrenadeLauncher,
  item.WeaponNailgun,
  item.WeaponSuperNailgun,
  item.WeaponRocketLauncher,
  item.WeaponThunderbolt,
];

/**
 * Cvar cache
 * @type {{[key: string]: Cvar}}
 */
const cvars = {
  nomonster: null,
};

export class ServerGameAPI {
  /**
   * Invoked by spawning a server or a changelevel. It will initialize the global game state.
   * @param {ServerEngineAPI} engineAPI engine exports
   */
  constructor(engineAPI) {
    this._serializer = new Serializer(this, engineAPI);

    this._loadEntityRegistry();

    /** @type {ServerEngineAPI} */
    this.engine = engineAPI;

    this._serializer.startFields();

    this.mapname = null; // Engine API

    this.force_retouch = 0; // Engine API

    // stats
    this.total_monsters = 0;
    this.killed_monsters = 0;
    this.total_secrets = 0;
    this.found_secrets = 0;

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
    this.parm16 = 0;

    this.serverflags = 0;

    this.time = 0;
    this.framecount = 0;
    this.frametime = 0;

    /** @type {?BaseEntity} QuakeC: world */
    this.worldspawn = null;

    /** @type {?BaseEntity} the last selected spawn point, used for cycling spawn spots */
    this.lastspawn = null;

    // game state related
    this.gameover = false;
    /** @type {number} intermission state (0 = off) */
    this.intermission_running = 0;
    /** @type {number} time when intermission is over */
    this.intermission_exittime = 0.0;
    /** @type {?string} next map name */
    this.nextmap = null;

    this._serializer.endFields();

    this.gameAI = new GameAI(this);

    /** @type {?BaseEntity} holds the dead player body chain */
    this.bodyque_head = null;

    this._modelData = { // FIXME: I’m not happy about this, this needs to be next to models
      'progs/soldier.mdl': engineAPI.ParseQC(soldierModelQCs.solider),
      'progs/enforcer.mdl': engineAPI.ParseQC(soldierModelQCs.enforcer),
      'progs/player.mdl': engineAPI.ParseQC(playerModelQC),
      'progs/dog.mdl': engineAPI.ParseQC(dogModelQC),
      'progs/demon.mdl': engineAPI.ParseQC(demonModelQC),
      'progs/zombie.mdl': engineAPI.ParseQC(zombieModelQC),
      'progs/knight.mdl': engineAPI.ParseQC(knightModelQCs.knight),
      'progs/hknight.mdl': engineAPI.ParseQC(knightModelQCs.hellKnight),
      'progs/ogre.mdl': engineAPI.ParseQC(ogreModelQC),
      'progs/shalrath.mdl': engineAPI.ParseQC(shalrathModelQC),
      'progs/shambler.mdl': engineAPI.ParseQC(shamblerModelQC),
      'progs/tarbaby.mdl': engineAPI.ParseQC(tbabyModelQC),
    };

    /** @private */
    this._missingEntityClassStats = {};

    // FIXME: I’m not happy about this structure, especially with the getters down below
    /** cvar cache @type {{[key: string]: Cvar}} @private */
    this._cvars = {
      skill: engineAPI.GetCvar('skill'),
      teamplay: engineAPI.GetCvar('teamplay'),
      registered: engineAPI.GetCvar('registered'),
      timelimit: engineAPI.GetCvar('timelimit'),
      fraglimit: engineAPI.GetCvar('fraglimit'),
      deathmatch: engineAPI.GetCvar('deathmatch'),
      coop: engineAPI.GetCvar('coop'),
      samelevel: engineAPI.GetCvar('samelevel'),
      noexit: engineAPI.GetCvar('noexit'),
      gravity: engineAPI.GetCvar('sv_gravity'),
    };

    Object.seal(this._modelData);
    Object.seal(this._cvars);
    Object.seal(this);
  }

  get skill() {
    return this._cvars.skill.value;
  }

  get teamplay() {
    return this._cvars.teamplay.value;
  }

  get registered() {
    return this._cvars.registered.value;
  }

  get timelimit() {
    return this._cvars.timelimit.value;
  }

  get fraglimit() {
    return this._cvars.fraglimit.value;
  }

  get deathmatch() {
    return this._cvars.deathmatch.value;
  }

  get coop() {
    return this._cvars.coop.value;
  }

  get samelevel() {
    return this._cvars.samelevel.value;
  }

  get noexit() {
    return this._cvars.noexit.value;
  }

  get nomonsters() {
    return cvars.nomonster.value;
  }

  get gravity() {
    return this._cvars.gravity.value;
  }

  hasFeature(feature) {
    return featureFlags.includes(feature);
  }

  StartFrame() {
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

  /**
   * Restore the original spawn parameters of a client entity. Doesn’t work if client is not a player.
   * @param {PlayerEntity} clientEntity client
   */
  SetSpawnParms(clientEntity) {
    const spawnParams = clientEntity.edict.getClient().spawn_parms;

    for (let i = 0; i < spawnParams.length; i++) {
      console.assert(`parm${i + 1}` in this);
      this[`parm${i + 1}`] = spawnParams[i];
    }
  }

  /**
   * @param {BaseEntity|PlayerEntity} clientEntity client entity
   * @private
   */
  _assertClientEntityIsPlayerEntity(clientEntity) {
    if (!(clientEntity instanceof PlayerEntity)) {
      throw new Error('clientEdict must carry a PlayerEntity!');
    }
  }

  SetChangeParms(clientEdict) {
    const playerEntity = clientEdict.entity;
    this._assertClientEntityIsPlayerEntity(playerEntity);
    playerEntity.setChangeParms();
  }

  PlayerPreThink(clientEdict) {
    const playerEntity = clientEdict.entity;
    this._assertClientEntityIsPlayerEntity(playerEntity);
    playerEntity.playerPreThink();
  }

  PlayerPostThink(clientEdict) {
    const playerEntity = clientEdict.entity;
    this._assertClientEntityIsPlayerEntity(playerEntity);
    playerEntity.playerPostThink();
  }

  ClientConnect(clientEdict) {
    const playerEntity = clientEdict.entity;
    this._assertClientEntityIsPlayerEntity(playerEntity);
    playerEntity.connected();
  }

  ClientDisconnect(clientEdict) {
    const playerEntity = clientEdict.entity;
    this._assertClientEntityIsPlayerEntity(playerEntity);
    playerEntity.disconnected();
  }

  ClientKill(clientEdict) {
    const playerEntity = clientEdict.entity;
    this._assertClientEntityIsPlayerEntity(playerEntity);
    playerEntity.suicide();
  }

  PutClientInServer(clientEdict) {
    const playerEntity = clientEdict.entity;
    this._assertClientEntityIsPlayerEntity(playerEntity);
    playerEntity.putPlayerInServer();
  }

  /**
   * Exit deathmatch games upon conditions.
   * @param {PlayerEntity} playerEntity player
   */
  checkRules(playerEntity) {
    if (this.gameover) {
      return; // someone else quit the game already
    }

    if (this.timelimit > 0 && this.time >= this.timelimit * 60) {
      this.gameover = true;
      this.engine.BroadcastPrint('Timelimit reached.\n');
      this.loadNextMap();
      return;
    }

    if (this.fraglimit > 0 && playerEntity.frags > this.fraglimit) {
      this.gameover = true;
      this.engine.BroadcastPrint(`${playerEntity.netname} triggered the fraglimit.\n`);
      this.loadNextMap();
      return;
    }
  }

  /**
   * Will load next map.
   * @param {?string} nextmap next map (default: this.nextmap)
   */
  loadNextMap(nextmap = this.nextmap) {
    if (!nextmap || this.samelevel) {
      this.engine.ChangeLevel(this.mapname);
      return;
    }

    this.engine.ChangeLevel(nextmap);
  }

  /**
   * @param {PlayerEntity} playerEntity player
   */
  sendMissingEntitiesToPlayer(playerEntity) {
    const stats = Object.entries(this._missingEntityClassStats);
    if (stats.length > 0) {
      stats.sort(([, a], [, b]) => b - a);
      playerEntity.consolePrint('Unknown entity classes on this map:\n');
      for (const [name, cnt] of stats) {
        playerEntity.consolePrint(`${new Number(cnt).toFixed(0).padStart(4, ' ')}x ${name}\n`);
      }
    }
  }

  startIntermission() {
    if (this.intermission_running) {
      return;
    }

    this.intermission_running = 1;
    this.intermission_exittime = this.time + (this.deathmatch ? 5.0 : 2.0); // 5s for dm games

    this.engine.PlayTrack(3, 3);

    for (const player of this.engine.FindAllByFieldAndValue('classname', PlayerEntity.classname)) {
      /** @type {PlayerEntity} */
      const playerEntity = player.entity;
      playerEntity.startIntermission();
    }

    this.engine.EnterIntermission();
  }

  /**
   * simply optimizes the entityRegister into a map for more efficient access
   * @private
   */
  _loadEntityRegistry() {
    /** @private */
    this._entityRegistry = new Map();

    for (const entityClass of entityRegistry) {
      this._entityRegistry.set(entityClass.classname, entityClass);
    }
  }

  prepareEntity(edict, classname, initialData = {}) {
    if (!this._entityRegistry.has(classname)) {
      this.engine.ConsoleWarning(`ServerGameAPI.prepareEntity: no entity factory for ${classname}!\n`);

      this._missingEntityClassStats[classname] = (this._missingEntityClassStats[classname] || 0) + 1;
      return false;
    }

    // spawnflags (control whether to spawn an entity or not)
    {
      const sflags = initialData.spawnflags || 0;

      if (this.deathmatch && (sflags & spawnflags.SPAWNFLAG_NOT_DEATHMATCH)) { // no spawn in deathmatch
        return false;
      }

      if (this.skill === 0 && (sflags & spawnflags.SPAWNFLAG_NOT_EASY)) {
        return false;
      }

      if (this.skill === 1 && (sflags & spawnflags.SPAWNFLAG_NOT_MEDIUM)) {
        return false;
      }

      if (this.skill >= 2 && (sflags & spawnflags.SPAWNFLAG_NOT_HARD)) {
        return false;
      }
    }

    const entityClass = this._entityRegistry.get(classname);
    const entity = edict.entity?.classname === classname ? edict.entity : new entityClass(edict, this);

    entity.assignInitialData(initialData);

    return true;
  }

  spawnPreparedEntity(edict) {
    if (!edict.entity) {
      this.engine.ConsoleError('ServerGameAPI.prepareEntity: no entity class instance set!\n');
      return false;
    }

    edict.entity.spawn();

    return true;
  }

  init(mapname, serverflags) {
    this.mapname = mapname;
    this.serverflags = serverflags;
  }

  // eslint-disable-next-line no-unused-vars
  shutdown(isCrashShutdown) {
  }

  /** @param {ServerEngineAPI} ServerEngineAPI */
  static Init(ServerEngineAPI) {
    cvars.nomonster = ServerEngineAPI.RegisterCvar('nomonster', '0', /* Cvar.FLAG.DEFERRED */ 0, 'Do not spawn monsters.');
  }

  static Shutdown() {
    cvars.nomonster.free();
  }

  serialize() {
    return this._serializer.serialize();
  }

  deserialize(data) {
    this._serializer.deserialize(data);
  }
};
