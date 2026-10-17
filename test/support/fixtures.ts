
import Vector from '../../source/shared/Vector.ts';
import { content, flags, moveType, solid } from '../../source/shared/Defs.ts';
import { Brush, BrushModel, BrushSide } from '../../source/engine/common/model/BSP.ts';
import { BaseModel, Plane } from '../../source/engine/common/model/BaseModel.ts';
import GameModule from '../../source/engine/common/GameModule.ts';
import type { Hull } from '../../source/engine/common/collision/Hull.ts';
import './consoleBridge.ts';
import { useClientStateOf } from './clientState.ts';
import { useHostOf } from './host.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import type { BaseEntity, ServerEdict } from '../../source/engine/server/Edict.ts';
import { CollisionTrace } from '../../source/engine/server/physics/ServerCollisionSupport.ts';
import { ServerPhysics } from '../../source/engine/server/physics/ServerPhysics.ts';
import Server from '../../source/engine/server/Server.ts';
import type { ServerDependencies } from '../../source/engine/server/ServerDependencies.ts';
import { ServerEngineAPI } from '../../source/engine/server/ServerEngineAPI.ts';
import ServerHost, { type ServerHostDependencies } from '../../source/engine/server/ServerHost.ts';
import type { NavigationServices } from '../../source/engine/server/Navigation.ts';
import type { CollisionModelSource } from '../../source/engine/common/CollisionModelSource.ts';
import type { ChannelEndpoint, ChannelMessage } from '../../source/engine/network/ChannelDriver.ts';
import NET from '../../source/engine/network/Network.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import type { URLs } from '../../source/engine/build-config';
import { Trace } from '../../source/engine/common/Pmove.ts';
import { engineMocks } from './engineMocks.ts';
import { createRoomHull } from './hulls.ts';
import { setBspTree } from './bspTree.ts';

// ── Mock shapes ─────────────────────────────────────────────────────────────

/** The members of the engine's entity interface that a mock entity has only when a test sets them. */
type OptionalEntityMembers = Partial<Pick<BaseEntity, 'classname' | 'deadflag' | 'frame' | 'gravity' | 'waterlevel' | 'watertype' | 'view_ofs' | 'v_angle' | 'oldorigin' | 'ideal_yaw' | 'yaw_speed' | 'teleport_time' | 'enemy' | 'goalentity'>>;

/** A minimal entity for server physics tests; tests add the members their scenario needs. */
export interface MockEntity extends OptionalEntityMembers {
  origin: Vector;
  mins: Vector;
  maxs: Vector;
  velocity: Vector;
  avelocity: Vector;
  angles: Vector;
  modelindex: number;
  movetype: number;
  solid: number;
  flags: number;
  groundentity: MockEntity | null;
  ltime: number;
  owner: MockEntity | null;
  blocked: ((blockingEntity: MockEntity) => void) | null;
  touch: ((other: MockEntity) => void) | null;
  think: () => void;
  nextthink: number;
  num: number;
  size: Vector;
  absmin: Vector;
  absmax: Vector;
  equals: (other: unknown) => boolean;
  /** Fields the engine's entity interface does not have, which a test sets for the code under test to read. */
  spawnflags?: number;
  button0?: boolean;
  button1?: boolean;
  button2?: boolean;
  impulse?: number;
}

/**
 * A server edict around a {@link MockEntity}. It is typed as the real thing because the code under test takes a
 * `ServerEdict`; {@link createMockEdict} is the one place that makes the mock pass for it.
 */
export type MockEdict<Entity extends object = MockEntity> = ServerEdict & { entity: Entity };

/** The server state a test sets up; `defaultMockEngine` completes `frametime`. */
export interface MockServerState {
  frametime?: number;
  active?: boolean;
  [member: string]: unknown;
}

/** Every member optional all the way down, so a test mocks just the parts the code under test reads. Methods keep their signature. */
export type DeepPartial<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly unknown[] ? T
    : T extends Vector ? T
      : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> }
        : T;

/**
 * What a test mocks of the server (`engineMocks.SV`): the members of a `Server` it has, with the parts it does not need
 * left out, and any other member the test needs is added as it goes.
 */
export type MockServer = DeepPartial<Server> & { [member: string]: unknown };

/** What a test mocks of the client (`engineMocks.CL`); the members that `withMockEngine` itself reads are typed. */
export interface MockClient {
  serverController?: { state?: { active?: boolean } };
  cls?: { state?: number; serverInfo?: { sv_cheats?: string } };
  [member: string]: unknown;
}

/** The console of a mock engine: silent unless the test brings its own. */
export interface MockConsole {
  Print: (...args: never[]) => void;
  DPrint: (...args: never[]) => void;
  PrintWarning?: (...args: never[]) => void;
  PrintError?: (...args: never[]) => void;
  PrintSuccess?: (...args: never[]) => void;
}

/** The engine parts `withMockEngine` installs for the duration of a callback. */
export interface MockEngineConfig {
  /** The page's `COM`; left alone when omitted. */
  COM?: object | null;
  CL?: MockClient | null;
  Con: MockConsole;
  Host: { frametime: number; [member: string]: unknown };
  /** The server; a test of a client with a server in a worker has none. */
  SV?: MockServer;
}

/** One call of a mocked `collision.move`: where it was asked to sweep from and to. */
export interface RecordedMove {
  start: Vector;
  mins?: Vector;
  maxs?: Vector;
  end: Vector;
  type: number;
  passedict: ServerEdict | null;
}

/** What `withMockServerPhysics` hands to its callback. */
export interface MockServerPhysicsContext {
  serverPhysics: ServerPhysics;
  pusherEdict: MockEdict;
  riderEdict: MockEdict;
  linkCalls: MockEdict[];
  moveCalls: Array<{ start: Vector; mins: Vector; maxs: Vector; end: Vector }>;
  testCalls: MockEdict[];
  blockedCalls: MockEntity[];
}

/** A brush model whose brushes and brush sides exist, as the fixtures build them. */
export type BrushModelWithBrushes = BrushModel & { brushsides: BrushSide[]; brushes: Brush[] };

/** Options of {@link createBoxBrushModel}. */
export interface BoxBrushModelOptions {
  center?: number[];
  halfExtents: number[];
  name?: string;
  submodel?: boolean;
}

/** Options of {@link createBrushWorldModel}. */
export interface BrushWorldModelOptions {
  axis?: 0 | 1 | 2;
  center?: number[];
  halfExtents: number[];
}

/** Options of {@link createPmoveBoxEntity}. */
export interface PmoveBoxEntityOptions {
  origin: Vector;
  mins: Vector;
  maxs: Vector;
  num?: number;
}

/** Options of {@link createMockEntity}. */
export interface MockEntityOptions {
  origin?: Vector;
  mins?: Vector;
  maxs?: Vector;
  velocity?: Vector;
  avelocity?: Vector;
  angles?: Vector;
  modelindex?: number;
  movetype?: number;
  solidType?: number;
  flagsValue?: number;
  groundentity?: MockEntity | null;
  num?: number;
}

/** What {@link createTestServerHost} builds and records. */
export interface TestServerHost {
  sv: Server;
  serverHost: ServerHost;
  /** Callbacks the host scheduled for the next frame. */
  scheduled: Array<() => void | Promise<void>>;
  /** The values the host passed to `setNoclipAnglehack`, in order. */
  noclip: boolean[];
}

/** Options of {@link createTestNetwork}. */
export interface TestNetworkOptions {
  dedicated?: boolean;
  urls?: URLs;
  mapname?: string;
  maxPlayers?: number;
  game?: string;
}

/** The observable fields of a player movement trace; the ones left out are a clear, unobstructed trace. */
export interface PmoveTraceOptions {
  endpos: Vector;
  fraction?: number;
  normal?: Vector;
  dist?: number;
  ent?: number | null;
  allsolid?: boolean;
  startsolid?: boolean;
  inopen?: boolean;
  inwater?: boolean;
}

/**
 * Build a player movement trace with the requested observable fields.
 * @param options The trace options.
 * @returns The trace.
 */
export function createPmoveTrace({
  endpos,
  fraction = 1.0,
  normal = new Vector(),
  dist = 0.0,
  ent = null,
  allsolid = false,
  startsolid = false,
  inopen = false,
  inwater = false,
}: PmoveTraceOptions): Trace {
  const trace = new Trace();
  trace.endpos.set(endpos);
  trace.fraction = fraction;
  trace.allsolid = allsolid;
  trace.startsolid = startsolid;
  trace.ent = ent;
  trace.plane.normal.set(normal);
  trace.plane.dist = dist;
  trace.inopen = inopen;
  trace.inwater = inwater;
  return trace;
}

// ── Plane & Model Fixtures ─────────────────────────────────────────────────

/**
 * Build a minimal axis plane for brush collision fixtures.
 * @param normalComponents Plane normal components.
 * @param dist Plane distance from origin.
 * @param type Axial plane type.
 * @returns The plane fixture.
 */
export function createAxisPlane(normalComponents: number[], dist: number, type: number): Plane {
  const plane = new Plane(new Vector(...normalComponents), dist);
  plane.type = type;
  return plane;
}

/**
 * Build a minimal solid box brush model for trace and position tests.
 * @param options Fixture options.
 * @returns The brush model fixture.
 */
export function createBoxBrushModel({ center = [0, 0, 0], halfExtents, name = '*test', submodel = true }: BoxBrushModelOptions): BrushModelWithBrushes {
  const model = new BrushModel(name);
  model.submodel = submodel;
  model.firstBrush = 0;
  model.numBrushes = 1;
  model.leafbrushes = [];
  model.hulls = [];

  const [centerX, centerY, centerZ] = center;

  model.planes = [
    createAxisPlane([1, 0, 0], centerX + halfExtents[0], 0),
    createAxisPlane([-1, 0, 0], halfExtents[0] - centerX, 0),
    createAxisPlane([0, 1, 0], centerY + halfExtents[1], 1),
    createAxisPlane([0, -1, 0], halfExtents[1] - centerY, 1),
    createAxisPlane([0, 0, 1], centerZ + halfExtents[2], 2),
    createAxisPlane([0, 0, -1], halfExtents[2] - centerZ, 2),
  ];

  model.brushsides = model.planes.map((_plane, index) => {
    const side = new BrushSide(model);
    side.planenum = index;
    side.texinfo = 0;
    return side;
  });

  const brush = new Brush(model);
  brush.firstside = 0;
  brush.numsides = 6;
  brush.contents = content.CONTENT_SOLID;
  brush.mins = new Vector(centerX - halfExtents[0], centerY - halfExtents[1], centerZ - halfExtents[2]);
  brush.maxs = new Vector(centerX + halfExtents[0], centerY + halfExtents[1], centerZ + halfExtents[2]);
  brush._brushTraceCheck = 0;
  model.brushes = [brush];

  // Both lists were assigned above; the property types still allow null.
  return model as BrushModelWithBrushes;
}

/**
 * Build a room hull whose interior is empty and whose exterior is solid.
 * @param mins Room mins.
 * @param maxs Room maxs.
 * @returns The model hull fixture.
 */
export function createRoomHullFromBounds(mins: Vector, maxs: Vector): Hull {
  return createRoomHull(mins, maxs);
}

/**
 * Build a minimal brush-list world model that traverses a BSP node and leaf brushes.
 * @param options Fixture options.
 * @returns The world brush model fixture.
 */
export function createBrushWorldModel({ axis = 0, center = [64, 0, 0], halfExtents }: BrushWorldModelOptions): BrushModelWithBrushes {
  const model = createBoxBrushModel({ center, halfExtents, name: 'test-brush-world', submodel: false });
  const axisNormal = [0, 0, 0];
  axisNormal[axis] = 1;
  const roomMins = new Vector(-2048, -2048, -2048);
  const roomMaxs = new Vector(2048, 2048, 2048);
  model.planes.push(createAxisPlane(axisNormal, 0, axis));
  setBspTree(
    model,
    [{ planeNum: model.planes.length - 1, children: [~0, ~1] }],
    [
      { contents: content.CONTENT_EMPTY, firstLeafBrush: 0, numLeafBrushes: 1 },
      { contents: content.CONTENT_EMPTY, firstLeafBrush: 1, numLeafBrushes: 0 },
    ],
  );
  model.leafbrushes = [0];
  model.hulls = [
    createRoomHullFromBounds(roomMins, roomMaxs),
    createRoomHullFromBounds(roomMins, roomMaxs),
    createRoomHullFromBounds(roomMins, roomMaxs),
  ];

  return model;
}

/**
 * Build a legacy hull-only world model for Pmove smoke tests.
 * @param mins Room mins.
 * @param maxs Room maxs.
 * @returns The world model fixture.
 */
export function createLegacyWorldModel(mins: Vector, maxs: Vector): BrushModel {
  const model = new BrushModel('test-world');
  model.hulls = [
    createRoomHullFromBounds(mins, maxs),
    createRoomHullFromBounds(mins, maxs),
    createRoomHullFromBounds(mins, maxs),
  ];

  return model;
}

/**
 * Build a model that has nothing but its bounds, for entities a test only needs to give a size.
 * @param mins The mins of the model.
 * @param maxs The maxs of the model.
 * @param name The name of the model.
 * @returns The model.
 */
export function createBoundsModel(mins: Vector, maxs: Vector, name = 'test-bounds'): BaseModel {
  const model = new BaseModel(name);
  model.mins = mins;
  model.maxs = maxs;
  return model;
}

/**
 * Build the game module a test makes active, with the game APIs it brings.
 * @param members The server and client game APIs of the module, as stand-ins with the members the code under test calls.
 * @returns The module, typed as the real thing.
 */
export function createGameModuleStub(members: { ServerGameAPI?: object; ClientGameAPI?: object }): typeof GameModule.active {
  // The engine calls just a few members of a game's APIs; the stand-ins have those.
  return {
    identification: { name: 'Test Game', author: 'test', version: [1, 0, 0], capabilities: [] },
    ServerGameAPI: null,
    ClientGameAPI: null,
    ...members,
  } as unknown as typeof GameModule.active;
}

// ── Entity Fixtures ─────────────────────────────────────────────────────────

/**
 * Build a minimal boxed entity fixture for Pmove physents.
 * @param options Entity options.
 * @returns The pmove entity fixture.
 */
export function createPmoveBoxEntity({ origin, mins, maxs, num = 0 }: PmoveBoxEntityOptions): ClientEdict {
  const entity = new ClientEdict(num);
  entity.origin.set(origin);
  entity.mins.set(mins);
  entity.maxs.set(maxs);
  entity.angles.clear();
  return entity;
}

/**
 * Create a minimal entity object for server physics tests.
 * @param options Entity options.
 * @returns The mock entity.
 */
export function createMockEntity({
  origin = new Vector(),
  mins = new Vector(),
  maxs = new Vector(),
  velocity = new Vector(),
  avelocity = new Vector(),
  angles = new Vector(),
  modelindex = 0,
  movetype = moveType.MOVETYPE_NONE,
  solidType = solid.SOLID_NOT,
  flagsValue = 0,
  groundentity = null,
  num = 0,
}: MockEntityOptions = {}): MockEntity {
  return {
    origin,
    mins,
    maxs,
    velocity,
    avelocity,
    angles,
    modelindex,
    movetype,
    solid: solidType,
    flags: flagsValue,
    groundentity,
    ltime: 0,
    owner: null,
    blocked: null,
    touch: null,
    think() {},
    nextthink: 0,
    num,
    size: maxs.copy().subtract(mins),
    absmin: origin.copy().add(mins),
    absmax: origin.copy().add(maxs),
    equals(other) {
      return this === other;
    },
  };
}

/**
 * Create a minimal server edict wrapper.
 * @param entity The underlying entity, usually a {@link MockEntity}.
 * @param num The edict number; the entity's own when it has one.
 * @returns The mock edict.
 */
export function createMockEdict<Entity extends object = MockEntity>(entity: Entity, num = (entity as { num?: number }).num ?? 0): MockEdict<Entity> {
  // The mock has the few members the code under test reads; a real ServerEdict needs a whole server to be built.
  return {
    entity,
    num,
    isFree() {
      return false;
    },
    isClient() {
      return false;
    },
    equals(other: unknown) {
      return this === other;
    },
  } as unknown as MockEdict<Entity>;
}

// ── Mock Engine Helpers ─────────────────────────────────────────────────────

/**
 * Build a default mock engine config with silent console and a standard server frametime.
 * Supply SV overrides to configure server-side mocks.
 * @param sv SV overrides; completed in place, because tests keep a reference to what they pass in.
 * @param cl The mocked client, if the test has one.
 * @returns The engine config.
 */
export function defaultMockEngine(sv: MockServer = {}, cl: MockClient | null = null): MockEngineConfig {
  sv.server ??= {};
  sv.server.frametime ??= 0.1;

  return {
    CL: cl,
    Con: { Print() {}, DPrint() {} },
    Host: { frametime: 0.1 },
    SV: sv,
  };
}

/**
 * Run a callback with mocked engine parts. The shared console prints to the mocked `Con` (see
 * `test/support/consoleBridge.ts`) and the cvars' cheat rule asks the mocked `CL`/`SV`.
 * @param mockedEngine The replacements.
 * @param callback The test callback.
 * @returns What the callback returns; a promise when the callback is asynchronous.
 */
export function withMockEngine<T = void>(mockedEngine: MockEngineConfig, callback: () => T): T {
  const previousServerState = Cvar.serverState;
  const restoreClientState = useClientStateOf(mockedEngine.CL);
  const restoreHost = useHostOf(mockedEngine.Host);
  const previousPageCom = engineMocks.COM;

  if (mockedEngine.COM !== undefined) {
    engineMocks.COM = mockedEngine.COM;
  }

  Cvar.serverState = {
    isServerActive: () => mockedEngine.CL?.serverController?.state?.active ?? mockedEngine.SV?.server?.active ?? false,
    reportedCheats: () => mockedEngine.CL?.cls?.serverInfo?.sv_cheats,
  };

  const previousCOM = engineMocks.COM;
  const previousCL = engineMocks.CL;
  const previousCon = engineMocks.Con;
  const previousHost = engineMocks.Host;
  const previousSV = engineMocks.SV;

  engineMocks.COM = mockedEngine.COM ?? previousCOM;
  engineMocks.CL = mockedEngine.CL ?? null;
  engineMocks.Con = mockedEngine.Con;
  engineMocks.Host = mockedEngine.Host;
  engineMocks.SV = mockedEngine.SV;

  const restore = (): void => {
    engineMocks.COM = previousPageCom;
    restoreHost();
    restoreClientState();
    Cvar.serverState = previousServerState;
    engineMocks.COM = previousCOM;
    engineMocks.CL = previousCL;
    engineMocks.Con = previousCon;
    engineMocks.Host = previousHost;
    engineMocks.SV = previousSV;
  };

  try {
    const result = callback();

    if (result instanceof Promise) {
      return result.finally(restore) as T;
    }

    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

/**
 * Run a callback with minimal mocked server parts for ServerPhysics tests.
 * @param callback The test callback.
 */
export function withMockServerPhysics(callback: (context: MockServerPhysicsContext) => void): void {
  const linkCalls: MockEdict[] = [];
  const moveCalls: MockServerPhysicsContext['moveCalls'] = [];
  const testCalls: MockEdict[] = [];
  const blockedCalls: MockEntity[] = [];

  const pusherEntity = createMockEntity({
    origin: new Vector(0, 0, 0),
    mins: new Vector(-64, -64, -16),
    maxs: new Vector(64, 64, 16),
    velocity: new Vector(0, 0, 100),
    avelocity: new Vector(),
    movetype: moveType.MOVETYPE_PUSH,
    solidType: solid.SOLID_BSP,
  });
  pusherEntity.blocked = (blockingEntity) => {
    blockedCalls.push(blockingEntity);
  };

  const riderEntity = createMockEntity({
    origin: new Vector(0, 0, 32),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
    velocity: new Vector(),
    avelocity: new Vector(),
    movetype: moveType.MOVETYPE_WALK,
    solidType: solid.SOLID_BBOX,
    flagsValue: flags.FL_ONGROUND,
    groundentity: pusherEntity,
  });

  const worldEdict = createMockEdict(createMockEntity());
  const pusherEdict = createMockEdict(pusherEntity);
  const riderEdict = createMockEdict(riderEntity);

  const linkEdict = (edict: MockEdict): void => {
    edict.entity.absmin = edict.entity.origin.copy().add(edict.entity.mins);
    edict.entity.absmax = edict.entity.origin.copy().add(edict.entity.maxs);
    linkCalls.push(edict);
  };

  withMockEngine({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: {
      frametime: 0.1,
    },
    SV: {
      maxvelocity: { value: 2000 },
      area: {
        linkEdict,
      },
      collision: {
        move(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
          moveCalls.push({ start: start.copy(), mins: mins.copy(), maxs: maxs.copy(), end: end.copy() });
          return new CollisionTrace(end.copy());
        },
        testEntityPosition(edict: MockEdict) {
          testCalls.push(edict);
          return false;
        },
      },
      server: {
        time: 0,
        num_edicts: 3,
        edicts: [worldEdict, pusherEdict, riderEdict],
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    callback({
      serverPhysics: new ServerPhysics(mockedSV()),
      pusherEdict,
      riderEdict,
      linkCalls,
      moveCalls,
      testCalls,
      blockedCalls,
    });
  });
}

// ── Stand-ins for what the server classes are constructed with ──────────────

/** The services a server has as members, mapped to the name a test keeps them under in `engineMocks`. */
const MOCKED_SERVER_SERVICES: Record<string, string> = { con: 'Con', sys: 'Sys', net: 'NET', mod: 'Mod', view: 'V' };

/**
 * A server stand-in that forwards every access to whatever `engineMocks.SV` is at that moment, so a
 * server class can be built once and still see the mock a test installs afterwards.
 * @returns The forwarding server.
 */
export function mockedSV(): Server {
  const forwarding = new Proxy({}, {
    get: (_target, key) => {
      const sv = (engineMocks.SV ?? {}) as MockServer;

      if (!(key in sv) && typeof key === 'string' && key in MOCKED_SERVER_SERVICES) {
        return engineMocks[MOCKED_SERVER_SERVICES[key]];
      }

      if (!(key in sv) && key === 'engineAPI') {
        return engineAPI;
      }

      return Reflect.get(sv, key);
    },
    set: (_target, key, value) => Reflect.set((engineMocks.SV ?? {}) as MockServer, key, value),
    has: (_target, key) => key in ((engineMocks.SV ?? {}) as MockServer),
  }) as Server; // A proxy has no way to be a `Server` for the type checker; every member is answered by the mock.
  // The engine API a test server has unless the mock brings its own.
  const engineAPI = new ServerEngineAPI(forwarding, () => ({ registered: true, hipnotic: false, rogue: false }));

  return forwarding;
}

/**
 * The server a test mocked with `withMockEngine`, read back as the real thing: the tests ask it for the state their code changed.
 * @returns The mocked server.
 */
export function mockedServer(): Server {
  // The mock stands in for a Server; a test only reads members it set up itself.
  return engineMocks.SV as Server;
}

/**
 * A collision model source that resolves the world and the models through whatever server is mocked at the time of the call.
 * @returns The model source.
 */
export function mockedCollisionModelSource(): CollisionModelSource {
  const mockedServer = (): MockServerState | undefined => (engineMocks.SV as MockServer | undefined)?.server;

  return {
    getWorldEntity: () => (mockedServer()?.edicts as CollisionWorldEntities | undefined)?.[0] ?? null,
    getWorldModel: () => (mockedServer()?.worldmodel as ReturnType<CollisionModelSource['getWorldModel']> | undefined) ?? null,
    getModelByIndex: (modelIndex) => {
      const model = (mockedServer()?.models as unknown[] | undefined)?.[modelIndex];

      return model instanceof Promise ? null : (model as ReturnType<CollisionModelSource['getModelByIndex']> | undefined) ?? null;
    },
  };
}

/** The first edict of a mocked server is the world's. */
type CollisionWorldEntities = Array<ReturnType<CollisionModelSource['getWorldEntity']>>;

/**
 * The services a `Navigation` is built from, forwarding to the mocked server like `mockedSV()` does.
 * @returns The services.
 */
export function mockedNavigationServices(): NavigationServices {
  const forward = (name: string): object => new Proxy({}, {
    get: (_target, key) => {
      const mock = engineMocks[name] as Record<string | symbol, unknown> | undefined;
      const member = mock?.[key];

      return typeof member === 'function' ? member.bind(mock) : member;
    },
  });

  // Each service answers whatever the mock has; the proxies stand in for the interfaces they are named after.
  return { con: forward('Con'), files: forward('COM'), sv: mockedSV() } as NavigationServices;
}

/**
 * Builds a real `Server` whose services are silent stand-ins, so tests can drive its methods without the engine's globals.
 * @param overrides The services to replace.
 * @returns The server.
 */
export function createTestServer(overrides: Partial<ServerDependencies> = {}): Server {
  return new Server({
    con: { Print() {}, DPrint() {}, PrintWarning() {}, PrintError() {}, PrintSuccess() {}, StartCapturing() {}, StopCapturing: () => '' },
    sys: { Print() {}, FloatTime: () => 0 },
    // Tests that need the network or the model cache replace them through the overrides.
    net: {} as ServerDependencies['net'],
    mod: {} as ServerDependencies['mod'],
    view: { CalcRoll: () => 0 },
    files: { LoadFile: () => Promise.resolve(null), WriteFile: () => Promise.resolve(true) },
    engineVersion: () => 'test',
    gameEdition: () => ({ registered: true, hipnotic: false, rogue: false }),
    dedicated: true,
    ...overrides,
  });
}

/**
 * Builds a `ServerHost` around a test server, with every process-level service replaced by a stand-in.
 * @param overrides What to replace: the server, and the host's own dependencies.
 * @param overrides.server The server the host drives.
 * @param overrides.host Replacements for the host's dependencies.
 * @returns The host and what it recorded.
 */
export function createTestServerHost({ server = createTestServer(), host = {} }: { server?: Server; host?: Partial<ServerHostDependencies> } = {}): TestServerHost {
  const scheduled: TestServerHost['scheduled'] = [];
  const noclip: boolean[] = [];
  const serverHost = new ServerHost({
    sv: server,
    dedicated: true,
    scheduleForNextFrame: (callback) => { scheduled.push(callback); },
    profiling: () => false,
    setNoclipAnglehack: (enabled) => { noclip.push(enabled); },
    ...host,
  });

  return { sv: server, serverHost, scheduled, noclip };
}

/**
 * Builds a network layer with silent services, so network code can be tested without the engine's globals.
 * @param options What to replace.
 * @returns The network layer.
 */
export function createTestNetwork({ dedicated = false, urls = undefined, mapname = 'start', maxPlayers = 4, game = 'id1' }: TestNetworkOptions = {}): NET {
  const net = new NET({
    con: { DPrint() {}, Print() {}, PrintError() {}, PrintWarning() {}, PrintSuccess() {} },
    sys: { Print() {}, FloatTime() { return 1; } },
    dedicated,
    urls: () => urls,
    serverInfo: () => ({ maxPlayers, mapname, game }),
    webSocketModule: () => undefined,
  });

  net.time = 1;
  net.message = new SzBuffer(128, 'test net message');

  return net;
}

/**
 * Two endpoints wired to each other. Messages are delivered at once but cloned the way a message
 * port clones them, so a test cannot depend on sharing memory with the other side.
 * @returns The two ends.
 */
export function createChannelEndpointPair(): [ChannelEndpoint, ChannelEndpoint] {
  const receivers: Array<(message: ChannelMessage) => void> = [() => {}, () => {}];
  const delivered: ChannelMessage[][] = [[], []];

  const endpointFor = (self: 0 | 1): ChannelEndpoint => ({
    post(message, transfer = []) {
      const other = 1 - self;
      const copy = structuredClone(message, { transfer });

      delivered[other].push(copy);
      receivers[other](copy);
    },
    setReceiver(receiver) {
      receivers[self] = receiver;
    },
  });

  return [endpointFor(0), endpointFor(1)];
}
