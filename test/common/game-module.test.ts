import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { gameCapabilities } from '../../source/shared/Defs.ts';
import { validateGameModuleContract } from '../../source/engine/common/GameModule.ts';

class DummyServerGameAPI {}
class DummyClientGameAPI {}

/** The parts of a game module the contract check looks at. */
interface GameModuleStub {
  /** Module metadata. */
  identification: { name: string; author: string; version: number[]; capabilities: string[] };
  /** Server API constructor. */
  ServerGameAPI: (new () => object) | null;
  /** Client API constructor. */
  ClientGameAPI: (new () => object) | null;
}

/**
 * Builds a minimal valid game module and applies the overrides on top of it.
 * @param overrides properties replacing the defaults
 * @returns a game-module-shaped object
 */
function createGameModule(overrides: Partial<GameModuleStub> = {}): GameModuleStub {
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

  void test('rejects a game module without ServerGameAPI', () => {
    const gameModule = createGameModule({ ServerGameAPI: null });

    assert.throws(
      () => validateGameModuleContract(gameModule),
      /ServerGameAPI/,
    );
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
        capabilities: [gameCapabilities.CAP_ENTITY_BBOX_ADJUSTMENTS_DURING_LINK],
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

  void test('rejects a game module that still asks the engine to draw the crosshair', () => {
    // the engine does not draw a crosshair any more: the game does, so there is nothing left to opt out of
    const gameModule = createGameModule({
      identification: {
        name: 'Test Game',
        author: 'test',
        version: [1, 0, 0],
        capabilities: ['CAP_HUD_INCLUDES_CROSSHAIR'],
      },
    });

    assert.throws(
      () => validateGameModuleContract(gameModule),
      /unsupported capabilities/,
    );
  });
});
