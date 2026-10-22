import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
// The game's entity modules import each other in a cycle that only resolves when its entry point is loaded first.
import '../../source/game/id1/GameAPI.ts';
import type BaseEntity from '../../source/game/id1/entity/BaseEntity.ts';
import { TrainEntity } from '../../source/game/id1/entity/props/Platforms.ts';
import type { ServerGameAPI } from '../../source/game/id1/GameAPI.ts';
import { createBoundedEdict, createInertGameApi } from '../support/entityMocks.ts';

/**
 * @returns The train entity and the game API it was built with.
 */
function createTrainEntityFixture(): { entity: TrainEntity; gameAPI: ServerGameAPI } {
  const edict = createBoundedEdict();
  const gameAPI = createInertGameApi();

  const entity = new TrainEntity(edict, gameAPI);
  edict.entity = entity;

  return { entity, gameAPI };
}

void describe('TrainEntity', () => {
  void test('uses attack_finished for blocked damage cooldown without mutating nextthink', () => {
    const { entity, gameAPI } = createTrainEntityFixture();
    const damageCalls: unknown[][] = [];
    // Only the damage handler and the position of the blocked entity are read.
    const victim = {
      _damageHandler: {
        damage(...args: unknown[]) {
          damageCalls.push(args);
        },
      },
      origin: new Vector(10, 20, 30),
    } as unknown as BaseEntity;

    entity.dmg = 90;
    entity.nextthink = 3.25;
    entity.attack_finished = 0.0;

    entity.blocked(victim);
    entity.blocked(victim);

    assert.equal(damageCalls.length, 1);
    assert.equal(damageCalls[0][2], 90);
    assert.equal(entity.attack_finished, 0.5);
    assert.equal(entity.nextthink, 3.25);

    gameAPI.time = 0.49;
    entity.blocked(victim);
    assert.equal(damageCalls.length, 1);
    assert.equal(entity.attack_finished, 0.5);
    assert.equal(entity.nextthink, 3.25);

    gameAPI.time = 0.5;
    entity.blocked(victim);
    assert.equal(damageCalls.length, 2);
    assert.equal(entity.attack_finished, 1.0);
    assert.equal(entity.nextthink, 3.25);
  });
});
