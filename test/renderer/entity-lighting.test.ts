import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import EntityLighting from '../../source/engine/client/renderer/lighting/EntityLighting.ts';
import LightSampler from '../../source/engine/client/renderer/lighting/LightSampler.ts';
import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import * as Def from '../../source/engine/common/Def.ts';
import { effect } from '../../source/shared/Defs.ts';
import Vector from '../../source/shared/Vector.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers, useClientStateOf } from '../support/clientState.ts';
import { useHostOf } from '../support/host.ts';

interface FakeDlight {
  isFree(): boolean;
  radius: number;
  origin: Vector;
  color: Vector;
}

/**
 * Creates a list of dynamic light slots, all free.
 * @returns The slots.
 */
function createDlights(): FakeDlight[] {
  return Array.from({ length: Def.limits.dlights }, () => ({
    isFree: () => true,
    radius: 0,
    origin: new Vector(),
    color: new Vector(1, 1, 1),
  }));
}

void describe('EntityLighting', () => {
  let restores: Array<() => void> = [];

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }

    restores = [];
  });

  void describe('GetEntityLightSamplePoint', () => {
    void test('keeps entities on their true origin', () => {
      const entity = new ClientEdict(1);

      entity.lerp.origin.setTo(-4, 8, 12);

      assert.deepEqual([...EntityLighting.GetEntityLightSamplePoint(entity)], [-4, 8, 12]);
    });

    void test('does not hand out the origin of the entity itself', () => {
      const entity = new ClientEdict(1);

      entity.lerp.origin.setTo(3, 4, 5);

      EntityLighting.GetEntityLightSamplePoint(entity).setTo(1, 1, 1);

      assert.deepEqual([...entity.lerp.origin], [3, 4, 5]);
    });
  });

  void describe('SmoothLightValues', () => {
    beforeEach(() => {
      restores.push(useHostOf({ frametime: 0.1 }));
    });

    void test('snaps to the sampled value on first use', () => {
      const e = new ClientEdict(1);
      const ambient = new Vector(0.5, 0.4, 0.3);
      const shade = new Vector(0.6, 0.5, 0.4);
      const lightOrigin = new Vector(10, 20, 30);

      const [resultAmbient, resultShade, resultLightOrigin] = EntityLighting.SmoothLightValues(e, ambient, shade, lightOrigin, new Vector(0.1, 0.1, 0.1), new Vector(40, 50, 60));

      assert.deepEqual([...resultAmbient], [...ambient]);
      assert.deepEqual([...resultShade], [...shade]);
      assert.deepEqual([...resultLightOrigin], [...lightOrigin]);
      assert.notEqual(e.smoothedAmbientLight, null);
    });

    void test('eases towards a new target instead of snapping', () => {
      const e = new ClientEdict(1);

      EntityLighting.SmoothLightValues(e, new Vector(0, 0, 0), new Vector(0, 0, 0), new Vector(0, 0, 0), new Vector(), new Vector());

      const [resultAmbient] = EntityLighting.SmoothLightValues(e, new Vector(1, 1, 1), new Vector(0, 0, 0), new Vector(0, 0, 0), new Vector(), new Vector());

      assert(resultAmbient[0] > 0.0, 'moved towards the new target');
      assert(resultAmbient[0] < 1.0, 'did not jump straight to the new target');
    });

    void test('snaps immediately when the light origin jumps far enough to indicate a teleport', () => {
      const e = new ClientEdict(1);

      EntityLighting.SmoothLightValues(e, new Vector(0, 0, 0), new Vector(0, 0, 0), new Vector(0, 0, 0), new Vector(), new Vector());

      const farOrigin = new Vector(1000, 0, 0);
      const newAmbient = new Vector(1, 1, 1);
      const [resultAmbient, , resultLightOrigin] = EntityLighting.SmoothLightValues(e, newAmbient, new Vector(0, 0, 0), farOrigin, new Vector(), new Vector());

      assert.deepEqual([...resultAmbient], [...newAmbient]);
      assert.deepEqual([...resultLightOrigin], [...farOrigin]);
    });
  });

  void describe('CalculateLightValues', () => {
    let sampled: [Vector, Vector] = [new Vector(), new Vector()];
    let dlights: FakeDlight[] = [];

    beforeEach(() => {
      sampled = [new Vector(64, 32, 16), new Vector(1, 2, 3)];
      dlights = createDlights();
      restores.push(
        patchMembers(LightSampler, { LightPoint: () => [sampled[0].copy(), sampled[1].copy()] }),
        useHostOf({ frametime: 0.1 }),
        useClientStateOf({ state: { viewent: null, maxclients: 1, clientEntities: { dlights } } }),
      );
    });

    void test('scales baked light to the 0..1 range the shaders take', () => {
      const [ambient, shade, origin, dynamicShade] = EntityLighting.CalculateLightValues(new ClientEdict(5));

      assert.deepEqual([...ambient], [0.5, 0.25, 0.125]);
      assert.deepEqual([...shade], [0.5, 0.25, 0.125]);
      assert.deepEqual([...origin], [1, 2, 3]);
      assert.deepEqual([...dynamicShade], [0, 0, 0]);
    });

    void test('does not let baked light overbright: the brightest channel is capped at 128', () => {
      sampled = [new Vector(256, 128, 0), new Vector()];

      const [ambient] = EntityLighting.CalculateLightValues(new ClientEdict(5));

      assert.deepEqual([...ambient], [1.0, 0.5, 0.0]);
    });

    void test('lights fullbright entities at full brightness', () => {
      const entity = new ClientEdict(5);

      entity.effects = effect.EF_FULLBRIGHT;

      const [ambient, shade] = EntityLighting.CalculateLightValues(entity);

      assertNear(ambient[0], 255 * 0.0078125);
      assert.deepEqual([...shade], [...ambient]);
    });

    void test('never lets a player go totally dark', () => {
      sampled = [new Vector(0, 0, 0), new Vector()];

      // entity numbers 1..maxclients are players
      const [ambient, shade] = EntityLighting.CalculateLightValues(new ClientEdict(1));

      // no light at all becomes 1, times 8, times 1/128
      assertNear(ambient[0], 8 * 0.0078125);
      assertNear(shade[0], 8 * 0.0078125);
    });

    void test('leaves a dark monster dark', () => {
      sampled = [new Vector(0, 0, 0), new Vector()];

      const [ambient] = EntityLighting.CalculateLightValues(new ClientEdict(5));

      assert.deepEqual([...ambient], [0, 0, 0]);
    });

    void test('adds dynamic lights in reach, weighted by how deep the entity is in the radius', () => {
      const entity = new ClientEdict(5);

      entity.lerp.origin.setTo(0, 0, 0);
      dlights[3] = { isFree: () => false, radius: 150, origin: new Vector(50, 0, 0), color: new Vector(1, 0.5, 0.25) };

      const [, , , dynamicShade, dynamicOrigin] = EntityLighting.CalculateLightValues(entity);

      // add = radius - distance = 100, scaled by the color, then by 1/128
      assertNear(dynamicShade[0], 100 * 0.0078125);
      assertNear(dynamicShade[1], 50 * 0.0078125);
      assertNear(dynamicShade[2], 25 * 0.0078125);
      assert.deepEqual([...dynamicOrigin], [50, 0, 0]);
    });

    void test('ignores dynamic lights that do not reach the entity', () => {
      const entity = new ClientEdict(5);

      dlights[0] = { isFree: () => false, radius: 20, origin: new Vector(500, 0, 0), color: new Vector(1, 1, 1) };

      const [, , , dynamicShade] = EntityLighting.CalculateLightValues(entity);

      assert.deepEqual([...dynamicShade], [0, 0, 0]);
    });
  });
});
