import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import TransparentPass, { REFRACTION_MAX_SHIFT, TransparentKind, type TransparentItem } from '../../source/engine/client/renderer/scene/TransparentPass.ts';
import type { ScreenRect } from '../../source/engine/client/renderer/scene/Camera.ts';
import type { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import type { WorldSurfaceBatch } from '../../source/engine/common/model/BSP.ts';
import { assertNear } from '../support/assertions.ts';

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

void describe('TransparentPass.PlanCopyRects', () => {
  interface PlannedItem {
    readonly strength: number;
    readonly bounds: ScreenRect;
  }

  /**
   * Builds an item of the plan.
   * @param strength How strongly it refracts.
   * @param bounds Lower left and upper right corner, 0..1.
   * @returns The item.
   */
  function item(strength: number, ...bounds: [number, number, number, number]): PlannedItem {
    return { strength, bounds: { x0: bounds[0], y0: bounds[1], x1: bounds[2], y1: bounds[3] } };
  }

  /**
   * Plans the rectangles of the copies.
   * @param items The items in drawing order.
   * @param copyBefore Where the copies are.
   * @param rects Where they go, a reused array in the test that asks for it.
   * @returns The rectangles.
   */
  function plan(items: PlannedItem[], copyBefore: boolean[], rects: ScreenRect[] = []): ScreenRect[] {
    TransparentPass.PlanCopyRects(items, copyBefore, (planned) => planned.strength, (planned, out) => Object.assign(out, planned.bounds), rects);

    return rects;
  }

  void test('makes no rectangle when nothing is copied', () => {
    assert.deepEqual(plan([item(0, 0.1, 0.1, 0.2, 0.2)], [false]), []);
  });

  void test('grows the rectangle by how far the surface can shift', () => {
    const [rect] = plan([item(1, 0.4, 0.4, 0.5, 0.5)], [true]);

    assertNear(rect.x0, 0.4 - REFRACTION_MAX_SHIFT);
    assertNear(rect.y1, 0.5 + REFRACTION_MAX_SHIFT);
  });

  // `_qs_waterrefraction 2` or a material's `refraction` shift further: with a fixed padding they would sample old
  // pixels around the edge of the surface
  void test('grows it further for a stronger surface, strength has no upper limit', () => {
    const [rect] = plan([item(3, 0.4, 0.4, 0.5, 0.5)], [true]);

    assertNear(rect.x0, 0.4 - 3 * REFRACTION_MAX_SHIFT);
    assertNear(rect.x1, 0.5 + 3 * REFRACTION_MAX_SHIFT);
  });

  void test('covers every item of a run, not only the one the copy is made for', () => {
    const rects = plan([item(1, 0.1, 0.1, 0.2, 0.2), item(1, 0.7, 0.6, 0.8, 0.9)], [true, false]);

    assert.equal(rects.length, 1);
    assertNear(rects[0].x0, 0.1 - REFRACTION_MAX_SHIFT);
    assertNear(rects[0].y1, 0.9 + REFRACTION_MAX_SHIFT);
  });

  void test('gives each copy its own rectangle, in drawing order', () => {
    const rects = plan([item(1, 0.1, 0.1, 0.2, 0.2), item(1, 0.7, 0.7, 0.8, 0.8)], [true, true]);

    assert.equal(rects.length, 2);
    assertNear(rects[0].x1, 0.2 + REFRACTION_MAX_SHIFT);
    assertNear(rects[1].x0, 0.7 - REFRACTION_MAX_SHIFT);
  });

  void test('leaves out items that do not refract, they sample nothing', () => {
    const rects = plan([item(0, 0.0, 0.0, 1.0, 1.0), item(1, 0.4, 0.4, 0.5, 0.5), item(0, 0.0, 0.0, 1.0, 1.0)], [false, true, false]);

    assertNear(rects[0].x0, 0.4 - REFRACTION_MAX_SHIFT);
    assertNear(rects[0].x1, 0.5 + REFRACTION_MAX_SHIFT);
  });

  void test('starts over on a reused array, nothing of the last frame stays in a rectangle', () => {
    const rects = plan([item(1, 0.0, 0.0, 1.0, 1.0)], [true]);

    plan([item(1, 0.4, 0.4, 0.5, 0.5)], [true], rects);

    assert.equal(rects.length, 1);
    assertNear(rects[0].x0, 0.4 - REFRACTION_MAX_SHIFT);
  });

  void test('asks for the same shift as the shader, or the copy stops short of what it samples', () => {
    const chunk = readFileSync(new URL('../../source/engine/client/shaders/include/refraction.glsl', import.meta.url), 'utf8');

    assert.equal(Number(/const float REFRACTION_MAX_SHIFT = ([\d.]+);/.exec(chunk)![1]), REFRACTION_MAX_SHIFT);
  });
});
