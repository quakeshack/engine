import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import COMClass from '../../source/engine/common/Com.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import Host from '../../source/engine/common/Host.ts';
import * as Def from '../../source/engine/common/Def.ts';
import Mod from '../../source/engine/common/Mod.ts';
import ClientLifecycle from '../../source/engine/client/ClientLifecycle.ts';
import { ServerEdict } from '../../source/engine/server/Edict.ts';
import NodeCOM from '../../source/engine/server/Com.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import { Serializer } from '../../source/game/id1/helper/MiscHelpers.ts';
import { cvarFlags } from '../../source/shared/Defs.ts';
import Vector from '../../source/shared/Vector.ts';

import { defaultMockRegistry, withMockRegistry } from '../physics/fixtures.mjs';

const [{ ServerGameAPI }, { PlayerEntity }, { WorldspawnEntity }] = await Promise.all([
  import('../../source/game/id1/GameAPI.ts'),
  import('../../source/game/id1/entity/Player.ts'),
  import('../../source/game/id1/entity/Worldspawn.ts'),
]);

/**
 *
 */
function createMockConsole() {
  const messages = {
    print: [],
    warning: [],
    error: [],
    success: [],
    debug: [],
  };

  return {
    messages,
    Con: {
      Print(message) {
        messages.print.push(message);
      },
      DPrint(message) {
        messages.debug.push(message);
      },
      PrintWarning(message) {
        messages.warning.push(message);
      },
      PrintError(message) {
        messages.error.push(message);
      },
      PrintSuccess(message) {
        messages.success.push(message);
      },
    },
  };
}

/**
 *
 * @param name
 * @param string
 * @param flags
 */
function createMockCvar(name, string, flags = cvarFlags.NONE) {
  const value = Number(string);

  return {
    name,
    string,
    flags,
    value,
    lastSet: null,
    set(value) {
      this.lastSet = value;
      this.string = String(value);
      this.value = Number(value);
    },
  };
}

/**
 *
 * @param root0
 * @param root0.classname
 * @param root0.edictId
 * @param root0.serializedData
 * @param root0.onDeserialize
 */
function createMockEntity({ classname, edictId, serializedData = {}, onDeserialize = null }) {
  return {
    classname,
    edictId,
    lastDeserializedData: null,
    serialize() {
      return serializedData;
    },
    deserialize(data) {
      if (onDeserialize !== null) {
        onDeserialize(data);
      }

      this.lastDeserializedData = data;
      Object.assign(this, data);
    },
  };
}

/**
 *
 * @param num
 * @param entity
 * @param root0
 * @param root0.onFree
 * @param root0.onLink
 */
function createMockEdict(num, entity = null, { onFree = null, onLink = null } = {}) {
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

/**
 *
 * @param edicts
 * @param root0
 * @param root0.worldspawn
 * @param root0.callOrder
 */
function createSerializableGameAPI(edicts, { worldspawn = null, callOrder = [] } = {}) {
  const engine = {
    GetEdictById(edictId) {
      return edicts[edictId] ?? null;
    },
  };

  const gameAPI = {
    worldspawn,
    serialize() {
      return this._serializer.serialize();
    },
    deserialize(data) {
      callOrder.push('globals-deserialize');
      this._serializer.deserialize(data);
    },
    prepareEntity(edict, classname) {
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
  };

  Serializer.makeSerializable(gameAPI, engine, ['worldspawn']);
  return gameAPI;
}

/**
 *
 * @param root0
 * @param root0.filterCvars
 * @param root0.lookupCvars
 * @param callback
 */
function withMockCvarStatics({ filterCvars = [], lookupCvars = {} } = {}, callback) {
  const previousFilter = Cvar.Filter;
  const previousFindVar = Cvar.FindVar;

  Cvar.Filter = function* Filter(compareFn) {
    for (const cvar of filterCvars) {
      if (compareFn(cvar)) {
        yield cvar;
      }
    }
  };

  Cvar.FindVar = (name) => lookupCvars[name] ?? null;

  const restore = () => {
    Cvar.Filter = previousFilter;
    Cvar.FindVar = previousFindVar;
  };

  try {
    const result = callback();

    if (result !== null && result !== undefined && typeof result.then === 'function') {
      return Promise.resolve(result).finally(restore);
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
 * @param {string} text entity lump text
 * @returns {Record<string, string>[]} parsed entity records
 */
function parseMapEntities(text) {
  /** @type {Record<string, string>[]} */
  const entities = [];
  let data = text;

  while (data !== null) {
    let parsed = COMClass.Parse(data);
    data = parsed.data;

    if (parsed.token.length === 0) {
      break;
    }

    if (parsed.token !== '{') {
      continue;
    }

    /** @type {Record<string, string>} */
    const entity = {};

    while (true) {
      parsed = COMClass.Parse(data);
      data = parsed.data;

      if (parsed.token === '}') {
        entities.push(entity);
        break;
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
 * @param {string} origin origin text from the entity lump
 * @returns {Vector} parsed origin
 */
function parseMapOrigin(origin) {
  const components = origin.split(/\s+/).map(Number);
  return new Vector(components[0], components[1], components[2]);
}

/**
 * Find a map entity matching the predicate.
 * @param {Record<string, string>[]} entities parsed entity records
 * @param {(entity: Record<string, string>) => boolean} predicate entity predicate
 * @param {string} label label for the error message
 * @returns {Record<string, string>} matching entity record
 */
function requireMapEntity(entities, predicate, label) {
  const entity = entities.find(predicate);

  if (entity === undefined) {
    throw new Error(`Could not find ${label} in entity lump`);
  }

  return entity;
}

/**
 * Create a small engine surface for real id1 server entity tests.
 * @param {() => ServerEdict[]} getEdicts function that returns the active edict array
 * @returns {object} minimal engine API
 */
function createIntegrationEngineAPI(getEdicts) {
  const cvars = {
    teamplay: createMockCvar('teamplay', '0'),
    sv_gravity: createMockCvar('sv_gravity', '800'),
    sv_nextmap: createMockCvar('sv_nextmap', ''),
  };

  return {
    GetCvar(name) {
      return cvars[name] ?? null;
    },
    RegisterCvar(name, value, flags = 0) {
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
    GetEdictById(edictId) {
      return getEdicts()[edictId] ?? null;
    },
  };
}

void describe('Host.Savegame_f', () => {
  void test('writes a save payload with serialized globals, edicts, and filtered cvars', () => {
    const consoleCapture = createMockConsole();
    const writes = [];
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
      WriteTextFile(filename, data) {
        writes.push({ filename, data });
        return true;
      },
      LoadTextFile() {
        return null;
      },
    };

    const previousRegistry = {
      CL: registry.CL,
      COM: registry.COM,
      Con: registry.Con,
      R: registry.R,
      SV: registry.SV,
      isDedicatedServer: registry.isDedicatedServer,
    };
    const previousFilter = Cvar.Filter;

    registry.CL = {
      state: {
        intermission: 0,
        levelname: 'E1M1',
        gameAPI: clientGameAPI,
      },
    };
    registry.COM = mockCOM;
    registry.Con = consoleCapture.Con;
    registry.R = renderer;
    registry.SV = sv;
    registry.isDedicatedServer = false;
    eventBus.publish('registry.frozen');

    Cvar.Filter = function* Filter(compareFn) {
      for (const cvar of filterCvars) {
        if (compareFn(cvar)) {
          yield cvar;
        }
      }
    };

    try {
      Host.Savegame_f.call({ client: null }, 'save/e1m1');
    } finally {
      Cvar.Filter = previousFilter;
      registry.CL = previousRegistry.CL;
      registry.COM = previousRegistry.COM;
      registry.Con = previousRegistry.Con;
      registry.R = previousRegistry.R;
      registry.SV = previousRegistry.SV;
      registry.isDedicatedServer = previousRegistry.isDedicatedServer;
      eventBus.publish('registry.frozen');
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
    assert.deepEqual(consoleCapture.messages.warning, []);
    assert.deepEqual(consoleCapture.messages.error, []);
    assert.deepEqual(consoleCapture.messages.success, ['done.\n']);
  });
});

void describe('Host.Loadgame_f', () => {
  void test('restores prepared edicts before global entity references', async () => {
    const consoleCapture = createMockConsole();
    const callOrder = [];
    const resumes = [];
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
        gameAPI: null,
        gameVersion: null,
        mapname: null,
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
      SpawnServer: async (mapname) => {
        callOrder.push(`spawn:${mapname}`);
        sv.server.active = true;
        sv.server.gameAPI = gameAPI;
        sv.server.gameVersion = 'test-game';
        sv.server.mapname = mapname;
        return true;
      },
      ShutdownServer() { },
    };
    const client = {
      cls: { demonum: 0 },
      Disconnect() { },
      SetConnectingStep() { },
    };
    const mockCOM = {
      DefaultExtension: COMClass.DefaultExtension,
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

    try {
      await withMockRegistry({
        ...defaultMockRegistry(sv, client),
        COM: mockCOM,
        Con: consoleCapture.Con,
      }, async () => {
        await withMockCvarStatics({
          lookupCvars: {
            sv_gravity: gravityCvar,
          },
        }, async () => {
          await Host.Loadgame_f.call({ client: null }, 'save/e1m1');
        });
      });
    } finally {
      ClientLifecycle.resumeGame = previousResumeGame;
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
    assert.deepEqual(edicts[0].entity.lastDeserializedData, { health: 100 });
    assert.deepEqual(edicts[1].entity.lastDeserializedData, { health: 42 });
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
      SpawnServer: async () => {
        spawnCalls += 1;
        return true;
      },
      ShutdownServer() { },
    };
    const client = {
      cls: { demonum: 0 },
      Disconnect() { },
      SetConnectingStep() { },
    };
    const mockCOM = {
      DefaultExtension: COMClass.DefaultExtension,
      WriteTextFile() {
        return true;
      },
      LoadTextFile() {
        return '{';
      },
    };

    await withMockRegistry({
      ...defaultMockRegistry(sv, client),
      COM: mockCOM,
      Con: consoleCapture.Con,
    }, async () => {
      await assert.rejects(
        Host.Loadgame_f.call({ client: null }, 'broken-save'),
        (error) => error instanceof Error && error.message.includes('is corrupted or unreadable'),
      );
    });

    assert.equal(spawnCalls, 0);
    assert.deepEqual(consoleCapture.messages.error, []);
  });

  void test('throws when the save file needs more edicts than the server allocated', async () => {
    const consoleCapture = createMockConsole();
    const callOrder = [];
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
        gameAPI: null,
        gameVersion: null,
        mapname: null,
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
      SpawnServer: async (mapname) => {
        spawnCalls += 1;
        sv.server.active = true;
        sv.server.gameAPI = gameAPI;
        sv.server.gameVersion = 'test-game';
        sv.server.mapname = mapname;
        return true;
      },
      ShutdownServer() { },
    };
    const client = {
      cls: { demonum: 0 },
      Disconnect() { },
      SetConnectingStep() { },
    };
    const mockCOM = {
      DefaultExtension: COMClass.DefaultExtension,
      WriteTextFile() {
        return true;
      },
      LoadTextFile() {
        return JSON.stringify(savegame);
      },
    };

    await withMockRegistry({
      ...defaultMockRegistry(sv, client),
      COM: mockCOM,
      Con: consoleCapture.Con,
    }, async () => {
      await assert.rejects(
        Host.Loadgame_f.call({ client: null }, 'save/e1m1'),
        (error) => error instanceof Error && error.message.includes('needs 3 edicts but the server only allocated 2'),
      );
    });

    assert.equal(spawnCalls, 1);
    assert.deepEqual(callOrder, []);
    assert.deepEqual(consoleCapture.messages.error, []);
  });
});

void describe('Host.save/load integration', () => {
  void test('round-trips real id1 worldspawn and player entities on E1M1', async () => {
    const consoleCapture = createMockConsole();
    const knownKeysBefore = new Set(Object.keys(Mod.known));
    const resumes = [];
    const previousRenderer = registry.R;
    const previousIsDedicatedServer = registry.isDedicatedServer;
    const previousServerGameCvars = ServerGameAPI._cvars;
    const previousSys = registry.Sys;
    const previousSearchpaths = COMClass.searchpaths;
    const previousGamedir = COMClass.gamedir;
    const savedCvars = [
      createMockCvar('sv_gravity', '800', cvarFlags.SERVER),
      createMockCvar('skill', '2', cvarFlags.GAME),
    ];
    const currentCvarLookup = {
      sv_gravity: savedCvars[0],
      skill: savedCvars[1],
    };
    /** @type {ServerEdict[]} */
    let currentEdicts = [];
    let savedText = null;

    ServerGameAPI._cvars = {
      nomonster: createMockCvar('nomonster', '0'),
      fraglimit: createMockCvar('fraglimit', '0'),
      timelimit: createMockCvar('timelimit', '0'),
      samelevel: createMockCvar('samelevel', '0'),
      noexit: createMockCvar('noexit', '0'),
      skill: createMockCvar('skill', '2'),
      deathmatch: createMockCvar('deathmatch', '0'),
      coop: createMockCvar('coop', '0'),
    };
    registry.R = {
      SerializeParticles() {
        return [];
      },
    };
    registry.Sys = {
      Print() { },
    };
    registry.isDedicatedServer = true;
    eventBus.publish('registry.frozen');

    const engineAPI = createIntegrationEngineAPI(() => currentEdicts);
    const mockCOM = {
      Parse: COMClass.Parse,
      DefaultExtension: COMClass.DefaultExtension,
      async LoadFile(name) {
        return NodeCOM.LoadFile(name);
      },
      async LoadTextFile(name) {
        if (name.endsWith('.json')) {
          return savedText;
        }

        return null;
      },
      WriteTextFile(filename, data) {
        if (!filename.endsWith('.json')) {
          return false;
        }

        savedText = data;
        return true;
      },
    };
    const sv = {
      server: {
        active: true,
        paused: false,
        loadgame: false,
        gameAPI: null,
        gameVersion: 'integration-test',
        mapname: 'e1m1',
        time: 73.25,
        lightstyles: ['m'],
        num_edicts: 0,
        edicts: [],
      },
      svs: {
        maxclients: 1,
        clients: [
          {
            state: 3,
            spawn_parms: null,
            edict: null,
          },
        ],
      },
      area: {
        linkEdict() { },
        unlinkEdict() { },
      },
      SpawnServer: async (mapname) => {
        const freshEdicts = [new ServerEdict(0), new ServerEdict(1), new ServerEdict(2)];
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
      state: {
        intermission: 0,
        levelname: 'E1M1',
        gameAPI: {
          saveGame() {
            return JSON.stringify({ hud: 'integration-client' });
          },
        },
      },
    };
    const previousResumeGame = ClientLifecycle.resumeGame;

    ClientLifecycle.resumeGame = (clientdata, particles) => {
      resumes.push({ clientdata, particles });
    };

    try {
      await withMockRegistry({
        ...defaultMockRegistry(sv, client),
        COM: mockCOM,
        Con: consoleCapture.Con,
        Mod,
        R: {
          SerializeParticles() {
            return [];
          },
        },
        isDedicatedServer: true,
      }, async () => {
        // Load the real id1 pak metadata so maps/e1m1.bsp resolves through COM.
        COMClass.searchpaths = [];
        COMClass.gamedir = null;
        await NodeCOM.AddGameDirectory('id1');

        Mod.Init();

        const model = await Mod.ForNameAsync('maps/e1m1.bsp', true);
        assert.ok(model !== null);

        const entities = parseMapEntities(model.entities);
        const spawnRecord = requireMapEntity(
          entities,
          (entity) => entity.classname === 'info_player_start',
          'spawn entity classname=info_player_start',
        );
        const spawnOrigin = parseMapOrigin(spawnRecord.origin);

        const saveEdicts = [new ServerEdict(0), new ServerEdict(1), new ServerEdict(2)];
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
          assert.equal(Host.Savegame_f.call({ client: null }, 'integration/e1m1'), undefined);
          await Host.Loadgame_f.call({ client: null }, 'integration/e1m1');
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
        }]);
      });
    } finally {
      ClientLifecycle.resumeGame = previousResumeGame;
      COMClass.searchpaths = previousSearchpaths;
      COMClass.gamedir = previousGamedir;
      registry.R = previousRenderer;
      registry.Sys = previousSys;
      registry.isDedicatedServer = previousIsDedicatedServer;
      ServerGameAPI._cvars = previousServerGameCvars;
      eventBus.publish('registry.frozen');

      for (const name of Object.keys(Mod.known)) {
        if (!knownKeysBefore.has(name)) {
          delete Mod.known[name];
        }
      }
    }
  });
});
