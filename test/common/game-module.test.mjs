import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { gameCapabilities } from '../../source/shared/Defs.ts';
import { validateGameModuleContract } from '../../source/engine/common/GameModule.ts';

class DummyServerGameAPI {}
class DummyClientGameAPI {}

function createGameModule(overrides = {}) {
  return {
    identification: {
      name: 'Test Game',
      author: 'test',
      version: [1, 0, 0],
      capabilities: [],
    },
    ServerGameAPI: DummyServerGameAPI,
    ClientGameAPI: DummyClientGameAPI,
    ...overrides,
  };
}

void describe('validateGameModuleContract', () => {
  void test('accepts a game module that exports ClientGameAPI', () => {
    const gameModule = createGameModule();

    assert.equal(validateGameModuleContract(gameModule), gameModule);
  });

  void test('rejects a game module without ClientGameAPI', () => {
    const gameModule = createGameModule({ ClientGameAPI: null });

    assert.throws(
      () => validateGameModuleContract(gameModule),
      /ClientGameAPI/,
    );
  });

  void test('accepts a game module that opts into supported optional capabilities', () => {
    const gameModule = createGameModule({
      identification: {
        name: 'Test Game',
        author: 'test',
        version: [1, 0, 0],
        capabilities: [gameCapabilities.CAP_HUD_INCLUDES_CROSSHAIR],
      },
    });

    assert.equal(validateGameModuleContract(gameModule), gameModule);
  });

  void test('rejects a game module that still exports removed capabilities', () => {
    const gameModule = createGameModule({
      identification: {
        name: 'Test Game',
        author: 'test',
        version: [1, 0, 0],
        capabilities: [
          'CAP_HUD_INCLUDES_SBAR',
        ],
      },
    });

    assert.throws(
      () => validateGameModuleContract(gameModule),
      /unsupported capabilities/,
    );
  });
});
