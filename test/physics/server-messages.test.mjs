import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { eventBus, registry } from '../../source/engine/registry.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import SV from '../../source/engine/server/Server.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';
import { ServerEntityState } from '../../source/engine/server/ServerEntityState.ts';
import { ServerMessages } from '../../source/engine/server/ServerMessages.ts';
import Vector from '../../source/shared/Vector.ts';

/**
 * Installs a minimal server registry context for delta-entity message tests.
 * @returns {{ restore: () => void }} A restore handle for the mocked registry state.
 */
function installWriteDeltaEntityContext() {
  const previousCon = registry.Con;
  const previousHost = registry.Host;
  const previousSV = registry.SV;
  const previousServer = SV.server;

  registry.Con = { Print() {}, DPrint() {}, PrintWarning() {} };
  registry.Host = { frametime: 0.1 };

  SV.server = {
    ...SV.server,
    time: 1,
    gameCapabilities: [],
    clientEntityFields: {},
  };

  registry.SV = SV;
  eventBus.publish('registry.frozen');

  return {
    restore() {
      registry.Con = previousCon;
      registry.Host = previousHost;
      registry.SV = previousSV;
      SV.server = previousServer;
      eventBus.publish('registry.frozen');
    },
  };
}

void describe('ServerMessages.writeDeltaEntity', () => {
  void test('preserves the legacy opaque alpha fallback for falsy alpha values', () => {
    const context = installWriteDeltaEntityContext();

    try {
      const messages = new ServerMessages();
      const from = new ServerEntityState(1);
      const to = new ServerEntityState(1);
      const buffer = new SzBuffer(64, 'ServerMessages.writeDeltaEntity alpha fallback');

      to.effects = 7;
      to.alpha = 0;

      assert.equal(messages.writeDeltaEntity(buffer, from, to), true);

      const view = new DataView(buffer.data);
      assert.equal(view.getUint16(0, true), 1);
      assert.equal(view.getUint16(2, true), Protocol.u.effects);
      assert.equal(view.getUint8(4), 7);
      assert.equal(view.getUint8(5), 255);
    } finally {
      context.restore();
    }
  });

  void test('writes scaled alpha bytes when alpha is explicitly set', () => {
    const context = installWriteDeltaEntityContext();

    try {
      const messages = new ServerMessages();
      const from = new ServerEntityState(1);
      const to = new ServerEntityState(1);
      const buffer = new SzBuffer(64, 'ServerMessages.writeDeltaEntity alpha scaling');

      to.effects = 5;
      to.alpha = 0.5;

      assert.equal(messages.writeDeltaEntity(buffer, from, to), true);

      const view = new DataView(buffer.data);
      assert.equal(view.getUint8(4), 5);
      assert.equal(view.getUint8(5), Math.floor(0.5 * 255.0));
    } finally {
      context.restore();
    }
  });

  void test('writes extended entity field payloads without a capability flag', () => {
    const context = installWriteDeltaEntityContext();

    try {
      SV.server.clientEntityFields = {
        monster_ogre: {
          fields: ['scale'],
          bitsWriter: 'writeByte',
        },
      };

      const messages = new ServerMessages();
      const from = new ServerEntityState(1);
      const to = new ServerEntityState(1);
      const buffer = new SzBuffer(64, 'ServerMessages.writeDeltaEntity extended fields');

      from.classname = 'monster_ogre';
      to.classname = 'monster_ogre';
      to.effects = 2;
      to.extended.scale = 7;

      assert.equal(messages.writeDeltaEntity(buffer, from, to), true);

      const view = new DataView(buffer.data);
      assert.equal(view.getUint8(4), 2);
      assert.equal(view.getUint8(5), 255);
      assert.equal(view.getUint8(6), 1);
      assert.equal(view.getUint8(7), Protocol.serializableTypes.byte);
      assert.equal(view.getUint8(8), 7);
    } finally {
      context.restore();
    }
  });
});

void describe('ServerMessages.startParticle', () => {
  void test('still writes once cursize passes the old stale 1009-byte threshold, as long as room remains in the real (16384-byte) buffer', () => {
    const previousSV = registry.SV;
    const previousServer = SV.server;

    const datagram = new SzBuffer(16384, 'test datagram');
    datagram.cursize = 1200; // past the old hardcoded 1009 check, nowhere near the real 16384 capacity

    SV.server = { ...SV.server, datagram };
    registry.SV = SV;
    eventBus.publish('registry.frozen');

    try {
      const messages = new ServerMessages();
      const cursizeBefore = datagram.cursize;

      messages.startParticle(new Vector(1, 2, 3), new Vector(0, 0, 1), 5, 10);

      assert.ok(datagram.cursize > cursizeBefore);
    } finally {
      registry.SV = previousSV;
      SV.server = previousServer;
      eventBus.publish('registry.frozen');
    }
  });
});

void describe('ServerMessages.startSound', () => {
  /**
   * Builds a fake spawned client with a controllable PHS membership answer
   * and its own `expedited_message` buffer to inspect after the call.
   * @param {boolean} inPhs whether `isInPXS` should report this client as reachable
   * @returns {{ state: number, edict: { isInPXS: (pxs: unknown) => boolean }, expedited_message: SzBuffer, isInPXSCalls: unknown[] }} fake client
   */
  function createFakeClient(inPhs) {
    const isInPXSCalls = [];

    return {
      state: ServerClient.STATE.SPAWNED,
      edict: {
        isInPXS(pxs) {
          isInPXSCalls.push(pxs);
          return inPhs;
        },
      },
      expedited_message: new SzBuffer(256, 'fake client expedited_message'),
      isInPXSCalls,
    };
  }

  /**
   * Installs a minimal server registry context for startSound tests.
   * @param {{ soundPrecache?: string[], clients?: object[], leafnums?: number[] }} options fixture overrides
   * @returns {{
   *   messages: ServerMessages, edict: object, phsMarker: object,
   *   getPhsByLeafsCalls: unknown[][], getPhsByPointCalls: unknown[], restore: () => void,
   * }} context handle
   */
  function installStartSoundContext({ soundPrecache = ['', 'weapons/sgun1.wav'], clients = [], leafnums = [3, 7, 9] } = {}) {
    const previousCon = registry.Con;
    const previousSV = registry.SV;
    const previousServer = SV.server;
    const previousSvs = SV.svs;

    registry.Con = { Print() {}, DPrint() {}, PrintWarning() {} };

    const phsMarker = { marker: 'phs' };
    const getPhsByLeafsCalls = [];
    const getPhsByPointCalls = [];

    SV.server = {
      ...SV.server,
      datagram: new SzBuffer(2048, 'test datagram'),
      soundPrecache: [...soundPrecache],
      worldmodel: {
        getPhsByLeafs(leafIndices) {
          getPhsByLeafsCalls.push(leafIndices);
          return phsMarker;
        },
        getPhsByPoint(origin) {
          getPhsByPointCalls.push(origin);
          return phsMarker;
        },
      },
    };

    SV.svs = { ...SV.svs, clients };

    registry.SV = SV;
    eventBus.publish('registry.frozen');

    const edict = {
      num: 5,
      leafnums,
      entity: {
        origin: new Vector(100, 0, 0),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
      },
    };

    return {
      messages: new ServerMessages(),
      edict,
      phsMarker,
      getPhsByLeafsCalls,
      getPhsByPointCalls,
      restore() {
        registry.Con = previousCon;
        registry.SV = previousSV;
        SV.server = previousServer;
        SV.svs = previousSvs;
        eventBus.publish('registry.frozen');
      },
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

      const datagram = SV.server.datagram;
      datagram.beginReading();
      assert.equal(datagram.readByte(), Protocol.svc.loadsound);
      assert.equal(datagram.readByte(), 1);
      assert.equal(datagram.readString(), 'weapons/newsound.wav');

      assert.equal(SV.server.soundPrecache.length, 2);
      assert.equal(SV.server.soundPrecache[1], 'weapons/newsound.wav');

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
