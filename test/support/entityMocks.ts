import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import type { GameTrace } from '../../source/engine/common/GameApiSupport.ts';
import type { ServerEdict } from '../../source/engine/server/Edict.ts';
import type { ServerGameAPI } from '../../source/game/id1/GameAPI.ts';
import type { clientEvent } from '../../source/game/id1/Defs.ts';
import type { EntityAI } from '../../source/game/id1/helper/AI.ts';
import type BaseEntity from '../../source/game/id1/entity/BaseEntity.ts';
import type { Sub } from '../../source/game/id1/entity/Subs.ts';

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
    FindInRadius() {
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

/** The engine API of a game with its members writable, for a test that replaces one after the entity was built. */
export type MutableEngineApi = { -readonly [Name in keyof ServerGameAPI['engine']]: ServerGameAPI['engine'][Name] };

/** An entity whose engine API has writable members, for a test that replaces one after the entity was built. */
export type WithMutableEngine<T extends BaseEntity> = T & { engine: MutableEngineApi };

/**
 * The engine API of a game, like {@link createInertEngineApi}, with members a test may replace later.
 * @param overrides Operations a test wants to answer, or to record, itself.
 * @returns The engine API.
 */
export function createMutableEngineApi(overrides: object = {}): MutableEngineApi {
  return createInertEngineApi(overrides);
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

/**
 * A trace as a game sees it: by default a line that went all the way in the open and hit nothing.
 * @param overrides What a test says about the trace, such as `fraction` or `entity`.
 * @returns The trace.
 */
export function createGameTrace(overrides: Partial<GameTrace> = {}): GameTrace {
  return {
    solid: { all: false, start: false },
    fraction: 1.0,
    plane: { normal: new Vector(0, 0, 1), distance: 0 },
    contents: { inOpen: true, inWater: false },
    point: new Vector(),
    entity: null,
    ...overrides,
  };
}

/**
 * The movement helper of an entity (`Sub`), with the members a test lists and the rest answering "nothing happened".
 * @param members What the test records or answers itself, such as `calcMove`.
 * @returns The helper, typed as the real one.
 */
export function createSubStub(members: Partial<Pick<Sub, 'calcMove' | 'setMovedir' | 'useTargets' | 'reset'>> = {}): Sub {
  // A real Sub wraps an entity and a serializer; the entities under test call only these members.
  return {
    calcMove() {},
    setMovedir() {},
    useTargets() {},
    reset() {},
    ...members,
  } as unknown as Sub;
}

/** A call a movement helper stand-in recorded for `calcMove`. */
export interface CalcMoveCall {
  readonly target: Vector;
  readonly speed: number;
  readonly callback: Parameters<Sub['calcMove']>[2];
}

/**
 * Finish the move an entity asked its movement helper for, by running the callback it gave.
 * @param call The recorded `calcMove` call.
 * @param entity The entity that asked for the move, which the callback runs as.
 */
export function finishMove(call: CalcMoveCall | undefined, entity: BaseEntity): void {
  assert.ok(call?.callback, 'calcMove was given a callback');
  call.callback.call(entity);
}

/** A client event the game asked the engine to broadcast or dispatch. */
export interface RecordedClientEvent {
  readonly expedited: boolean;
  readonly eventCode: clientEvent;
  readonly args: readonly unknown[];
}

/**
 * An engine API that records every client event broadcast through it.
 * @returns The engine API and the events it was asked to broadcast, in order.
 */
export function createBroadcastRecorder(): { engine: ServerGameAPI['engine']; events: RecordedClientEvent[] } {
  const events: RecordedClientEvent[] = [];
  const engine = createInertEngineApi({
    BroadcastClientEvent(expedited: boolean, eventCode: number, ...args: unknown[]): void {
      events.push({ expedited, eventCode: eventCode as clientEvent, args });
    },
  });

  return { engine, events };
}

/** A class of entities that is built around an edict and a game, as the tests of monsters and props do. */
export type EntityConstructor<T extends BaseEntity = BaseEntity> = new (edict: ServerEdict | null, gameAPI: ServerGameAPI) => T;

/**
 * An entity that has just the members a test lists, for the entities a method under test only reads (an enemy, a target).
 * @param members What the code under test reads from the entity, such as `origin`.
 * @returns The stand-in, typed as the entity class the method takes.
 */
export function createEntityStub<T extends BaseEntity = BaseEntity>(members: object): T {
  // A real entity needs an edict and a game; the methods under test read a few members of it.
  return members as unknown as T;
}

/**
 * The AI of a monster with just the members a test lists, for the monster methods that only read what the AI knows.
 * @param members What the code under test reads or calls, such as `foundTarget`.
 * @returns The stand-in, typed as the AI a monster holds.
 */
export function createAiStub(members: object): EntityAI {
  // A real AI wraps its monster and a game-wide AI state; the methods under test touch a few of its members.
  return members as unknown as EntityAI;
}

/** An entity the game asked the engine to spawn. */
export interface SpawnRequest {
  readonly classname: string;
  readonly initialData: Record<string, unknown>;
}

/**
 * Make an engine API record every `SpawnEntity` call and answer with an entity, or that nothing was spawned.
 * @param engine The engine API the entity under test was built with.
 * @param spawned The entity every spawn answers with.
 * @returns The spawn requests, in order; it fills as the code under test runs.
 */
export function recordSpawns(engine: MutableEngineApi, spawned: BaseEntity | null = null): SpawnRequest[] {
  const requests: SpawnRequest[] = [];

  // The real SpawnEntity is generic in the entity it answers with; the recorder answers the one it was given.
  engine.SpawnEntity = ((classname: string, initialData: Record<string, unknown> = {}) => {
    requests.push({ classname, initialData });
    return { entity: spawned };
  }) as MutableEngineApi['SpawnEntity'];

  return requests;
}

/**
 * The game API a mod's entities are built with, for a mod that extends the game API of id1.
 * @param members What the code under test reads from the game besides its engine API.
 * @param engine The engine API the game has.
 * @returns The game API, typed as the mod's.
 */
export function createInertModGameApi<Game extends ServerGameAPI>(members: object = {}, engine: ServerGameAPI['engine'] = createInertEngineApi()): Game {
  // Same stand-in as createInertGameApi; the mod's game API is a subclass of the one of id1.
  return createInertGameApi(members, engine) as Game;
}
