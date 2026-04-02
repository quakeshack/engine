import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { InviteCommand } from '../../source/engine/network/ConsoleCommands.ts';
import { eventBus, registry } from '../../source/engine/registry.mjs';

/**
 * Temporarily install a global value for the duration of a callback.
 * @param {string} name
 * @param {unknown} value
 * @param {() => Promise<unknown>} callback
 * @returns {Promise<unknown>} Result of the callback.
 */
function withGlobalValue(name, value, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);

  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });

  try {
    return Promise.resolve(callback()).finally(() => {
      if (descriptor === undefined) {
        delete globalThis[name];
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    });
  } catch (error) {
    if (descriptor === undefined) {
      delete globalThis[name];
    } else {
      Object.defineProperty(globalThis, name, descriptor);
    }

    throw error;
  }
}

/**
 * Temporarily install mocked networking registry singletons for invite command tests.
 * @param {{ GetListenAddress: () => string | null }} mockedNet
 * @param {{ Print: (message: string) => void, PrintWarning: (message: string) => void }} mockedCon
 * @param {() => Promise<void>} callback
 * @returns {Promise<void>} Result of the callback.
 */
function withInviteRegistry(mockedNet, mockedCon, callback) {
  const previousCon = registry.Con;
  const previousNET = registry.NET;

  registry.Con = mockedCon;
  registry.NET = mockedNet;
  eventBus.publish('registry.frozen');

  return Promise.resolve(callback()).finally(() => {
    registry.Con = previousCon;
    registry.NET = previousNET;
    eventBus.publish('registry.frozen');
  });
}

void describe('InviteCommand', () => {
  void test('warns when no listen address is available', async () => {
    const warnings = [];
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
    const prints = [];
    const clipboardWrites = [];
    const command = new InviteCommand();

    await withInviteRegistry(
      { GetListenAddress() { return 'webrtc://session-123'; } },
      { Print(message) { prints.push(message); }, PrintWarning() {} },
      async () => {
        await withGlobalValue('location', new URL('https://quake.test/play?exec=autoexec.cfg&map=start&foo=bar'), async () => {
          await withGlobalValue('navigator', {
            clipboard: {
              writeText(text) {
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
    const prompts = [];
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
            await withGlobalValue('prompt', (message, value) => {
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
