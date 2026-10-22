import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import InviteCommand from '../../source/engine/client/InviteCommand.ts';
import '../support/consoleBridge.ts';
import { withEngineMocks } from '../support/withEngineMocks.ts';

/**
 * Temporarily install a global value for the duration of a callback.
 * @param name
 * @param value
 * @param callback
 * @returns Result of the callback.
 */
function withGlobalValue(name: string, value: unknown, callback: () => Promise<unknown>): Promise<unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);

  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });

  try {
    return Promise.resolve(callback()).finally(() => {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, name);
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    });
  } catch (error) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, name);
    } else {
      Object.defineProperty(globalThis, name, descriptor);
    }

    throw error;
  }
}

/**
 * Temporarily install mocked networking registry singletons for invite command tests.
 * @param mockedNet
 * @param mockedCon
 * @param callback
 * @returns Result of the callback.
 */
function withInviteRegistry(mockedNet: { GetListenAddress: () => string | null }, mockedCon: { Print: (message: string) => void, PrintWarning: (message: string) => void }, callback: () => Promise<void>): Promise<void> {
  return withEngineMocks({ Con: mockedCon, NET: mockedNet }, callback);
}

void describe('InviteCommand', () => {
  void test('warns when no listen address is available', async () => {
    const warnings: string[] = [];
    const command = new InviteCommand();

    await withInviteRegistry(
      { GetListenAddress() { return null; } },
      { Print() {}, PrintWarning(message) { warnings.push(message); } },
      async () => {
        await command.run();
      },
    );

    assert.deepEqual(warnings, ['Cannot create invite link, not hosting.\n']);
  });

  void test('copies a sanitized invite link to the clipboard', async () => {
    const prints: string[] = [];
    const clipboardWrites: string[] = [];
    const command = new InviteCommand();

    await withInviteRegistry(
      { GetListenAddress() { return 'webrtc://session-123'; } },
      { Print(message) { prints.push(message); }, PrintWarning() {} },
      async () => {
        await withGlobalValue('location', new URL('https://quake.test/play?exec=autoexec.cfg&map=start&foo=bar'), async () => {
          await withGlobalValue('navigator', {
            clipboard: {
              writeText(text: string) {
                clipboardWrites.push(text);
                return Promise.resolve();
              },
            },
          }, async () => {
            await withGlobalValue('prompt', () => {
              throw new Error('prompt should not be called');
            }, async () => {
              await command.run();
            });
          });
        });
      },
    );

    assert.deepEqual(clipboardWrites, ['https://quake.test/play?foo=bar&connect=webrtc%3A%2F%2Fsession-123']);
    assert.deepEqual(prints, [
      'This link has been copied to your clipboard:\nhttps://quake.test/play?foo=bar&connect=webrtc%3A%2F%2Fsession-123\n',
    ]);
  });

  void test('falls back to prompt when clipboard write fails', async () => {
    const prompts: Array<[string, string]> = [];
    const command = new InviteCommand();

    await withInviteRegistry(
      { GetListenAddress() { return 'webrtc://session-456'; } },
      { Print() {}, PrintWarning() {} },
      async () => {
        await withGlobalValue('location', new URL('https://quake.test/play?map=start'), async () => {
          await withGlobalValue('navigator', {
            clipboard: {
              writeText() {
                return Promise.reject(new Error('clipboard unavailable'));
              },
            },
          }, async () => {
            await withGlobalValue('prompt', (message: string, value: string) => {
              prompts.push([message, value]);
            }, async () => {
              await command.run();
            });
          });
        });
      },
    );

    assert.deepEqual(prompts, [[
      'Share this link to invite players:',
      'https://quake.test/play?connect=webrtc%3A%2F%2Fsession-456',
    ]]);
  });
});
