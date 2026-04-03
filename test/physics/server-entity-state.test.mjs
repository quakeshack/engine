import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ServerEntityState as ReExportedServerEntityState } from '../../source/engine/server/Server.ts';
import { ServerEntityState } from '../../source/engine/server/ServerEntityState.ts';

void describe('ServerEntityState', () => {
  void test('re-exports the canonical implementation from Server.ts', () => {
    assert.equal(ReExportedServerEntityState, ServerEntityState);
  });

  void test('copies and resets alpha with the rest of the entity state', () => {
    const sourceState = new ServerEntityState(12);
    sourceState.flags = 4;
    sourceState.origin.setTo(1, 2, 3);
    sourceState.angles.setTo(4, 5, 6);
    sourceState.velocity.setTo(7, 8, 9);
    sourceState.alpha = 0.25;
    sourceState.nextthink = 0.3;
    sourceState.classname = 'func_door';
    sourceState.extended.renderfx = 7;

    const copiedState = new ServerEntityState();
    copiedState.set(sourceState);

    assert.equal(copiedState.alpha, 0.25);
    assert.equal(copiedState.nextthink, 0.3);
    assert.equal(copiedState.classname, 'func_door');
    assert.deepEqual([...copiedState.origin], [1, 2, 3]);
    assert.deepEqual([...copiedState.velocity], [7, 8, 9]);
    assert.equal(copiedState.extended.renderfx, 7);

    copiedState.freeEdict();

    assert.equal(copiedState.free, true);
    assert.equal(copiedState.alpha, 1.0);
    assert.equal(copiedState.classname, null);
    assert.deepEqual([...copiedState.origin], [Infinity, Infinity, Infinity]);
    assert.deepEqual([...copiedState.velocity], [0, 0, 0]);
  });
});
