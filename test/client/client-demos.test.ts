import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Def from '../../source/engine/common/Def.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import ClientDemos from '../../source/engine/client/ClientDemos.ts';
import { clientRuntimeState, clientStaticState } from '../../source/engine/client/ClientState.ts';
import '../support/consoleBridge.ts';
import { engineMocks } from '../support/engineMocks.ts';
import { withEngineMocks } from '../support/withEngineMocks.ts';

/**
 * Builds a synthetic current-format demo file with a single message.
 * @param payload Demo message payload.
 * @returns Encoded demo file bytes.
 */
function createDemoFile(payload: Uint8Array): ArrayBuffer {
  const trackString = '0\n';
  const demoFile = new ArrayBuffer(trackString.length + 16 + payload.length);
  const bytes = new Uint8Array(demoFile);

  for (let index = 0; index < trackString.length; index++) {
    bytes[index] = trackString.charCodeAt(index);
  }

  const view = new DataView(demoFile, trackString.length, 16);
  view.setUint32(0, payload.length, true);
  view.setFloat32(4, 1.0, true);
  view.setFloat32(8, 2.0, true);
  view.setFloat32(12, 3.0, true);

  bytes.set(payload, trackString.length + 16);

  return demoFile;
}

/** The engine parts the demo subsystem reads, as the tests mock them. */
interface MockClientRegistry {
  CL: object;
  COM: object;
  Con: object;
  Host: object;
  NET: { message: SzBuffer };
}

/**
 * Builds the registry surface needed by ClientDemos.
 * @param clientDemos Demo subsystem under test.
 * @param demoFile Demo file returned by COM.LoadFile.
 * @returns Mocked registry values.
 */
function createMockClientRegistry(clientDemos: ClientDemos, demoFile: ArrayBuffer): MockClientRegistry {
  return {
    CL: {
      cls: clientStaticState,
      state: clientRuntimeState,
      StopPlayback() {
        clientDemos.stopPlayback();
      },
    },
    COM: {
      DefaultExtension(name: string, extension: string) {
        return name.endsWith(extension) ? name : `${name}${extension}`;
      },
      LoadFile() {
        return Promise.resolve(demoFile);
      },
      WriteFile() {
        return Promise.resolve(true);
      },
    },
    Con: {
      Print() {},
      PrintError() {},
      PrintSuccess() {},
    },
    Host: {
      framecount: 0,
      realtime: 0,
    },
    NET: {
      message: new SzBuffer(8192, 'NET.message'),
    },
  };
}

/**
 * Runs a callback with a mocked registry and restores the previous values.
 * @param mockedRegistry Registry replacements.
 * @param callback Test body.
 * @returns Callback result.
 */
function withMockClientRegistry(mockedRegistry: ReturnType<typeof createMockClientRegistry>, callback: () => Promise<void> | void): Promise<void> | void {
  const { CL, COM, Con, Host, NET } = mockedRegistry;

  return withEngineMocks({ CL, COM, Con, Host, NET }, callback);
}

/**
 * Resets the shared client demo state between tests.
 */
function resetClientDemoState() {
  clientRuntimeState.clear();
  clientStaticState.clear();
  clientStaticState.state = Def.clientConnectionState.disconnected;
  clientStaticState.signon = 0;
}

void describe('ClientDemos', () => {
  void test('plays back a current-format demo message and stops at EOF', async () => {
    resetClientDemoState();

    const clientDemos = new ClientDemos();
    clientStaticState.bindClientDemos(clientDemos);
    const demoFile = createDemoFile(new Uint8Array([Protocol.svc.nop]));

    await withMockClientRegistry(createMockClientRegistry(clientDemos, demoFile), async () => {
      await clientDemos.startPlayback('smoke');

      assert.equal(clientDemos.demoplayback, true);
      assert.equal(clientStaticState.state, Def.clientConnectionState.connected);
      assert.equal(clientDemos.getMessage(), 1);
      assert.equal((engineMocks.NET as MockClientRegistry['NET']).message.cursize, 1);
      assert.equal(new Uint8Array((engineMocks.NET as MockClientRegistry['NET']).message.data, 0, 1)[0], Protocol.svc.nop);
      assert.deepEqual(Array.from(clientRuntimeState.viewangles), [1, 2, 3]);

      assert.equal(clientDemos.getMessage(), 0);
      assert.equal(clientDemos.demoplayback, false);
      assert.equal(clientStaticState.state, Def.clientConnectionState.disconnected);
    });

    resetClientDemoState();
  });
});
