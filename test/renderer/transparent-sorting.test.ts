import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import TransparentPass, { TransparentKind, type TransparentItem } from '../../source/engine/client/renderer/scene/TransparentPass.ts';
import type { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import type { WorldSurfaceBatch } from '../../source/engine/common/model/BSP.ts';

void describe('TransparentPass.Compare', () => {
  void test('sorts farther items first', () => {
    const result = TransparentPass.Compare(
      { dist: 64, kind: TransparentKind.Turbulent },
      { dist: 128, kind: TransparentKind.FogVolume },
    );

    assert(result > 0);
  });

  void test('sorts fog before turbulent when their front depth ties', () => {
    const fog = { dist: 96, kind: TransparentKind.FogVolume };
    const turbulent = { dist: 96, kind: TransparentKind.Turbulent };
    const items = [turbulent, fog];

    items.sort(TransparentPass.Compare);

    assert.deepEqual(items, [fog, turbulent]);
  });

  void test('treats near-equal distances as a tie for boundary-sharing fog and water', () => {
    const fog = { dist: 96.00005, kind: TransparentKind.FogVolume };
    const turbulent = { dist: 96.0, kind: TransparentKind.Turbulent };
    const items = [turbulent, fog];

    items.sort(TransparentPass.Compare);

    assert.deepEqual(items, [fog, turbulent]);
  });

  void test('ranks tied kinds from fog down to particles', () => {
    const kinds = [
      TransparentKind.Particle,
      TransparentKind.Decal,
      TransparentKind.Sprite,
      TransparentKind.Entity,
      TransparentKind.WorldSurface,
      TransparentKind.Turbulent,
      TransparentKind.FogVolume,
    ];
    const items = kinds.map((kind) => ({ dist: 64.0, kind }));

    items.sort(TransparentPass.Compare);

    assert.deepEqual(items.map((item) => item.kind), [
      TransparentKind.FogVolume,
      TransparentKind.Turbulent,
      TransparentKind.WorldSurface,
      TransparentKind.Entity,
      TransparentKind.Sprite,
      TransparentKind.Decal,
      TransparentKind.Particle,
    ]);
  });

  void test('lets distance win over kind priority outside the tie window', () => {
    const farParticle = { dist: 200, kind: TransparentKind.Particle };
    const nearFog = { dist: 100, kind: TransparentKind.FogVolume };
    const items = [nearFog, farParticle];

    items.sort(TransparentPass.Compare);

    assert.deepEqual(items, [farParticle, nearFog]);
  });
});

void describe('TransparentPass.PlanSceneCopies', () => {
  /**
   * Plans the copies for items described by whether they refract.
   * @param refracts One entry per item.
   * @returns Where the copies are made.
   */
  function plan(refracts: boolean[]): boolean[] {
    const items = refracts.map((refractive, i) => ({ dist: 100 - i, kind: TransparentKind.Turbulent, refractive }));

    return TransparentPass.PlanSceneCopies(items, (item) => item.refractive, []);
  }

  void test('copies nothing when nothing refracts', () => {
    assert.deepEqual(plan([false, false, false]), [false, false, false]);
  });

  void test('copies before the first refracting item, so what was drawn before it shows through', () => {
    assert.deepEqual(plan([false, false, true]), [false, false, true]);
  });

  void test('copies once for a run of refracting items', () => {
    assert.deepEqual(plan([true, true, true]), [true, false, false]);
  });

  void test('copies again after anything that does not refract was drawn in between', () => {
    assert.deepEqual(plan([true, false, true, true, false, true]), [true, false, true, false, false, true]);
  });

  void test('copies again within a run where the owner changes, a nearer wall has to show the liquid before it', () => {
    const wall = {} as ClientEdict;
    const otherWall = {} as ClientEdict;
    const items: TransparentItem[] = [
      { dist: 200, kind: TransparentKind.Turbulent, data: {} as WorldSurfaceBatch },
      { dist: 190, kind: TransparentKind.Turbulent, data: {} as WorldSurfaceBatch },
      { dist: 100, kind: TransparentKind.Entity, data: wall },
      { dist: 90, kind: TransparentKind.Entity, data: otherWall },
      { dist: 80, kind: TransparentKind.Entity, data: otherWall },
      { dist: 70, kind: TransparentKind.RefractiveWorldSurface, data: {} as WorldSurfaceBatch },
    ];

    const result = TransparentPass.PlanSceneCopies(items, () => true, [], TransparentPass.SharesCopy);

    assert.deepEqual(result, [true, false, true, true, false, true]);
  });

  void test('a pass that does not refract copies nothing, whatever the owners are', () => {
    const items = [{ dist: 2, kind: TransparentKind.Turbulent }, { dist: 1, kind: TransparentKind.Entity }];

    assert.deepEqual(TransparentPass.PlanSceneCopies(items, () => false, [], () => false), [false, false]);
  });

  void test('reuses the array it is given, leaving nothing of a longer earlier pass', () => {
    const copyBefore = [true, true, true, true];
    const items = [{ dist: 1, kind: TransparentKind.Particle }];

    const result = TransparentPass.PlanSceneCopies(items, () => false, copyBefore);

    assert.equal(result, copyBefore);
    assert.deepEqual(result, [false]);
  });
});
