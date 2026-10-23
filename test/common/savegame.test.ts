/* eslint-disable require-atomic-updates, @typescript-eslint/unbound-method -- these tests swap engine singletons and put the original back in a finally block, never calling it detached */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import COMClass from '../../source/engine/common/Com.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import * as Def from '../../source/engine/common/Def.ts';
import type { BrushModel } from '../../source/engine/common/model/BSP.ts';
import type { ServerEngineAPI } from '../../source/engine/server/ServerEngineAPI.ts';
import Mod from '../../source/engine/common/Mod.ts';
import ClientLifecycle from '../../source/engine/client/ClientLifecycle.ts';
import InThreadServerController from '../../source/engine/server/InThreadServerController.ts';
import { ED, ServerEdict } from '../../source/engine/server/Edict.ts';
import NodeCOM from '../../source/engine/server/Com.ts';
import { Serializer } from '../../source/game/id1/helper/MiscHelpers.ts';
import { cvarFlags } from '../../source/shared/Defs.ts';
import Vector from '../../source/shared/Vector.ts';

import type Server from '../../source/engine/server/Server.ts';
import type ServerHost from '../../source/engine/server/ServerHost.ts';
import { defaultMockEngine, withMockEngine, mockedSV, type MockClient, type MockServer } from '../support/fixtures.ts';
import '../support/consoleBridge.ts';
import Particles from '../../source/engine/client/renderer/effects/Particles.ts';
import ClientHost from '../../source/engine/client/ClientHost.ts';
import { runConsoleCommand } from '../support/consoleCommands.ts';
import { patchMembers } from '../support/clientState.ts';
import { installEngineMocks } from '../support/withEngineMocks.ts';

// The sv, the host and the server state of these tests are stand-ins with the members a save reads and writes.
const asServer = (value: object): Server => value as unknown as Server;
const asServerHost = (value: object): ServerHost => value as unknown as ServerHost;
const asMockServer = (value: object): MockServer => value as unknown as MockServer;
const asCvars = (cvars: Record<string, MockCvar>): typeof ServerGameAPI._cvars => cvars as unknown as typeof ServerGameAPI._cvars;
const asMockClient = (value: object): MockClient => value as unknown as MockClient;

const [{ ServerGameAPI }, { PlayerEntity }, { WorldspawnEntity }] = await Promise.all([
  import('../../source/game/id1/GameAPI.ts'),
  import('../../source/game/id1/entity/Player.ts'),
  import('../../source/game/id1/entity/Worldspawn.ts'),
]);

/** What the mock console collected, by how loud it was. */
interface MockConsoleMessages {
  print: string[];
  warning: string[];
  error: string[];
  success: string[];
  debug: string[];
}

/**
 * Builds a console that keeps what it is asked to print.
 * @returns The console and the messages it collected.
 */
function createMockConsole(): { messages: MockConsoleMessages; Con: { Print(message: string): void; DPrint(message: string): void; PrintWarning(message: string): void; PrintError(message: string): void; PrintSuccess(message: string): void } } {
  const messages: MockConsoleMessages = {
    print: [],
    warning: [],
    error: [],
    success: [],
    debug: [],
  };

  return {
    messages,
    Con: {
      Print(message: string) {
        messages.print.push(message);
      },
      DPrint(message: string) {
        messages.debug.push(message);
      },
      PrintWarning(message: string) {
        messages.warning.push(message);
      },
      PrintError(message: string) {
        messages.error.push(message);
      },
      PrintSuccess(message: string) {
        messages.success.push(message);
      },
    },
  };
}

/** A console variable that remembers what it was last set to. */
interface MockCvar {
  name: string;
  string: string;
  flags: number;
  value: number;
  lastSet: unknown;
  set(value: unknown): void;
}

/**
 * Builds a console variable that remembers what it was last set to.
 * @param name Name of the variable.
 * @param string Its text.
 * @param flags Its flags.
 * @returns The mock variable.
 */
function createMockCvar(name: string, string: string, flags: number = cvarFlags.NONE): MockCvar {
  const value = Number(string);

  return {
    name,
    string,
    flags,
    value,
    lastSet: null,
    set(value: unknown) {
      this.lastSet = value;
      this.string = String(value);
      this.value = Number(value);
    },
  };
}

/** An entity that serializes what it is told to and keeps what it was given back. */
interface MockSaveEntity {
  classname: string;
  edictId: number;
  lastDeserializedData: unknown;
  serialize(): Record<string, unknown>;
  deserialize(data: Record<string, unknown>): void;
}

/**
 * Builds an entity that serializes a fixed payload and records what it is given back.
 * @param options What the entity is and does.
 * @param options.classname Class name of the entity.
 * @param options.edictId Number of its edict.
 * @param options.serializedData What `serialize` returns.
 * @param options.onDeserialize Called with what `deserialize` is given.
 * @returns The mock entity.
 */
function createMockEntity({ classname, edictId, serializedData = {}, onDeserialize = null }: { classname: string; edictId: number; serializedData?: Record<string, unknown>; onDeserialize?: ((data: Record<string, unknown>) => void) | null }): MockSaveEntity {
  return {
    classname,
    edictId,
    lastDeserializedData: null,
    serialize() {
      return serializedData;
    },
    deserialize(data: Record<string, unknown>) {
      if (onDeserialize !== null) {
        onDeserialize(data);
      }

      this.lastDeserializedData = data;
      Object.assign(this, data);
    },
  };
}

/** An edict that counts how often it is freed and linked. */
interface MockSaveEdict {
  num: number;
  entity: MockSaveEntity | null;
  freeCount: number;
  linkedCount: number;
  isFree(): boolean;
  freeEdict(): void;
  linkEdict(): void;
}

/**
 * Builds an edict that counts how often it is freed and linked.
 * @param num Number of the edict.
 * @param entity The entity it holds.
 * @param hooks Called when the edict is freed or linked.
 * @param hooks.onFree Called when the edict is freed.
 * @param hooks.onLink Called when the edict is linked.
 * @returns The mock edict.
 */
function createMockEdict(num: number, entity: MockSaveEntity | null = null, { onFree = null, onLink = null }: { onFree?: (() => void) | null; onLink?: (() => void) | null } = {}): MockSaveEdict {
  return {
    num,
    entity,
    freeCount: 0,
    linkedCount: 0,
    isFree() {
      return this.entity === null;
    },
    freeEdict() {
      this.freeCount += 1;
      if (onFree !== null) {
        onFree();
      }

      this.entity = null;
    },
    linkEdict() {
      this.linkedCount += 1;
      if (onLink !== null) {
        onLink();
      }
    },
  };
}

/** The game API a save is made through: it serializes its globals and builds entities for restored edicts. */
interface MockSerializableGame {
  worldspawn: unknown;
  _serializer: { serialize(): unknown; deserialize(data: unknown): void };
  serialize(): unknown;
  deserialize(data: unknown): void;
  prepareEntity(edict: MockSaveEdict, classname: string): boolean;
}

/**
 * Builds a game API whose globals are serialized by the id1 serializer.
 * @param edicts The edicts of the server, by number.
 * @param options What the game has and records.
 * @param options.worldspawn The world entity the game keeps.
 * @param options.callOrder Receives what the restore does, in order.
 * @returns The game API.
 */
function createSerializableGameAPI(edicts: Array<MockSaveEdict | undefined>, { worldspawn = null, callOrder = [] }: { worldspawn?: unknown; callOrder?: string[] } = {}): MockSerializableGame {
  const engine = {
    GetEdictById(edictId: number) {
      return edicts[edictId] ?? null;
    },
  };

  const gameAPI = {
    worldspawn,
    serialize() {
      return this._serializer.serialize();
    },
    deserialize(data: unknown) {
      callOrder.push('globals-deserialize');
      this._serializer.deserialize(data);
    },
    prepareEntity(edict: MockSaveEdict, classname: string) {
      callOrder.push(`prepare:${edict.num}:${classname}`);
      edict.entity = createMockEntity({
        classname,
        edictId: edict.num,
        onDeserialize() {
          callOrder.push(`entity-deserialize:${edict.num}`);
        },
      });
      return true;
    },
  } as MockSerializableGame;

  // The serializer attaches itself to the object it serializes and reads the engine for edict lookups.
  Serializer.makeSerializable(gameAPI as never, engine as never, ['worldspawn']);
  return gameAPI;
}

/**
 * Replaces the console variable lookups of the engine for the duration of a callback.
 * @param options The variables the replacements know.
 * @param options.filterCvars The variables `Cvar.Filter` walks over.
 * @param options.lookupCvars The variables `Cvar.FindVar` finds, by name.
 * @param callback The test callback.
 * @returns What the callback returns; a promise when it is asynchronous.
 */
function withMockCvarStatics<T>({ filterCvars = [], lookupCvars = {} }: { filterCvars?: MockCvar[]; lookupCvars?: Record<string, MockCvar> } = {}, callback: () => T): T {
  const previousFilter = Cvar.Filter;
  const previousFindVar = Cvar.FindVar;

  // The save asks for the archived variables and looks single ones up; the mocks answer both.
  Cvar.Filter = function* Filter(compareFn: (cvar: Cvar) => boolean) {
    for (const cvar of filterCvars as unknown as Cvar[]) {
      if (compareFn(cvar)) {
        yield cvar;
      }
    }
  };

  Cvar.FindVar = (name: string) => (lookupCvars[name] ?? null) as unknown as Cvar | null;

  const restore = (): void => {
    Cvar.Filter = previousFilter;
    Cvar.FindVar = previousFindVar;
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
 * Parse a Quake entity lump into plain record objects.
 * @param text entity lump text
 * @returns parsed entity records
 */
function parseMapEntities(text: string): Record<string, string>[] {
  const entities: Record<string, string>[] = [];
  let data: string | null = text;

  while (data !== null) {
    let parsed = COMClass.Parse(data);
    data = parsed.data;

    if (parsed.token.length === 0) {
      break;
    }

    if (parsed.token !== '{') {
      continue;
    }

    const entity: Record<string, string> = {};

    while (true) {
      if (data === null) {
        throw new Error('Entity lump ends inside an entity');
      }

      parsed = COMClass.Parse(data);
      data = parsed.data;

      if (parsed.token === '}') {
        entities.push(entity);
        break;
      }

      if (data === null) {
        throw new Error('Entity lump ends inside an entity');
      }

      const key = parsed.token;
      parsed = COMClass.Parse(data);
      data = parsed.data;
      entity[key] = parsed.token;
    }
  }

  return entities;
}

/**
 * Convert a Quake origin string into a Vector.
 * @param origin origin text from the entity lump
 * @returns parsed origin
 */
function parseMapOrigin(origin: string): Vector {
  const components = origin.split(/\s+/).map(Number);
  return new Vector(components[0], components[1], components[2]);
}

/**
 * Find a map entity matching the predicate.
 * @param entities parsed entity records
 * @param predicate entity predicate
 * @param label label for the error message
 * @returns matching entity record
 */
function requireMapEntity(entities: Record<string, string>[], predicate: (entity: Record<string, string>) => boolean, label: string): Record<string, string> {
  const entity = entities.find(predicate);

  if (entity === undefined) {
    throw new Error(`Could not find ${label} in entity lump`);
  }

  return entity;
}

/**
 * Create a small engine surface for real id1 server entity tests.
 * @param getEdicts function that returns the active edict array
 * @returns minimal engine API
 */
function createIntegrationEngineAPI(getEdicts: () => ServerEdict[]): Readonly<ServerEngineAPI> {
  const cvars: Record<string, MockCvar> = {
    teamplay: createMockCvar('teamplay', '0'),
    sv_gravity: createMockCvar('sv_gravity', '800'),
    sv_nextmap: createMockCvar('sv_nextmap', ''),
  };

  return {
    GetCvar(name: string) {
      return cvars[name] ?? null;
    },
    RegisterCvar(name: string, value: string, flags = 0) {
      if (cvars[name] !== undefined) {
        cvars[name].flags = flags;
        return cvars[name];
      }

      const cvar = createMockCvar(name, value, flags);
      cvars[name] = cvar;
      return cvar;
    },
    ParseQC: Mod.ParseQC,
    eventBus: {
      subscribe() {
        return () => { };
      },
    },
    maxplayers: 1,
    PrecacheModel() { },
    PrecacheSound() { },
    ConsoleWarning() { },
    ConsoleError() { },
    ConsolePrint() { },
    BroadcastPrint() { },
    ChangeLevel() { },
    PlayTrack() { },
    Lightstyle() { },
    SetCvar() { },
    SpawnEntity() {
      throw new Error('unexpected SpawnEntity call in integration test');
    },
    FindByFieldAndValue() {
      return null;
    },
    FindAllByFieldAndValue() {
      return [];
    },
    GetEdictById(edictId: number) {
      return getEdicts()[edictId] ?? null;
    },
  } as unknown as Readonly<ServerEngineAPI>;
}

void describe('ClientHost.Savegame_f', () => {
  void test('writes a save payload with serialized globals, edicts, and filtered cvars', async () => {
    const consoleCapture = createMockConsole();
    const writes: Array<{ filename: string; data: string }> = [];
    const worldspawn = createMockEntity({
      classname: 'worldspawn',
      edictId: 0,
      serializedData: { model: '*0' },
    });
    const player = createMockEntity({
      classname: 'player',
      edictId: 1,
      serializedData: { health: 100, origin: [128, 64, 32] },
    });
    const edicts = [
      createMockEdict(0, worldspawn),
      createMockEdict(1, player),
      createMockEdict(2, null),
    ];
    const gameAPI = createSerializableGameAPI(edicts, { worldspawn });
    const clientGameAPI = {
      saveGame() {
        return JSON.stringify({ hud: 'client-state' });
      },
    };
    const client = {
      state: 2,
      spawn_parms: 'spawn-parms',
      edict: edicts[1],
    };
    const sv = {
      server: {
        active: true,
        gameAPI,
        gameVersion: 'test-game',
        mapname: 'e1m1',
        time: 123.5,
        lightstyles: ['m', 'a'],
        num_edicts: 2,
        edicts,
      },
      svs: {
        maxclients: 1,
        clients: [client],
      },
    };
    // what the pool of particles writes into the savegame
    const renderer = {
      SerializeParticles() {
        return [{ type: 'spark' }];
      },
    };
    const filterCvars = [
      createMockCvar('sv_gravity', '800', cvarFlags.SERVER),
      createMockCvar('skill', '2', cvarFlags.GAME),
      createMockCvar('r_old', '1', cvarFlags.ARCHIVE),
    ];
    const mockCOM = {
      DefaultExtension: COMClass.DefaultExtension,
      GetGamedir: () => 'id1',
      WriteTextFile(filename: string, data: string) {
        writes.push({ filename, data });
        return true;
      },
      LoadTextFile() {
        return null;
      },
    };

    const previousFilter = Cvar.Filter;

    const restoreEngineMocks = installEngineMocks({
      CL: {
        serverController: new InThreadServerController(asServer(sv), asServerHost({})),
        state: {
          intermission: 0,
          levelname: 'E1M1',
          gameAPI: clientGameAPI,
          clientEntities: {
            serialize() {
              return [{ classname: 'debris' }];
            },
          },
        },
      },
      COM: mockCOM,
      Con: consoleCapture.Con,
      SV: sv,
    });
    const restoreParticles = patchMembers(Particles, renderer);

    Cvar.Filter = function* Filter(compareFn: (cvar: Cvar) => boolean) {
      for (const cvar of filterCvars as unknown as Cvar[]) {
        if (compareFn(cvar)) {
          yield cvar;
        }
      }
    };

    try {
      await runConsoleCommand(ClientHost.Savegame_f, { client: null }, 'save/e1m1');
    } finally {
      Cvar.Filter = previousFilter;
      restoreEngineMocks();
      restoreParticles();
    }

    assert.equal(writes.length, 1);
    assert.equal(writes[0].filename, 'save/e1m1.json');

    const saved = JSON.parse(writes[0].data);

    assert.equal(saved.version, Def.gamestateVersion);
    assert.equal(saved.gameversion, 'test-game');
    assert.equal(saved.comment, 'E1M1');
    assert.equal(saved.spawn_parms, 'spawn-parms');
    assert.equal(saved.mapname, 'e1m1');
    assert.equal(saved.time, 123.5);
    assert.deepEqual(saved.lightstyles, ['m', 'a']);
    assert.deepEqual(saved.globals, { worldspawn: ['E', 0] });
    assert.deepEqual(saved.cvars, [
      ['sv_gravity', '800'],
      ['skill', '2'],
    ]);
    assert.equal(saved.clientdata, JSON.stringify({ hud: 'client-state' }));
    assert.deepEqual(saved.edicts[0], ['worldspawn', { model: '*0' }]);
    assert.deepEqual(saved.edicts[1], ['player', { health: 100, origin: [128, 64, 32] }]);
    assert.equal(saved.edicts[2], null);
    assert.equal(saved.num_edicts, 2);
    assert.deepEqual(saved.particles, [{ type: 'spark' }]);
    assert.deepEqual(saved.clientEntities, [{ classname: 'debris' }]);
    assert.deepEqual(consoleCapture.messages.warning, []);
    assert.deepEqual(consoleCapture.messages.error, []);
    assert.deepEqual(consoleCapture.messages.success, ['done.\n']);
  });
});

void describe('ClientHost.Loadgame_f', () => {
  void test('restores prepared edicts before global entity references', async () => {
    const consoleCapture = createMockConsole();
    const callOrder: string[] = [];
    const resumes: Array<{ clientdata: unknown; particles: unknown }> = [];
    const gravityCvar = createMockCvar('sv_gravity', '800');
    const edicts = [
      createMockEdict(0, null, {
        onFree() {
          callOrder.push('free:0');
        },
        onLink() {
          callOrder.push('link:0');
        },
      }),
      createMockEdict(1, null, {
        onFree() {
          callOrder.push('free:1');
        },
        onLink() {
          callOrder.push('link:1');
        },
      }),
      createMockEdict(2, null, {
        onFree() {
          callOrder.push('free:2');
        },
        onLink() {
          callOrder.push('link:2');
        },
      }),
    ];
    const gameAPI = createSerializableGameAPI(edicts, {
      callOrder,
    });
    const savegame = {
      version: Def.gamestateVersion,
      gameversion: 'test-game',
      comment: 'E1M1',
      spawn_parms: 'spawn-parms',
      mapname: 'e1m1',
      time: 456.75,
      lightstyles: ['m'],
      globals: { worldspawn: ['E', 0] },
      cvars: [
        ['sv_gravity', '900'],
        ['missing_cvar', '1'],
      ],
      clientdata: JSON.stringify({ hud: 'client-state' }),
      edicts: [
        ['worldspawn', { health: 100 }],
        ['player', { health: 42 }],
        null,
      ],
      num_edicts: 2,
      particles: [{ type: 'spark' }],
    };
    const sv = {
      server: {
        active: false,
        paused: false,
        loadgame: false,
        gameAPI: null as MockSerializableGame | null,
        gameVersion: null as string | null,
        mapname: null as string | null,
        time: 0,
        lightstyles: [],
        num_edicts: 0,
        edicts,
      },
      svs: {
        maxclients: 1,
        clients: [
          {
            spawn_parms: null,
          },
        ],
      },
      SpawnServer: (mapname: string) => {
        callOrder.push(`spawn:${mapname}`);
        sv.server.active = true;
        sv.server.gameAPI = gameAPI;
        sv.server.gameVersion = 'test-game';
        sv.server.mapname = mapname;
        return Promise.resolve(true);
      },
      ShutdownServer() { },
    };
    const client = {
      cls: { demonum: 0 },
      Disconnect() { },
      SetConnectingStep() { },
      serverController: new InThreadServerController(asServer(sv), asServerHost({})),
    };

    Object.assign(sv, { con: consoleCapture.Con });
    const mockCOM = {
      DefaultExtension: COMClass.DefaultExtension,
      GetGamedir: () => 'id1',
      WriteTextFile() {
        return true;
      },
      LoadTextFile() {
        return JSON.stringify(savegame);
      },
    };
    const previousResumeGame = ClientLifecycle.resumeGame;
    ClientLifecycle.resumeGame = (clientdata, particles) => {
      resumes.push({ clientdata, particles });
    };
    const restoreEngineMocks = installEngineMocks({ SCR: { BeginLoadingPlaque() { } } });

    try {
      await withMockEngine({
        ...defaultMockEngine(asMockServer(sv), asMockClient(client)),
        COM: mockCOM,
        Con: consoleCapture.Con,
      }, async () => {
        await withMockCvarStatics({
          lookupCvars: {
            sv_gravity: gravityCvar,
          },
        }, async () => {
          await runConsoleCommand(ClientHost.Loadgame_f, { client: null }, 'save/e1m1');
        });
      });
    } finally {
      ClientLifecycle.resumeGame = previousResumeGame;
      restoreEngineMocks();
    }

    assert.deepEqual(callOrder, [
      'spawn:e1m1',
      'prepare:0:worldspawn',
      'prepare:1:player',
      'free:2',
      'entity-deserialize:0',
      'link:0',
      'entity-deserialize:1',
      'link:1',
      'globals-deserialize',
    ]);
    assert.equal(sv.server.paused, false);
    assert.equal(sv.server.loadgame, true);
    assert.deepEqual(sv.server.lightstyles, ['m']);
    assert.equal(sv.server.time, 456.75);
    assert.equal(sv.svs.clients[0].spawn_parms, 'spawn-parms');
    assert.equal(gameAPI.worldspawn, edicts[0].entity);
    assert.deepEqual(edicts[0].entity!.lastDeserializedData, { health: 100 });
    assert.deepEqual(edicts[1].entity!.lastDeserializedData, { health: 42 });
    assert.equal(edicts[2].entity, null);
    assert.equal(edicts[2].freeCount, 1);
    assert.deepEqual(resumes, [{
      clientdata: JSON.stringify({ hud: 'client-state' }),
      particles: [{ type: 'spark' }],
    }]);
    assert.equal(gravityCvar.string, '900');
    assert.equal(gravityCvar.lastSet, '900');
    assert.deepEqual(consoleCapture.messages.warning, [
      'Saved cvar missing_cvar not found, skipping\n',
    ]);
  });

  void test('throws when the save file is malformed', async () => {
    const consoleCapture = createMockConsole();
    let spawnCalls = 0;
    const sv = {
      server: {
        active: false,
      },
      svs: {
        maxclients: 1,
        clients: [
          {
            spawn_parms: null,
          },
        ],
      },
      SpawnServer: () => {
        spawnCalls += 1;
        return Promise.resolve(true);
      },
      ShutdownServer() { },
    };
    const client = {
      cls: { demonum: 0 },
      Disconnect() { },
      SetConnectingStep() { },
      serverController: new InThreadServerController(asServer(sv), asServerHost({})),
    };

    Object.assign(sv, { con: consoleCapture.Con });
    const mockCOM = {
      DefaultExtension: COMClass.DefaultExtension,
      GetGamedir: () => 'id1',
      WriteTextFile() {
        return true;
      },
      LoadTextFile() {
        return '{';
      },
    };

    await withMockEngine({
      ...defaultMockEngine(asMockServer(sv), asMockClient(client)),
      COM: mockCOM,
      Con: consoleCapture.Con,
    }, async () => {
      await assert.rejects(
        async () => { await runConsoleCommand(ClientHost.Loadgame_f, { client: null }, 'broken-save'); },
        (error: unknown) => error instanceof Error && error.message.includes('is corrupted or unreadable'),
      );
    });

    assert.equal(spawnCalls, 0);
    assert.deepEqual(consoleCapture.messages.error, []);
  });

  void test('throws when the save file needs more edicts than the server allocated', async () => {
    const consoleCapture = createMockConsole();
    const callOrder: string[] = [];
    const edicts = [
      createMockEdict(0, null),
      createMockEdict(1, null),
    ];
    const gameAPI = createSerializableGameAPI(edicts, { callOrder });
    const savegame = {
      version: Def.gamestateVersion,
      gameversion: 'test-game',
      comment: 'E1M1',
      spawn_parms: 'spawn-parms',
      mapname: 'e1m1',
      time: 456.75,
      lightstyles: ['m'],
      globals: { worldspawn: ['E', 0] },
      cvars: [],
      clientdata: JSON.stringify({ hud: 'client-state' }),
      edicts: [
        ['worldspawn', { health: 100 }],
        ['player', { health: 42 }],
        null,
      ],
      num_edicts: 2,
      particles: [],
    };
    let spawnCalls = 0;
    const sv = {
      server: {
        active: false,
        paused: false,
        loadgame: false,
        gameAPI: null as MockSerializableGame | null,
        gameVersion: null as string | null,
        mapname: null as string | null,
        time: 0,
        lightstyles: [],
        num_edicts: 0,
        edicts,
      },
      svs: {
        maxclients: 1,
        clients: [
          {
            spawn_parms: null,
          },
        ],
      },
      SpawnServer: (mapname: string) => {
        spawnCalls += 1;
        sv.server.active = true;
        sv.server.gameAPI = gameAPI;
        sv.server.gameVersion = 'test-game';
        sv.server.mapname = mapname;
        return Promise.resolve(true);
      },
      ShutdownServer() { },
    };
    const client = {
      cls: { demonum: 0 },
      Disconnect() { },
      SetConnectingStep() { },
      serverController: new InThreadServerController(asServer(sv), asServerHost({})),
    };

    Object.assign(sv, { con: consoleCapture.Con });
    const mockCOM = {
      DefaultExtension: COMClass.DefaultExtension,
      GetGamedir: () => 'id1',
      WriteTextFile() {
        return true;
      },
      LoadTextFile() {
        return JSON.stringify(savegame);
      },
    };

    const restoreEngineMocks = installEngineMocks({ SCR: { BeginLoadingPlaque() { } } });

    try {
      await withMockEngine({
        ...defaultMockEngine(asMockServer(sv), asMockClient(client)),
        COM: mockCOM,
        Con: consoleCapture.Con,
      }, async () => {
        await assert.rejects(
          async () => { await runConsoleCommand(ClientHost.Loadgame_f, { client: null }, 'save/e1m1'); },
          (error: unknown) => error instanceof Error && error.message.includes('needs 3 edicts but the server only allocated 2'),
        );
      });
    } finally {
      restoreEngineMocks();
    }

    assert.equal(spawnCalls, 1);
    assert.deepEqual(callOrder, []);
    assert.deepEqual(consoleCapture.messages.error, []);
  });
});

void describe('Host.save/load integration', () => {
  void test('round-trips real id1 worldspawn and player entities on E1M1', async () => {
    const consoleCapture = createMockConsole();
    const knownKeysBefore = new Set(Object.keys(Mod.known));
    const resumes: Array<{ clientdata: unknown; particles: unknown; clientEntities: unknown }> = [];
    const previousServerGameCvars = ServerGameAPI._cvars;
    const nodeCom = new NodeCOM({
      con: { Print() {}, DPrint() {}, PrintWarning() {}, PrintError() {}, PrintSuccess() {} },
      sys: { Print() {}, FloatTime: () => 0 },
      buildConfig: () => undefined,
      urls: () => undefined,
    });
    const savedCvars = [
      createMockCvar('sv_gravity', '800', cvarFlags.SERVER),
      createMockCvar('skill', '2', cvarFlags.GAME),
    ];
    const currentCvarLookup = {
      sv_gravity: savedCvars[0],
      skill: savedCvars[1],
    };
    let currentEdicts: ServerEdict[] = [];
    let savedText: string | null = null;

    ServerGameAPI._cvars = asCvars({
      nomonster: createMockCvar('nomonster', '0'),
      fraglimit: createMockCvar('fraglimit', '0'),
      timelimit: createMockCvar('timelimit', '0'),
      samelevel: createMockCvar('samelevel', '0'),
      noexit: createMockCvar('noexit', '0'),
      skill: createMockCvar('skill', '2'),
      deathmatch: createMockCvar('deathmatch', '0'),
      coop: createMockCvar('coop', '0'),
    });
    const restoreEngineMocks = installEngineMocks({ Sys: { Print() { } }, SCR: { BeginLoadingPlaque() { } } });

    const engineAPI = createIntegrationEngineAPI(() => currentEdicts);
    const mockCOM = {
      Parse: COMClass.Parse,
      ParseEntityLump: COMClass.ParseEntityLump,
      DefaultExtension: COMClass.DefaultExtension,
      async LoadFile(name: string) {
        return nodeCom.LoadFile(name);
      },
      LoadTextFile(name: string) {
        return Promise.resolve(name.endsWith('.json') ? savedText : null);
      },
      LoadOptionalTextFile(name: string) {
        return this.LoadTextFile(name);
      },
      WriteTextFile(filename: string, data: string) {
        if (!filename.endsWith('.json')) {
          return false;
        }

        savedText = data;
        return true;
      },
    };
    const sv = {
      ed: new ED(mockedSV()),
      server: {
        active: true,
        paused: false,
        loadgame: false,
        gameAPI: null as InstanceType<typeof ServerGameAPI> | null,
        gameVersion: 'integration-test',
        mapname: 'e1m1',
        time: 73.25,
        lightstyles: ['m'],
        num_edicts: 0,
        edicts: [] as ServerEdict[],
      },
      svs: {
        maxclients: 1,
        clients: [
          {
            state: 3,
            spawn_parms: null as string | null,
            edict: null as ServerEdict | null,
          },
        ],
      },
      area: {
        linkEdict() { },
        unlinkEdict() { },
      },
      SpawnServer: (mapname: string) => {
        const freshEdicts = [new ServerEdict(0, mockedSV()), new ServerEdict(1, mockedSV()), new ServerEdict(2, mockedSV())];
        currentEdicts = freshEdicts;
        const freshGameAPI = new ServerGameAPI(engineAPI);
        freshGameAPI.mapname = mapname;
        freshGameAPI.serverflags = 0;
        freshGameAPI.time = 0;
        freshGameAPI.framecount = 0;
        freshGameAPI.frametime = 0;
        sv.server.active = true;
        sv.server.paused = false;
        sv.server.loadgame = false;
        sv.server.gameAPI = freshGameAPI;
        sv.server.gameVersion = 'integration-test';
        sv.server.mapname = mapname;
        sv.server.time = 0;
        sv.server.lightstyles = [];
        sv.server.num_edicts = freshEdicts.length;
        sv.server.edicts = freshEdicts;
        sv.svs.clients[0].edict = freshEdicts[1];
        return true;
      },
      ShutdownServer() { },
    };
    const client = {
      cls: { demonum: 0 },
      Disconnect() { },
      SetConnectingStep() { },
      serverController: new InThreadServerController(asServer(sv), asServerHost({})),
      state: {
        intermission: 0,
        levelname: 'E1M1',
        gameAPI: {
          saveGame() {
            return JSON.stringify({ hud: 'integration-client' });
          },
        },
        clientEntities: {
          serialize() {
            return [];
          },
        },
      },
    };
    const previousResumeGame = ClientLifecycle.resumeGame;

    Object.assign(sv, { con: consoleCapture.Con });
    ClientLifecycle.resumeGame = (clientdata, particles, clientEntities) => {
      resumes.push({ clientdata, particles, clientEntities });
    };

    try {
      await withMockEngine({
        ...defaultMockEngine(asMockServer(sv), asMockClient(client)),
        COM: mockCOM,
        Con: consoleCapture.Con,
      }, async () => {
        // Load the real id1 pak metadata so maps/e1m1.bsp resolves through COM.
        await nodeCom.AddGameDirectory('id1');

        Mod.Init({ files: mockCOM, con: consoleCapture.Con, loadRenderData: false });

        const model = await Mod.ForNameAsync('maps/e1m1.bsp', true);
        assert.ok(model !== null);

        const entities = parseMapEntities((model as BrushModel).entities!);
        const spawnRecord = requireMapEntity(
          entities,
          (entity) => entity.classname === 'info_player_start',
          'spawn entity classname=info_player_start',
        );
        const spawnOrigin = parseMapOrigin(spawnRecord.origin);

        const saveEdicts = [new ServerEdict(0, mockedSV()), new ServerEdict(1, mockedSV()), new ServerEdict(2, mockedSV())];
        currentEdicts = saveEdicts;

        const saveGameAPI = new ServerGameAPI(engineAPI);
        saveGameAPI.mapname = 'e1m1';
        saveGameAPI.serverflags = 0;
        saveGameAPI.time = 73.25;
        saveGameAPI.framecount = 17;
        saveGameAPI.frametime = 0.1;
        saveGameAPI.nextmap = 'e1m2';

        assert.equal(saveGameAPI.prepareEntity(saveEdicts[0], 'worldspawn', {}), true);
        assert.equal(saveGameAPI.prepareEntity(saveEdicts[1], 'player', {}), true);

        const saveWorldspawn = saveEdicts[0].entity;
        const savePlayer = saveEdicts[1].entity;

        assert.ok(saveWorldspawn instanceof WorldspawnEntity);
        assert.ok(savePlayer instanceof PlayerEntity);

        saveWorldspawn.sounds = 1;
        saveWorldspawn.worldtype = 0;
        savePlayer.origin.set(spawnOrigin);
        savePlayer.angles.setTo(0, Number(spawnRecord.angle ?? 0), 0);
        savePlayer.health = 87;
        savePlayer.armorvalue = 25;
        savePlayer.ammo_shells = 12;
        savePlayer.ammo_rockets = 3;

        saveGameAPI.worldspawn = saveWorldspawn;
        saveGameAPI.lastspawn = savePlayer;

        sv.server.gameAPI = saveGameAPI;
        sv.server.num_edicts = saveEdicts.length;
        sv.server.edicts = saveEdicts;
        sv.svs.clients[0].edict = saveEdicts[1];

        const spawnParms = savePlayer.saveSpawnParameters();
        sv.svs.clients[0].spawn_parms = spawnParms;

        await withMockCvarStatics({
          filterCvars: savedCvars,
          lookupCvars: currentCvarLookup,
        }, async () => {
          await runConsoleCommand(ClientHost.Savegame_f, { client: null }, 'integration/e1m1');
          await runConsoleCommand(ClientHost.Loadgame_f, { client: null }, 'integration/e1m1');
        });

        const freshSaveGameAPI = sv.server.gameAPI;
        const freshWorldspawn = sv.server.edicts[0].entity;
        const freshPlayer = sv.server.edicts[1].entity;

        assert.ok(freshSaveGameAPI !== null);
        assert.ok(freshWorldspawn instanceof WorldspawnEntity);
        assert.ok(freshPlayer instanceof PlayerEntity);
        assert.equal(freshSaveGameAPI.worldspawn, freshWorldspawn);
        assert.equal(freshSaveGameAPI.lastspawn, freshPlayer);
        assert.equal(sv.server.time, 73.25);
        assert.equal(freshSaveGameAPI.time, 73.25);
        assert.equal(freshSaveGameAPI.framecount, 17);
        assert.equal(freshSaveGameAPI.nextmap, 'e1m2');
        assert.equal(sv.svs.clients[0].spawn_parms, spawnParms);
        assert.equal(freshPlayer.health, 87);
        assert.equal(freshPlayer.armorvalue, 25);
        assert.equal(freshPlayer.ammo_shells, 12);
        assert.equal(freshPlayer.ammo_rockets, 3);
        assert.deepEqual([...freshPlayer.origin], [...spawnOrigin]);
        assert.equal(freshPlayer.saveSpawnParameters(), spawnParms);
        assert.deepEqual(resumes, [{
          clientdata: JSON.stringify({ hud: 'integration-client' }),
          particles: [],
          clientEntities: [],
        }]);
      });
    } finally {
      ClientLifecycle.resumeGame = previousResumeGame;
      restoreEngineMocks();
      ServerGameAPI._cvars = previousServerGameCvars;

      for (const name of Object.keys(Mod.known)) {
        if (!knownKeysBefore.has(name)) {
          delete Mod.known[name];
        }
      }
    }
  });
});
