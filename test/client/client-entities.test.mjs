import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Computes wrapped angular delta in degrees.
 * @param {number} from
 * @param {number} to
 * @returns {number} Wrapped angular delta in [-180, 180).
 */
function shortestAngleDelta(from, to) {
  return ((to - from + 540.0) % 360.0) - 180.0;
}

/**
 * Runs a callback with a minimal client registry fixture.
 * @param {() => void} callback
 */
function withMockClientEntitiesRegistry(callback) {
  const previousCL = registry.CL;

  registry.CL = {
    nolerp: { value: 0 },
    state: {
      clientMessages: {
        mtime: [0.0],
      },
    },
  };
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.CL = previousCL;
    eventBus.publish('registry.frozen');
  };

  try {
    callback();
  } finally {
    restore();
  }
}

void describe('ClientEdict.lerp.angles', () => {
  void test('uses shortest-path quaternion interpolation for wrapped yaw', () => {
    withMockClientEntitiesRegistry(() => {
      const entity = new ClientEdict(1);

      entity.anglesPrevious.setTo(0.0, 350.0, 0.0);
      entity.angles.setTo(0.0, 10.0, 0.0);
      entity.anglesTime = 0.0;
      entity.nextthink = 1.0;
      registry.CL.state.clientMessages.mtime[0] = 0.5;

      const lerped = entity.lerp.angles;
      const deltaYaw = shortestAngleDelta(entity.anglesPrevious[1], lerped[1]);

      assert.ok(Math.abs(deltaYaw - 10.0) < 0.001);
    });
  });

  void test('does not mutate stored network angles while lerping', () => {
    withMockClientEntitiesRegistry(() => {
      const entity = new ClientEdict(2);

      entity.anglesPrevious.setTo(35.0, -170.0, 80.0);
      entity.angles.setTo(-20.0, 175.0, -40.0);
      entity.anglesTime = 0.0;
      entity.nextthink = 1.0;
      registry.CL.state.clientMessages.mtime[0] = 0.5;

      void entity.lerp.angles;

      assert.deepEqual([...entity.anglesPrevious], [35.0, -170.0, 80.0]);
      assert.deepEqual([...entity.angles], [-20.0, 175.0, -40.0]);
    });
  });
});
