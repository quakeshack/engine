import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// The game's entity modules import each other in a cycle that only resolves when its entry point is loaded first.
import '../../source/game/id1/GameAPI.ts';
import { worldType } from '../../source/game/id1/Defs.ts';
import type BaseEntity from '../../source/game/id1/entity/BaseEntity.ts';
import { DoorEntity } from '../../source/game/id1/entity/props/Doors.ts';
import { createInertEdict, createInertGameApi } from '../support/entityMocks.ts';

/**
 * @returns The door entity and the game API it was built with.
 */
function createDoorEntityFixture(): { entity: DoorEntity } {
  const edict = createInertEdict();
  const gameAPI = createInertGameApi({ worldspawn: { worldtype: worldType.MEDIEVAL } });

  const entity = new DoorEntity(edict, gameAPI);
  edict.entity = entity;
  entity.noise1 = 'doors/drclos4.wav';
  entity.noise2 = 'doors/doormv1.wav';
  entity.wait = 3.0;

  return { entity };
}

void describe('DoorEntity', () => {
  void test('resets the scheduled go-down think when reopening a door that is already at the top', () => {
    const { entity } = createDoorEntityFixture();
    // Only the door's reopen logic is under test; the activator is just handed through.
    const activator = { centerPoint: null } as unknown as BaseEntity;

    entity.ltime = 10.0;
    entity['_doorHitTop']();

    assert.equal(entity['_scheduledThinks'].length, 1);
    assert.equal(entity['_scheduledThinks'][0].identifier, 'door-go-down');
    assert.equal(entity['_scheduledThinks'][0].nextThink, 13.0);
    assert.equal(entity.nextthink, 13.0);

    entity.ltime = 11.5;
    entity['_doorGoUp'](activator);

    assert.equal(entity['_scheduledThinks'].length, 1);
    assert.equal(entity['_scheduledThinks'][0].identifier, 'door-go-down');
    assert.equal(entity['_scheduledThinks'][0].nextThink, 14.5);
    assert.equal(entity.nextthink, 14.5);
  });
});
