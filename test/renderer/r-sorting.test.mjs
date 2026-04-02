import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import R, { compareFogAndTurbulentItems } from '../../source/engine/client/R.mjs';
import { eventBus, registry } from '../../source/engine/registry.mjs';
import Vector from '../../source/shared/Vector.ts';

describe('compareFogAndTurbulentItems', () => {
  test('sorts farther items first', () => {
    const result = compareFogAndTurbulentItems(
      { dist: 64, kind: 0 },
      { dist: 128, kind: 1 },
    );

    assert(result > 0);
  });

  test('sorts fog before turbulent when their front depth ties', () => {
    const fog = { dist: 96, kind: 1 };
    const turbulent = { dist: 96, kind: 0 };
    const items = [turbulent, fog];

    items.sort(compareFogAndTurbulentItems);

    assert.deepEqual(items, [fog, turbulent]);
  });

  test('treats near-equal distances as a tie for boundary-sharing fog and water', () => {
    const fog = { dist: 96.00005, kind: 1 };
    const turbulent = { dist: 96.0, kind: 0 };
    const items = [turbulent, fog];

    items.sort(compareFogAndTurbulentItems);

    assert.deepEqual(items, [fog, turbulent]);
  });
});

describe('R.GetEntityLightSamplePoint', () => {
  // CR: this is currently not working, see original
  // test('derives alias sample height from negative mins to match classic Quake monsters', () => {
  //   const previousCL = registry.CL;
  //   const previousMod = registry.Mod;

  //   registry.CL = { state: { viewent: null } };
  //   registry.Mod = { type: { alias: 2 } };
  //   eventBus.publish('registry.frozen');

  //   try {
  //     const entity = {
  //       lerp: { origin: new Vector(10, 20, 30) },
  //       model: { type: 2 },
  //       mins: new Vector(-16, -16, -24),
  //     };

  //     const samplePoint = R.GetEntityLightSamplePoint(entity);

  //     assert.deepEqual(Array.from(samplePoint), [10, 20, 54]);
  //     assert.deepEqual(Array.from(entity.lerp.origin), [10, 20, 30]);
  //   } finally {
  //     registry.CL = previousCL;
  //     registry.Mod = previousMod;
  //     eventBus.publish('registry.frozen');
  //   }
  // });

  test('keeps brush and sprite entities on their true origin', () => {
    const previousCL = registry.CL;
    const previousMod = registry.Mod;

    registry.CL = { state: { viewent: null } };
    registry.Mod = { type: { alias: 2, brush: 1 } };
    eventBus.publish('registry.frozen');

    try {
      const entity = {
        lerp: { origin: new Vector(-4, 8, 12) },
        model: { type: 1 },
        mins: new Vector(),
      };

      const samplePoint = R.GetEntityLightSamplePoint(entity);

      assert.deepEqual(Array.from(samplePoint), [-4, 8, 12]);
    } finally {
      registry.CL = previousCL;
      registry.Mod = previousMod;
      eventBus.publish('registry.frozen');
    }
  });
});
