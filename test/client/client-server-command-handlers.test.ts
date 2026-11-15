import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Def from '../../source/engine/common/Def.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import { parseServerMessage } from '../../source/engine/client/ClientServerCommandHandlers.ts';
import GameModule from '../../source/engine/common/GameModule.ts';
import { installPageServices } from '../../source/engine/client/PageServices.ts';
import { createClientEngineApi } from '../support/clientEngineApi.ts';
import '../support/consoleBridge.ts';
import { clientPmove } from '../../source/engine/client/ClientPhysics.ts';
import { MoveVars } from '../../source/engine/common/Pmove.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { createBoundsModel, createGameModuleStub } from '../support/fixtures.ts';
import ClientEntities, { type ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import Vector from '../../source/shared/Vector.ts';
import { ServerEntityState } from '../../source/engine/server/ServerEntityState.ts';
import { ServerMessages } from '../../source/engine/server/ServerMessages.ts';
import type Server from '../../source/engine/server/Server.ts';
import { engineMocks } from '../support/engineMocks.ts';
import { withEngineMocks } from '../support/withEngineMocks.ts';

/** The engine parts the server message handlers read, as the tests mock them. */
interface MockClientRegistry {
  CL: { connection: { processingServerDataState: number; lastServerMessages: string[] }; [member: string]: unknown };
  Con: object;
  Host: object;
  Mod: object;
  NET: { message: SzBuffer };
  R: object;
  S: object;
  SCR: object;
  V: object;
}

/**
 * Builds the minimal client registry surface required by parseServerMessage().
 * @param [overrides] Registry overrides for the test case.
 * @returns Mocked registry values.
 */
function createMockClientRegistry(overrides: { [Part in keyof MockClientRegistry]?: object } = {}): MockClientRegistry {
  const message = new SzBuffer(256, 'NET.message');

  return {
    CL: {
      shownet: { value: 0 },
      state: {
        onground: true,
      },
      connection: {
        processingServerDataState: 0,
        lastServerMessages: [],
      },
      cls: {
        state: Def.clientConnectionState.connected,
        signon: 0,
      },
      svc_strings: Object.entries(Protocol.svc),
      PrintLastServerMessages() {},
      SignonReply() {},
      ...overrides.CL,
    },
    Con: {
      Print() {},
      DPrint() {},
      ...overrides.Con,
    },
    Host: {
      ...overrides.Host,
    },
    Mod: {
      ...overrides.Mod,
    },
    NET: {
      message,
      ...overrides.NET,
    },
    R: {
      ...overrides.R,
    },
    S: {
      ...overrides.S,
    },
    SCR: {
      recalc_refdef: false,
      ...overrides.SCR,
    },
    V: {
      ...overrides.V,
    },
  };
}

/**
 * Runs a test body with a mocked client registry and restores it afterwards.
 * @param mockedRegistry Registry overrides.
 * @param callback Test body.
 * @returns Callback result.
 */
function withMockClientRegistry(mockedRegistry: ReturnType<typeof createMockClientRegistry>, callback: () => void | Promise<void>): void | Promise<void> {
  const { CL, Con, Host, Mod, NET, R, S, SCR, V } = mockedRegistry;

  return withEngineMocks({ CL, Con, Host, Mod, NET, R, S, SCR, V }, callback);
}

void describe('parseServerMessage', () => {
  void test('rejects Protocol 15 serverdata payloads', () => {
    const mockedRegistry = createMockClientRegistry();
    const { message } = mockedRegistry.NET;

    message.writeByte(Protocol.svc.serverdata);
    message.writeLong(15);

    void withMockClientRegistry(mockedRegistry, () => {
      assert.throws(
        () => { parseServerMessage(); },
        /Protocol 15 \/ WinQuake serverdata is no longer supported\./,
      );

      assert.equal((engineMocks.SCR as { recalc_refdef: boolean }).recalc_refdef, true);
      assert.deepEqual(mockedRegistry.CL.connection.lastServerMessages, ['serverdata']);
    });
  });
});

void describe('svc.cvar', () => {
  void test('sets the movement variables prediction uses from the server cvars', () => {
    const mockedRegistry = createMockClientRegistry({ CL: { cls: { state: Def.clientConnectionState.connected, signon: 4, serverInfo: {} } } });
    const { message } = mockedRegistry.NET;
    const previousMoveVars = clientPmove.movevars;

    message.writeByte(Protocol.svc.cvar);
    message.writeByte(3);
    message.writeString('sv_gravity');
    message.writeString('100');
    message.writeString('sv_friction');
    message.writeString('9');
    message.writeString('teamplay');
    message.writeString('1');

    clientPmove.movevars = new MoveVars();

    try {
      void withMockClientRegistry(mockedRegistry, () => {
        parseServerMessage();
      });

      assert.equal(clientPmove.movevars.gravity, 100);
      assert.equal(clientPmove.movevars.friction, 9);
      assert.equal(clientPmove.movevars.maxspeed, 320, 'a variable that was not sent keeps its value');
    } finally {
      clientPmove.movevars = previousMoveVars;
    }
  });
});

void describe('svc.spawnstatic', () => {
  /**
   * Sends one static entity wearing a model and returns what the client made of it.
   * @param random Whether the model asks for a random sync base.
   * @returns The entity the client allocated.
   */
  function spawnStaticWithModel(random: boolean, sequenceBlock: { sequence?: number; animtime?: number; framerate?: number } | null = null): ClientEdict | null {
    const mockedRegistry = createMockClientRegistry();
    const { message } = mockedRegistry.NET;
    const model = createBoundsModel(new Vector(-8, -8, -8), new Vector(8, 8, 8), 'gfx/flame.gif');
    const previousClientEntities = clientRuntimeState.clientEntities;
    const previousModels = clientRuntimeState.model_precache;
    const clientEntities = new ClientEntities();
    const allocate = clientEntities.allocateStaticEntity.bind(clientEntities);
    let spawned: ClientEdict | null = null;

    model.random = random;
    clientEntities.allocateStaticEntity = (classname: string): ClientEdict => {
      spawned = allocate(classname);
      return spawned;
    };
    clientRuntimeState.clientEntities = clientEntities;
    clientRuntimeState.model_precache = [model, model];

    message.writeByte(Protocol.svc.spawnstatic);
    message.writeString('light_flame_small_yellow');
    message.writeByte(1);
    message.writeByte(0);
    message.writeByte(0);
    message.writeByte(0);
    message.writeByte(0);
    message.writeByte(255);
    message.writeByte(0);

    const { sequence, animtime, framerate } = sequenceBlock ?? {};

    message.writeByte((sequence !== undefined ? Protocol.sequenceField.sequence : 0)
      | (animtime !== undefined ? Protocol.sequenceField.animtime : 0)
      | (framerate !== undefined ? Protocol.sequenceField.framerate : 0));

    if (sequence !== undefined) {
      message.writeShort(sequence);
    }

    if (animtime !== undefined) {
      message.writeFloat(animtime);
    }

    if (framerate !== undefined) {
      message.writeFloat(framerate);
    }

    message.writeAngleVector(new Vector(0, 0, 0));
    message.writeCoordVector(new Vector(16, 32, 48));

    try {
      void withMockClientRegistry(mockedRegistry, () => {
        parseServerMessage();
      });

      return spawned;
    } finally {
      clientRuntimeState.clientEntities = previousClientEntities;
      clientRuntimeState.model_precache = previousModels;
    }
  }

  void test('gives a static entity with a random-phase model its own sync base', () => {
    const syncbases = new Set<number>();

    for (let i = 0; i < 8; i++) {
      const entity = spawnStaticWithModel(true);
      assert.ok(entity);
      syncbases.add(entity.syncbase);
    }

    assert.ok(syncbases.size > 1, 'eight flames do not all start in step');
    assert.ok([...syncbases].every((syncbase) => syncbase >= 0 && syncbase < 1));
  });

  void test('leaves the sync base at zero for a model that is not random', () => {
    assert.equal(spawnStaticWithModel(false)?.syncbase, 0);
  });

  void test('takes the sequence block the server sends, whatever the client clock stamped for the model', () => {
    const previousTime = clientRuntimeState.time;
    clientRuntimeState.time = 3;

    try {
      const entity = spawnStaticWithModel(false, { sequence: 2, animtime: 12.5, framerate: 0.5 });

      assert.equal(entity?.sequence, 2);
      assert.equal(entity?.animtime, 12.5);
      assert.equal(entity?.framerate, 0.5);
    } finally {
      clientRuntimeState.time = previousTime;
    }
  });

  void test('a block without a start time leaves the client\'s own stamp, which is how a decoration always started', () => {
    const previousTime = clientRuntimeState.time;
    clientRuntimeState.time = 3;

    try {
      const entity = spawnStaticWithModel(false, { sequence: 1 });

      assert.equal(entity?.sequence, 1);
      assert.equal(entity?.animtime, 3);
      assert.equal(entity?.framerate, 1);
    } finally {
      clientRuntimeState.time = previousTime;
    }
  });

  void test('without a block plays no sequence and starts at the client clock, as a decoration always did', () => {
    const previousTime = clientRuntimeState.time;
    clientRuntimeState.time = 3;

    try {
      const entity = spawnStaticWithModel(false);

      assert.equal(entity?.sequence, -1);
      assert.equal(entity?.framerate, 1);
      assert.equal(entity?.animtime, 3);
    } finally {
      clientRuntimeState.time = previousTime;
    }
  });
});

void describe('svc.deltapacketentities attachment', () => {
  /**
   * Sends what the server's writer makes of a state change to the client's parser.
   * @param changes One change per update of the packet, applied to entity 7 in turn.
   * @returns The registry the client keeps.
   */
  function roundTrip(changes: Array<Partial<ServerEntityState>>): ClientEntities {
    const mockedRegistry = createMockClientRegistry();
    const { message } = mockedRegistry.NET;
    const previousClientEntities = clientRuntimeState.clientEntities;
    const clientEntities = new ClientEntities();
    const messages = new ServerMessages({ server: { time: 1, clientEntityFields: {} } } as unknown as Server);
    let state = new ServerEntityState(7);

    clientRuntimeState.clientEntities = clientEntities;
    message.writeByte(Protocol.svc.deltapacketentities);

    for (const change of changes) {
      const next = new ServerEntityState(7);

      next.set(state);
      Object.assign(next, change);
      messages.writeDeltaEntity(message, state, next);
      state = next;
    }

    message.writeUint16(0);

    try {
      void withMockClientRegistry(mockedRegistry, () => {
        parseServerMessage();
      });

      return clientEntities;
    } finally {
      clientRuntimeState.clientEntities = previousClientEntities;
    }
  }

  void test('carries the parent and the tag from the server writer to the client entity, as the client\'s own entity of that number', () => {
    const clientEntities = roundTrip([{ attachmentParent: 3, attachmentTag: 12 }]);
    const entity = clientEntities.getEntity(7);

    assert.equal(entity.attachmentParent, clientEntities.getEntity(3));
    assert.equal(entity.attachmentTag, 12);
    assert.equal(entity.attachmentTagName, null);
  });

  void test('a detach lets go of the parent, and an update without the bit leaves the attachment alone', () => {
    // The frame update after the attachment must be read from where the attachment ended: a reader that is off by a
    // byte gets the wrong frame, or runs into the terminator.
    const attached = roundTrip([{ attachmentParent: 3, attachmentTag: 12 }, { frame: 17 }]).getEntity(7);

    assert.notEqual(attached.attachmentParent, null);
    assert.equal(attached.frame, 17);

    const detached = roundTrip([{ attachmentParent: 3, attachmentTag: 12 }, { attachmentParent: 0, attachmentTag: -1 }]).getEntity(7);

    assert.equal(detached.attachmentParent, null);
    assert.equal(detached.attachmentTag, -1);
  });
});

void describe('svc.deltapacketentities sequence block', () => {
  /**
   * Sends what the server's writer makes of a state change to the client's parser.
   * @param changes One change per update of the packet, applied to the same entity in turn.
   * @returns The entity the client keeps.
   */
  function roundTrip(changes: Array<Partial<ServerEntityState>>): ClientEdict {
    const mockedRegistry = createMockClientRegistry();
    const { message } = mockedRegistry.NET;
    const previousClientEntities = clientRuntimeState.clientEntities;
    const clientEntities = new ClientEntities();
    const messages = new ServerMessages({ server: { time: 1, clientEntityFields: {} } } as unknown as Server);
    let state = new ServerEntityState(7);

    clientRuntimeState.clientEntities = clientEntities;
    message.writeByte(Protocol.svc.deltapacketentities);

    for (const change of changes) {
      const next = new ServerEntityState(7);

      next.set(state);
      Object.assign(next, change);
      messages.writeDeltaEntity(message, state, next);
      state = next;
    }

    message.writeUint16(0);

    try {
      void withMockClientRegistry(mockedRegistry, () => {
        parseServerMessage();
      });

      return clientEntities.getEntity(7);
    } finally {
      clientRuntimeState.clientEntities = previousClientEntities;
    }
  }

  void test('carries the sequence, the start time and the speed from the server writer to the client entity', () => {
    const entity = roundTrip([{ sequence: 5, animtime: 321.75, framerate: 1.5 }]);

    assert.equal(entity.sequence, 5);
    assert.equal(entity.animtime, 321.75);
    assert.equal(entity.framerate, 1.5);
  });

  void test('a restart is a new start time on the same sequence, which the client takes over as it comes', () => {
    const entity = roundTrip([{ sequence: 5, animtime: 10 }, { animtime: 14.5 }]);

    assert.equal(entity.sequence, 5);
    assert.equal(entity.animtime, 14.5);
  });

  void test('a sequence change without a start time keeps the client\'s own stamp, for a game that does not set one', () => {
    const previousTime = clientRuntimeState.time;
    clientRuntimeState.time = 6;

    try {
      const entity = roundTrip([{ sequence: 2 }]);

      assert.equal(entity.sequence, 2);
      assert.equal(entity.animtime, 6);
    } finally {
      clientRuntimeState.time = previousTime;
    }
  });

  void test('does not touch the sequence of an update that has no block, and the update still parses to its end', () => {
    // The frame update after the block must be read from where the block ended; a reader that is off by a byte
    // gets the wrong frame, or runs into the terminator.
    const entity = roundTrip([{ sequence: 5, animtime: 10 }, { frame: 17 }]);

    assert.equal(entity.sequence, 5);
    assert.equal(entity.animtime, 10);
    assert.equal(entity.frame, 17);
  });

  void test('reads the block in the place the writer put it, before the nextthink byte that follows', () => {
    const entity = roundTrip([{ sequence: 2, animtime: 5.5, frame: 4, nextthink: 1.2 }]);

    assert.equal(entity.sequence, 2);
    assert.equal(entity.animtime, 5.5);
    assert.equal(entity.frame, 4);
    assert.ok(entity.lerpEndTime > 0, 'the nextthink byte was read where it was written');
  });

  void test('a game that sets the sequence back to none sends -1', () => {
    const entity = roundTrip([{ sequence: 5 }, { sequence: -1 }]);

    assert.equal(entity.sequence, -1);
  });
});

/**
 * Builds a client game class that records how the engine drives it.
 * @param [options] Whether IsServerCompatible accepts the server.
 * @returns The class and its call records.
 */
function createRecordingClientGame({ compatible = true }: { compatible?: boolean } = {}): { ClientGameAPI: new (engineAPI: object) => object, constructedWith: object[], compatibilityChecks: number[][] } {
  const constructedWith: object[] = [];
  const compatibilityChecks: number[][] = [];

  class RecordingClientGameAPI {
    constructor(engineAPI: object) {
      constructedWith.push(engineAPI);
    }

    static IsServerCompatible(version: number[]) {
      compatibilityChecks.push(version);
      return compatible;
    }
  }

  return { ClientGameAPI: RecordingClientGameAPI, constructedWith, compatibilityChecks };
}

/**
 * Runs a callback with the given game module installed as the active one.
 * @param clientGameAPI The ClientGameAPI class the module exports.
 * @param callback Test body.
 */
function withActiveGameModule(clientGameAPI: object, callback: () => void): void {
  const previous = GameModule.active;

  GameModule.active = createGameModuleStub({ ClientGameAPI: clientGameAPI });

  try {
    callback();
  } finally {
    GameModule.active = previous;
  }
}

/**
 * Writes a serverdata message up to and including maxclients into the mocked network buffer.
 * @param message The mocked NET.message buffer.
 * @param [options] Game identification the server announces.
 */
function writeServerData(message: SzBuffer, { name = 'Test Game', author = 'test' } = {}) {
  message.writeByte(Protocol.svc.serverdata);
  message.writeByte(Protocol.version);
  message.writeString(name);
  message.writeString(author);
  message.writeByte(1); // server game version 1.0.0
  message.writeByte(0);
  message.writeByte(0);
  message.writeByte(0); // maxclients: invalid on purpose, it aborts parsing right after the game was constructed
}

void describe('parseServerMessage serverdata game construction', () => {
  void test('constructs the client game with the engine API after the server passed the compatibility check', () => {
    const { ClientGameAPI, constructedWith, compatibilityChecks } = createRecordingClientGame();
    const mockedRegistry = createMockClientRegistry({
      CL: { ClearState() {}, state: { onground: true, gameAPI: null, maxclients: 0 } },
    });

    writeServerData(mockedRegistry.NET.message);

    let gameAPI: unknown = null;

    const engineApi = createClientEngineApi();
    const restorePageServices = installPageServices({ engineApi });

    try {
      void withMockClientRegistry(mockedRegistry, () => {
        withActiveGameModule(ClientGameAPI, () => {
          assert.throws(() => { parseServerMessage(); }, /Bad maxclients \(0\)/);
          gameAPI = clientRuntimeState.gameAPI;
        });
      });
    } finally {
      restorePageServices();
    }

    assert.deepEqual(compatibilityChecks, [[1, 0, 0]]);
    assert.equal(constructedWith.length, 1);
    assert.equal(constructedWith[0], engineApi);
    assert.ok(gameAPI instanceof ClientGameAPI);
  });

  void test('rejects an incompatible server before constructing the client game', () => {
    const { ClientGameAPI, constructedWith } = createRecordingClientGame({ compatible: false });
    const mockedRegistry = createMockClientRegistry({
      CL: { ClearState() {}, state: { onground: true, gameAPI: null, maxclients: 0 } },
    });

    writeServerData(mockedRegistry.NET.message);

    void withMockClientRegistry(mockedRegistry, () => {
      withActiveGameModule(ClientGameAPI, () => {
        assert.throws(() => { parseServerMessage(); }, /is not compatible/);
      });
    });

    assert.equal(constructedWith.length, 0);
    assert.equal((mockedRegistry.CL.state as { gameAPI: unknown }).gameAPI, null);
  });

  void test('rejects a server running a different game before asking for compatibility or constructing', () => {
    const { ClientGameAPI, constructedWith, compatibilityChecks } = createRecordingClientGame();
    const mockedRegistry = createMockClientRegistry({
      CL: { ClearState() {}, state: { onground: true, gameAPI: null, maxclients: 0 } },
    });

    writeServerData(mockedRegistry.NET.message, { name: 'Another Game' });

    void withMockClientRegistry(mockedRegistry, () => {
      withActiveGameModule(ClientGameAPI, () => {
        assert.throws(() => { parseServerMessage(); }, /game mismatch/);
      });
    });

    assert.deepEqual(compatibilityChecks, []);
    assert.equal(constructedWith.length, 0);
  });
});
