import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// The game's entity modules import each other in a cycle that only resolves when its entry point is loaded first.
import '../../source/game/id1/GameAPI.ts';
import { PlatformEntity } from '../../source/game/id1/entity/props/Platforms.ts';
import { createInertEdict, createInertGameApi } from '../support/entityMocks.ts';

/**
 * @returns The platform entity and the game API it was built with.
 */
function createPlatformEntityFixture(): { entity: PlatformEntity } {
  const edict = createInertEdict();
  const gameAPI = createInertGameApi();

  const entity = new PlatformEntity(edict, gameAPI);
  edict.entity = entity;
  entity.noise = 'plats/plat1.wav';
  entity.noise1 = 'plats/plat2.wav';

  return { entity };
}

void describe('PlatformEntity', () => {
  void test('extends the scheduled go-down think instead of leaving a stale queue entry', () => {
    const { entity } = createPlatformEntityFixture();

    entity.ltime = 5.0;
    entity._hitTop();

    assert.equal(entity['_scheduledThinks'].length, 1);
    assert.equal(entity['_scheduledThinks'][0].identifier, 'plat-go-down');
    assert.equal(entity['_scheduledThinks'][0].nextThink, 8.0);
    assert.equal(entity.nextthink, 8.0);

    entity.ltime = 7.25;
    entity._keepUp();

    assert.equal(entity['_scheduledThinks'].length, 1);
    assert.equal(entity['_scheduledThinks'][0].identifier, 'plat-go-down');
    assert.equal(entity['_scheduledThinks'][0].nextThink, 8.25);
    assert.equal(entity.nextthink, 8.25);
  });
});
