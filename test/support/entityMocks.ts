import Vector from '../../source/shared/Vector.ts';
import type { ServerEdict } from '../../source/engine/server/Edict.ts';
import type { ServerGameAPI } from '../../source/game/id1/GameAPI.ts';

/**
 * The edict an entity of a game is built around, with every operation a prop entity may call answering "nothing happened".
 * The entity is attached by the test (`edict.entity = entity`).
 * @returns The edict.
 */
export function createInertEdict(): ServerEdict {
  // A real ServerEdict belongs to a server; the entities under test only call the members below.
  return {
    num: 1,
    entity: null,
    equals(other: unknown) {
      return this === other;
    },
    freeEdict() {},
    setOrigin() {},
    setModel() {},
    setMinMaxSize() {},
    walkMove() {
      return false;
    },
    changeYaw() {
      return 0;
    },
    dropToFloor() {
      return true;
    },
    isOnTheFloor() {
      return false;
    },
    makeStatic() {},
    aim() {
      return null;
    },
    getNextBestClient() {
      return null;
    },
  } as unknown as ServerEdict;
}

/**
 * An edict that, unlike {@link createInertEdict}, does what moving and sizing an entity does to the entity: it keeps the
 * origin, the bounds and the model of the attached entity up to date, for entities that read them back.
 * @param modelMins Mins an entity gets when it is given a model.
 * @param modelMaxs Maxs an entity gets when it is given a model.
 * @returns The edict.
 */
export function createBoundedEdict(modelMins = new Vector(-16, -16, -16), modelMaxs = new Vector(16, 16, 16)): ServerEdict {
  // A real ServerEdict belongs to a server; the entities under test only call the members below.
  const edict = {
    num: 1,
    entity: null,
    setOrigin(origin: Vector) {
      const entity = edict.entity!;
      entity.origin.set(origin);
      entity.absmin = origin.copy().add(entity.mins);
      entity.absmax = origin.copy().add(entity.maxs);
    },
    setModel(modelname: string | null) {
      const entity = edict.entity!;
      entity.model = modelname;
      entity.modelindex = modelname ? 1 : 0;
      entity.mins.set(modelMins);
      entity.maxs.set(modelMaxs);
      entity.size = modelMaxs.copy().subtract(modelMins);
      entity.absmin = entity.origin.copy().add(entity.mins);
      entity.absmax = entity.origin.copy().add(entity.maxs);
    },
    setMinMaxSize(mins: Vector, maxs: Vector) {
      const entity = edict.entity!;
      entity.mins.set(mins);
      entity.maxs.set(maxs);
      entity.size = maxs.copy().subtract(mins);
      entity.absmin = entity.origin.copy().add(entity.mins);
      entity.absmax = entity.origin.copy().add(entity.maxs);
    },
    equals(other: unknown) {
      return edict === other;
    },
    freeEdict() {},
    walkMove() {
      return false;
    },
    changeYaw() {
      return 0;
    },
    dropToFloor() {
      return true;
    },
    isOnTheFloor() {
      return false;
    },
    makeStatic() {},
    aim() {
      return new Vector();
    },
    getNextBestClient() {
      return null;
    },
  } as unknown as ServerEdict;

  return edict;
}

/**
 * The engine API of a game, with every operation answering "nothing happened".
 * @param overrides Operations a test wants to answer, or to record, itself.
 * @returns The engine API, typed as the one the game receives.
 */
export function createInertEngineApi(overrides: object = {}): ServerGameAPI['engine'] {
  // The game's engine API has far more members than a prop entity calls; the ones it may call are here.
  return {
    IsLoading() {
      return false;
    },
    PrecacheModel() {},
    PrecacheSound() {},
    StartSound() {},
    SpawnAmbientSound() {},
    SpawnEntity() {
      return { entity: null };
    },
    FindByFieldAndValue() {
      return null;
    },
    FindAllByFieldAndValue() {
      return [];
    },
    ParseQC() {
      return null;
    },
    Traceline() {
      return null;
    },
    SetAreaPortalState() {},
    GetCvar() {
      return { value: 0 };
    },
    ...overrides,
  } as unknown as ServerGameAPI['engine'];
}

/**
 * The game API an entity is built with.
 * @param members What the entity under test reads from the game besides its engine API, such as `worldspawn`.
 * @param engine The engine API the game has, {@link createInertEngineApi} unless a test brings its own.
 * @returns The game API, typed as the real one.
 */
export function createInertGameApi(members: object = {}, engine: ServerGameAPI['engine'] = createInertEngineApi()): ServerGameAPI {
  // The entities under test read `engine` and `time`, and a few members a test names.
  return { engine, time: 0, ...members } as unknown as ServerGameAPI;
}
