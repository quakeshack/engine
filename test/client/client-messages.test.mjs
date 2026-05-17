import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Protocol from '../../source/engine/network/Protocol.ts';
import { registerSerializableType, SzBuffer } from '../../source/engine/network/MSG.ts';
import { ClientMessages } from '../../source/engine/client/ClientMessages.ts';
import Vector from '../../source/shared/Vector.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

class MockClientSerializable {
  constructor(value) {
    this.value = value;
  }
}

registerSerializableType(MockClientSerializable, {
  serialize(sz, object) {
    sz.writeString(object.value);
  },
  deserializeOnServer(sz) {
    return new MockClientSerializable(sz.readString());
  },
  deserializeOnClient(sz) {
    return new MockClientSerializable(sz.readString());
  },
});

/**
 * Run a callback with just the registry modules ClientMessages depends on.
 * @param {{CL: object, COM: object, NET: object}} dependencies Mocked registry dependencies.
 * @param {() => void | Promise<void>} callback Test body.
 * @returns {void | Promise<void>} Callback result.
 */
function withMockClientMessagesRegistry({ CL, COM, NET }, callback) {
  const previousValues = {
    CL: registry.CL,
    COM: registry.COM,
    NET: registry.NET,
  };

  registry.CL = CL;
  registry.COM = COM;
  registry.NET = NET;
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.CL = previousValues.CL;
    registry.COM = previousValues.COM;
    registry.NET = previousValues.NET;
    eventBus.publish('registry.frozen');
  };

  try {
    const result = callback();

    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(restore);
    }

    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

void describe('ClientMessages', () => {
  void test('parses acknowledged move state and keeps untouched sparse clientdata fields', () => {
    const messages = new ClientMessages();
    messages.clientdataFields = ['health', 'alive'];
    const fieldChanges = [];

    const buffer = new SzBuffer(128, 'client-messages-clientdata');
    buffer.writeShort(Protocol.su.moveack);
    buffer.writeByte(17);
    buffer.writeByte(3);
    buffer.writeByte(6);
    buffer.writeByte(9);
    buffer.writeByte(1);
    buffer.writeByte(Protocol.serializableTypes.long);
    buffer.writeLong(125);
    buffer.writeByte(Protocol.serializableTypes.none);
    buffer.beginReading();

    const mockCL = {
      gameCapabilities: [],
      state: {
        time: 4.5,
        clientMessages: messages,
        viewheight: 0,
        idealpitch: 0,
        punchangle: new Vector(),
        onground: false,
        inwater: false,
        acknowledgedMoveSequence: 0,
        ackedPmFlags: 0,
        ackedPmTime: 0,
        ackedPmOldButtons: 0,
        items: 0,
        item_gettime: new Array(32).fill(0),
        stats: new Array(32).fill(0),
        gameAPI: {
          clientdata: {
            health: 10,
            alive: true,
          },
        },
      },
    };

    const unsubscribe = eventBus.subscribe('client.clientdata.field-changed', (...args) => {
      fieldChanges.push(args);
    });

    void withMockClientMessagesRegistry({
      CL: mockCL,
      COM: { standard_quake: true },
      NET: { message: buffer },
    }, () => {
      messages.parseClient();
    });

    unsubscribe();

    assert.equal(mockCL.state.acknowledgedMoveSequence, 17);
    assert.equal(mockCL.state.ackedPmFlags, 3);
    assert.equal(mockCL.state.ackedPmTime, 6);
    assert.equal(mockCL.state.ackedPmOldButtons, 9);
    assert.equal(mockCL.state.gameAPI.clientdata.health, 125);
    assert.equal(mockCL.state.gameAPI.clientdata.alive, true);
    assert.deepEqual(fieldChanges, [['health', 125, 10]]);
  });

  void test('parses client events and forwards the decoded arguments to the game API', () => {
    const messages = new ClientMessages();
    const receivedEvents = [];

    const buffer = new SzBuffer(128, 'client-messages-events');
    buffer.writeByte(42);
    buffer.writeSerializables(['hello', 99, true, new Vector(1, 2, 3), null]);
    buffer.beginReading();

    void withMockClientMessagesRegistry({
      CL: {
        state: {
          clientEntities: {
            getEntity() {
              throw new Error('Unexpected client edict lookup');
            },
          },
          gameAPI: {
            handleClientEvent(code, ...args) {
              receivedEvents.push([code, args]);
            },
          },
        },
      },
      COM: { standard_quake: true },
      NET: { message: buffer },
    }, () => {
      messages.parseClientEvent();
    });

    assert.equal(receivedEvents.length, 1);
    assert.equal(receivedEvents[0][0], 42);
    assert.deepEqual(receivedEvents[0][1].slice(0, 3), ['hello', 99, true]);
    assert.ok(receivedEvents[0][1][3] instanceof Vector);
    assert.deepEqual([...receivedEvents[0][1][3]], [1, 2, 3]);
    assert.equal(receivedEvents[0][1][4], null);
  });

  void test('parses array and custom serializable clientdata fields through the generic reader', () => {
    const messages = new ClientMessages();
    messages.clientdataFields = ['inventory', 'target'];

    const buffer = new SzBuffer(128, 'client-messages-rich-clientdata');
    buffer.writeShort(0);
    buffer.writeByte(3);
    buffer.writeSerializables([[1, 2, 3], new MockClientSerializable('teleporter')]);
    buffer.beginReading();

    const mockCL = {
      gameCapabilities: [],
      state: {
        time: 1,
        clientMessages: messages,
        viewheight: 0,
        idealpitch: 0,
        punchangle: new Vector(),
        onground: false,
        inwater: false,
        acknowledgedMoveSequence: 0,
        ackedPmFlags: 0,
        ackedPmTime: 0,
        ackedPmOldButtons: 0,
        items: 0,
        item_gettime: new Array(32).fill(0),
        stats: new Array(32).fill(0),
        gameAPI: {
          clientdata: {
            inventory: [],
            target: null,
          },
        },
      },
    };

    void withMockClientMessagesRegistry({
      CL: mockCL,
      COM: { standard_quake: true },
      NET: { message: buffer },
    }, () => {
      messages.parseClient();
    });

    assert.deepEqual(mockCL.state.gameAPI.clientdata.inventory, [1, 2, 3]);
    assert.equal(mockCL.state.gameAPI.clientdata.target instanceof MockClientSerializable, true);
    assert.equal(mockCL.state.gameAPI.clientdata.target.value, 'teleporter');
  });

  void test('publishes explicit field-change events for sparse clientdata transitions', () => {
    const messages = new ClientMessages();
    messages.clientdataFields = ['target'];
    const fieldChanges = [];

    const first = new SzBuffer(128, 'client-messages-field-changed-first');
    first.writeShort(0);
    first.writeByte(1);
    first.writeSerializables(['ogre']);
    first.beginReading();

    const second = new SzBuffer(128, 'client-messages-field-changed-second');
    second.writeShort(0);
    second.writeByte(1);
    second.writeSerializables([null]);
    second.beginReading();

    const mockState = {
      time: 1,
      clientMessages: messages,
      viewheight: 0,
      idealpitch: 0,
      punchangle: new Vector(),
      onground: false,
      inwater: false,
      acknowledgedMoveSequence: 0,
      ackedPmFlags: 0,
      ackedPmTime: 0,
      ackedPmOldButtons: 0,
      items: 0,
      item_gettime: new Array(32).fill(0),
      stats: new Array(32).fill(0),
      gameAPI: {
        clientdata: {
          target: null,
        },
      },
    };

    const net = { message: first };
    const unsubscribe = eventBus.subscribe('client.clientdata.field-changed', (...args) => {
      fieldChanges.push(args);
    });

    void withMockClientMessagesRegistry({
      CL: {
        gameCapabilities: [],
        state: mockState,
      },
      COM: { standard_quake: true },
      NET: net,
    }, () => {
      messages.parseClient();
    });

    net.message = second;

    void withMockClientMessagesRegistry({
      CL: {
        gameCapabilities: [],
        state: mockState,
      },
      COM: { standard_quake: true },
      NET: net,
    }, () => {
      messages.parseClient();
    });

    unsubscribe();

    assert.deepEqual(fieldChanges, [
      ['target', 'ogre', null],
      ['target', null, 'ogre'],
    ]);
    assert.equal(mockState.gameAPI.clientdata.target, null);
  });
});
