import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import * as Protocol from '../../source/engine/network/Protocol.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';
import { ServerEntityState } from '../../source/engine/server/ServerEntityState.ts';
import { ServerMessages } from '../../source/engine/server/ServerMessages.ts';
import Vector from '../../source/shared/Vector.ts';
import type Server from '../../source/engine/server/Server.ts';
import type { ServerEdict } from '../../source/engine/server/Edict.ts';
import type { BrushModel, Visibility } from '../../source/engine/common/model/BSP.ts';
import { createTestServer } from '../support/fixtures.ts';
import { installEngineMocks } from '../support/withEngineMocks.ts';

/**
 * Installs a minimal server context for delta-entity message tests.
 * @returns The server, and a function that puts the mocked engine parts back.
 */
function installWriteDeltaEntityContext(): { sv: Server; restore: () => void } {
  const restoreEngineMocks = installEngineMocks({
    Con: { Print() {}, DPrint() {}, PrintWarning() {} },
    Host: { frametime: 0.1 },
  });

  const sv = createTestServer();

  sv.server.time = 1;
  sv.server.gameCapabilities = [];
  sv.server.clientEntityFields = {};

  return {
    sv,
    restore: restoreEngineMocks,
  };
}

void describe('ServerMessages.writeDeltaEntity', () => {
  void test('preserves the legacy opaque alpha fallback for falsy alpha values', () => {
    const context = installWriteDeltaEntityContext();

    try {
      const messages = new ServerMessages(context.sv);
      const from = new ServerEntityState(1);
      const to = new ServerEntityState(1);
      const buffer = new SzBuffer(64, 'ServerMessages.writeDeltaEntity alpha fallback');

      to.effects = 7;
      to.alpha = 0;

      assert.equal(messages.writeDeltaEntity(buffer, from, to), true);

      const view = new DataView(buffer.data);
      assert.equal(view.getUint16(0, true), 1);
      assert.equal(view.getUint32(2, true), Protocol.u.effects);
      assert.equal(view.getUint8(6), 7);
      assert.equal(view.getUint8(7), 255);
    } finally {
      context.restore();
    }
  });

  void test('writes scaled alpha bytes when alpha is explicitly set', () => {
    const context = installWriteDeltaEntityContext();

    try {
      const messages = new ServerMessages(context.sv);
      const from = new ServerEntityState(1);
      const to = new ServerEntityState(1);
      const buffer = new SzBuffer(64, 'ServerMessages.writeDeltaEntity alpha scaling');

      to.effects = 5;
      to.alpha = 0.5;

      assert.equal(messages.writeDeltaEntity(buffer, from, to), true);

      const view = new DataView(buffer.data);
      assert.equal(view.getUint8(6), 5);
      assert.equal(view.getUint8(7), Math.floor(0.5 * 255.0));
    } finally {
      context.restore();
    }
  });

  void test('writes extended entity field payloads without a capability flag', () => {
    const context = installWriteDeltaEntityContext();

    try {
      context.sv.server.clientEntityFields = {
        monster_ogre: {
          fields: ['scale'],
          bitsWriter: 'writeByte',
        },
      };

      const messages = new ServerMessages(context.sv);
      const from = new ServerEntityState(1);
      const to = new ServerEntityState(1);
      const buffer = new SzBuffer(64, 'ServerMessages.writeDeltaEntity extended fields');

      from.classname = 'monster_ogre';
      to.classname = 'monster_ogre';
      to.effects = 2;
      to.extended.scale = 7;

      assert.equal(messages.writeDeltaEntity(buffer, from, to), true);

      const view = new DataView(buffer.data);
      assert.equal(view.getUint8(6), 2);
      assert.equal(view.getUint8(7), 255);
      assert.equal(view.getUint8(8), 1);
      assert.equal(view.getUint8(9), Protocol.serializableTypes.byte);
      assert.equal(view.getUint8(10), 7);
    } finally {
      context.restore();
    }
  });
});

void describe('ServerMessages.startParticle', () => {
  void test('still writes once cursize passes the old stale 1009-byte threshold, as long as room remains in the real (16384-byte) buffer', () => {
    const sv = createTestServer();
    const datagram = new SzBuffer(16384, 'test datagram');
    datagram.cursize = 1200; // past the old hardcoded 1009 check, nowhere near the real 16384 capacity

    sv.server.datagram = datagram;

    const cursizeBefore = datagram.cursize;

    sv.messages.startParticle(new Vector(1, 2, 3), new Vector(0, 0, 1), 5, 10);

    assert.ok(datagram.cursize > cursizeBefore);
  });
});

void describe('ServerMessages.startSound', () => {
  /** A spawned client with a controllable PHS membership answer and its own `expedited_message` buffer to inspect after the call. */
  interface FakeClient {
    state: number;
    edict: { isInPXS: (pxs: Visibility) => boolean };
    expedited_message: SzBuffer;
    isInPXSCalls: Visibility[];
  }

  /**
   * Builds a fake spawned client.
   * @param inPhs Whether `isInPXS` should report this client as reachable.
   * @returns The fake client.
   */
  function createFakeClient(inPhs: boolean): FakeClient {
    const isInPXSCalls: Visibility[] = [];

    return {
      state: ServerClient.STATE.SPAWNED,
      edict: {
        isInPXS(pxs: Visibility) {
          isInPXSCalls.push(pxs);
          return inPhs;
        },
      },
      expedited_message: new SzBuffer(256, 'fake client expedited_message'),
      isInPXSCalls,
    };
  }

  /**
   * Installs a minimal server context for startSound tests.
   * @param options Fixture overrides.
   * @param options.soundPrecache The server's sound precache list.
   * @param options.clients The clients of the server.
   * @param options.leafnums The leafs the sounding entity is linked into.
   * @returns The context handle.
   */
  function installStartSoundContext({ soundPrecache = ['', 'weapons/sgun1.wav'], clients = [], leafnums = [3, 7, 9] }: { soundPrecache?: string[]; clients?: FakeClient[]; leafnums?: number[] } = {}): {
    sv: Server;
    messages: ServerMessages;
    edict: ServerEdict;
    phsMarker: Visibility;
    getPhsByLeafsCalls: number[][];
    getPhsByPointCalls: Vector[];
    restore: () => void;
  } {
    // The tests only compare the visibility they are handed back by identity, so a marker object stands in for it.
    const phsMarker = { marker: 'phs' } as unknown as Visibility;
    const getPhsByLeafsCalls: number[][] = [];
    const getPhsByPointCalls: Vector[] = [];
    const sv = createTestServer();

    sv.server.datagram = new SzBuffer(2048, 'test datagram');
    sv.server.soundPrecache = [...soundPrecache];
    // Only the two PHS lookups of the world model are called by startSound.
    sv.server.worldmodel = {
      getPhsByLeafs(leafIndices: number[]) {
        getPhsByLeafsCalls.push(leafIndices);
        return phsMarker;
      },
      getPhsByPoint(origin: Vector) {
        getPhsByPointCalls.push(origin);
        return phsMarker;
      },
    } as unknown as BrushModel;
    // The fake clients have the state, edict and message buffer startSound reads.
    sv.svs.clients = clients as unknown as ServerClient[];

    // Only the position, bounds and leafs of the sounding entity are read.
    const edict = {
      num: 5,
      leafnums,
      entity: {
        origin: new Vector(100, 0, 0),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
      },
    } as unknown as ServerEdict;

    return {
      sv,
      messages: sv.messages,
      edict,
      phsMarker,
      getPhsByLeafsCalls,
      getPhsByPointCalls,
      restore() {},
    };
  }

  void test('sends the sound event only to clients within the sound\'s PHS', () => {
    const nearClient = createFakeClient(true);
    const farClient = createFakeClient(false);
    const context = installStartSoundContext({ clients: [nearClient, farClient] });

    try {
      context.messages.startSound(context.edict, 1, 'weapons/sgun1.wav', 255, 1.0);

      // getPhsByLeafs must be called with the entity's linked leafnums, merging PHS across every
      // leaf it occupies rather than sampling a single point that could land in solid content.
      assert.equal(context.getPhsByLeafsCalls.length, 1);
      assert.deepEqual(context.getPhsByLeafsCalls[0], context.edict.leafnums);

      // Both clients must be checked against the exact same PHS the sound was resolved with.
      assert.equal(nearClient.isInPXSCalls[0], context.phsMarker);
      assert.equal(farClient.isInPXSCalls[0], context.phsMarker);

      // Every spawned client, in or out of PHS, gets an unconditional stopsound first — it's
      // an idempotent no-op client-side, and guarantees a stale looping channel on this exact
      // (entity, channel) pair can never be left orphaned by a PHS miss on the follow-up sound.
      assert.equal(farClient.expedited_message.cursize, 3);
      const farMessage = farClient.expedited_message;
      farMessage.beginReading();
      assert.equal(farMessage.readByte(), Protocol.svc.stopsound);
      assert.equal(farMessage.readShort(), (context.edict.num << 3) + 1);

      assert.ok(nearClient.expedited_message.cursize > 3);

      const message = nearClient.expedited_message;
      message.beginReading();
      assert.equal(message.readByte(), Protocol.svc.stopsound);
      assert.equal(message.readShort(), (context.edict.num << 3) + 1);
      assert.equal(message.readByte(), Protocol.svc.sound);
      assert.equal(message.readByte(), 0); // fieldMask: volume===255 and attenuation===1.0, so no optional fields
      assert.equal(message.readShort(), (context.edict.num << 3) + 1);
      assert.equal(message.readByte(), 1); // index of 'weapons/sgun1.wav' in soundPrecache
      assert.equal(message.readLong() / 8, 100);
      assert.equal(message.readLong() / 8, 0);
      assert.equal(message.readLong() / 8, 4);
    } finally {
      context.restore();
    }
  });

  void test('falls back to a bbox-center point lookup when the entity has no linked leafnums', () => {
    // Point-only logic entities (e.g. trap_spikeshooter) never set a model, so ServerArea never
    // populates their leafnums. Merging PHS across zero leafs would otherwise silence them for
    // every client, so startSound must fall back to the old point-based lookup in that case.
    const nearClient = createFakeClient(true);
    const context = installStartSoundContext({ clients: [nearClient], leafnums: [] });

    try {
      context.messages.startSound(context.edict, 1, 'weapons/sgun1.wav', 255, 1.0);

      assert.equal(context.getPhsByLeafsCalls.length, 0);
      assert.equal(context.getPhsByPointCalls.length, 1);
      assert.deepEqual([...context.getPhsByPointCalls[0]], [100, 0, 4]);
      assert.equal(nearClient.isInPXSCalls[0], context.phsMarker);
    } finally {
      context.restore();
    }
  });

  void test('broadcasts the loadsound notification on the shared datagram regardless of PHS, but still PHS-filters the sound event itself', () => {
    const farClient = createFakeClient(false);
    const context = installStartSoundContext({ soundPrecache: [''], clients: [farClient] });

    try {
      context.messages.startSound(context.edict, 0, 'weapons/newsound.wav', 255, 1.0);

      const datagram = context.sv.server.datagram;
      datagram.beginReading();
      assert.equal(datagram.readByte(), Protocol.svc.loadsound);
      assert.equal(datagram.readByte(), 1);
      assert.equal(datagram.readString(), 'weapons/newsound.wav');

      assert.equal(context.sv.server.soundPrecache.length, 2);
      assert.equal(context.sv.server.soundPrecache[1], 'weapons/newsound.wav');

      // The client is out of PHS, so it must not receive the actual sound event — but it still
      // gets the unconditional stopsound guard (see the PHS test above for the rationale).
      assert.equal(farClient.expedited_message.cursize, 3);
      const farMessage = farClient.expedited_message;
      farMessage.beginReading();
      assert.equal(farMessage.readByte(), Protocol.svc.stopsound);
      assert.equal(farMessage.readShort(), (context.edict.num << 3) + 0);
    } finally {
      context.restore();
    }
  });
});

void describe('ServerMessages.writeDeltaEntity attachment', () => {
  /**
   * Writes the delta between two states.
   * @param from The first state's attachment.
   * @param to The second state's attachment.
   * @returns Whether anything was written, the buffer and its size.
   */
  function write(from: { parent: number; tag: number }, to: { parent: number; tag: number }): { wrote: boolean; view: DataView; size: number } {
    const context = installWriteDeltaEntityContext();

    try {
      const messages = new ServerMessages(context.sv);
      const before = new ServerEntityState(3);
      const after = new ServerEntityState(3);
      const buffer = new SzBuffer(64, 'ServerMessages.writeDeltaEntity attachment');

      before.attachmentParent = from.parent;
      before.attachmentTag = from.tag;
      after.attachmentParent = to.parent;
      after.attachmentTag = to.tag;

      const wrote = messages.writeDeltaEntity(buffer, before, after);

      return { wrote, view: new DataView(buffer.data), size: buffer.cursize };
    } finally {
      context.restore();
    }
  }

  void test('sends nothing while the entity stays attached to the same tag, which is every frame of a held weapon', () => {
    assert.equal(write({ parent: 1, tag: 4 }, { parent: 1, tag: 4 }).wrote, false);
  });

  void test('sends the parent as an unsigned short and the tag as a signed short after the flag word', () => {
    const { wrote, view, size } = write({ parent: 0, tag: -1 }, { parent: 300, tag: 12 });

    assert.equal(wrote, true);
    assert.equal(view.getUint32(2, true), Protocol.u.attachment, 'the bit is above 16, so the word has to be 32 bits wide');
    assert.equal(view.getUint16(6, true), 300);
    assert.equal(view.getInt16(8, true), 12);
    assert.equal(size, 2 + 4 + 2 + 2);
  });

  void test('sends the change of tag alone, as when the parent switches to a model with the tag elsewhere', () => {
    const { view } = write({ parent: 1, tag: 4 }, { parent: 1, tag: 9 });

    assert.equal(view.getUint16(6, true), 1);
    assert.equal(view.getInt16(8, true), 9);
  });

  void test('sends a detach as parent 0, with the tag -1 the origin of the parent also has', () => {
    const { wrote, view } = write({ parent: 1, tag: 4 }, { parent: 0, tag: -1 });

    assert.equal(wrote, true);
    assert.equal(view.getUint16(6, true), 0);
    assert.equal(view.getInt16(8, true), -1);
  });
});

void describe('ServerMessages.writeDeltaEntity sequence block', () => {
  /**
   * Writes the delta between two states.
   * @param change What differs in the second state.
   * @param before What the first state was, if not the default.
   * @returns Whether anything was written, the buffer and its size.
   */
  function write(change: Partial<Pick<ServerEntityState, 'sequence' | 'animtime' | 'framerate' | 'frame'>>, before: Partial<Pick<ServerEntityState, 'sequence' | 'animtime' | 'framerate'>> = {}): { wrote: boolean; view: DataView; size: number } {
    const context = installWriteDeltaEntityContext();

    try {
      const messages = new ServerMessages(context.sv);
      const from = new ServerEntityState(3);
      const to = new ServerEntityState(3);
      const buffer = new SzBuffer(64, 'ServerMessages.writeDeltaEntity sequence');

      Object.assign(from, before);
      Object.assign(to, before, change);

      const wrote = messages.writeDeltaEntity(buffer, from, to);

      return { wrote, view: new DataView(buffer.data), size: buffer.cursize };
    } finally {
      context.restore();
    }
  }

  void test('sends nothing for an entity that plays no sequence, which is what every entity of a game that does not know them is', () => {
    assert.equal(write({}).wrote, false);
  });

  void test('names the one field that differs, and writes just that', () => {
    const sequence = write({ sequence: 2 });
    const start = write({ animtime: 12.5 });
    const speed = write({ framerate: 0.5 });

    for (const written of [sequence, start, speed]) {
      assert.equal(written.view.getUint32(2, true), Protocol.u.sequence, 'the bit is above 16, so the word has to be 32 bits wide');
    }

    assert.equal(sequence.view.getUint8(6), Protocol.sequenceField.sequence);
    assert.equal(sequence.size, 2 + 4 + 1 + 2);
    assert.equal(start.view.getUint8(6), Protocol.sequenceField.animtime);
    assert.equal(start.size, 2 + 4 + 1 + 4);
    assert.equal(speed.view.getUint8(6), Protocol.sequenceField.framerate);
    assert.equal(speed.size, 2 + 4 + 1 + 4);
  });

  void test('writes a signed short, then the floats, in the order the client reads them', () => {
    const { view, size } = write({ sequence: 2, animtime: 12.5, framerate: 0.5 });

    assert.equal(size, 2 + 4 + 1 + 2 + 4 + 4);
    assert.equal(view.getUint16(0, true), 3, 'the entity number');
    assert.equal(view.getUint8(6), Protocol.sequenceField.sequence | Protocol.sequenceField.animtime | Protocol.sequenceField.framerate);
    assert.equal(view.getInt16(7, true), 2);
    assert.equal(view.getFloat32(9, true), 12.5);
    assert.equal(view.getFloat32(13, true), 0.5);
  });

  void test('never sends a start time the game did not set, so the client keeps its own stamp', () => {
    // animtime stays null for a game whose entities have no such member; a sequence change alone must not carry one
    const { view, size } = write({ sequence: 3 }, { animtime: null });

    assert.equal(view.getUint8(6), Protocol.sequenceField.sequence);
    assert.equal(size, 2 + 4 + 1 + 2);
  });

  void test('sends an unchanged start time only once: a game that keeps setting the same one costs nothing', () => {
    assert.equal(write({ animtime: 4 }, { animtime: 4 }).wrote, false);
  });

  void test('writes the "no sequence" a game sets back as -1, not as 65535', () => {
    const { view } = write({ sequence: -1 }, { sequence: 4 });

    assert.equal(view.getInt16(7, true), -1);
  });

  void test('combines with the other fields of the update, which follow in the order the client reads them', () => {
    const { view } = write({ frame: 9, sequence: 1 });

    assert.equal(view.getUint32(2, true), Protocol.u.frame | Protocol.u.sequence);
    assert.equal(view.getUint8(6), 9, 'the frame comes first');
    assert.equal(view.getUint8(7), Protocol.sequenceField.sequence, 'then the sequence block');
    assert.equal(view.getInt16(8, true), 1);
  });
});
