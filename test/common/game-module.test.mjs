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
      capabilities: [
        gameCapabilities.CAP_CLIENTDATA_DYNAMIC,
        gameCapabilities.CAP_SPAWNPARMS_DYNAMIC,
      ],
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

  void test('rejects a game module without dynamic clientdata support', () => {
    const gameModule = createGameModule({
      identification: {
        name: 'Test Game',
        author: 'test',
        version: [1, 0, 0],
        capabilities: [gameCapabilities.CAP_SPAWNPARMS_DYNAMIC],
      },
    });

    assert.throws(
      () => validateGameModuleContract(gameModule),
      /CAP_CLIENTDATA_DYNAMIC/,
    );
  });

  void test('rejects a game module that still enables legacy gameplay capabilities', () => {
    const gameModule = createGameModule({
      identification: {
        name: 'Test Game',
        author: 'test',
        version: [1, 0, 0],
        capabilities: [
          gameCapabilities.CAP_CLIENTDATA_DYNAMIC,
          gameCapabilities.CAP_SPAWNPARMS_DYNAMIC,
          gameCapabilities.CAP_CLIENTDATA_LEGACY,
        ],
      },
    });

    assert.throws(
      () => validateGameModuleContract(gameModule),
      /legacy capabilities/,
    );
  });
});
