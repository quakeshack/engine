import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { BrushModel } from '../../source/engine/common/model/BSP.ts';
import { SpriteModel } from '../../source/engine/common/model/SpriteModel.ts';
import type { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { BrushModelRenderer } from '../../source/engine/client/renderer/models/BrushModelRenderer.ts';
import { modelRendererRegistry } from '../../source/engine/client/renderer/models/ModelRendererRegistry.ts';
import { SpriteModelRenderer } from '../../source/engine/client/renderer/models/SpriteModelRenderer.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import TransparentPass, { TransparentKind } from '../../source/engine/client/renderer/scene/TransparentPass.ts';
import { patchMembers } from '../support/clientState.ts';

/**
 * Builds the part of a client entity the pass reads.
 * @param model The model it draws.
 * @param origin Where it is.
 * @param alpha How opaque it is.
 * @returns The entity.
 */
function createEntity(model: BrushModel | SpriteModel, origin: Vector, alpha = 0.5): ClientEdict {
  return { model, origin, alpha } as unknown as ClientEdict;
}

/**
 * Builds an inline brush model whose geometry sits at the given world bounds.
 * @param mins Lower corner, in world units.
 * @param maxs Upper corner, in world units.
 * @returns The model.
 */
function createSubmodel(mins: Vector, maxs: Vector): BrushModel {
  const model = new BrushModel('*1');

  model.submodel = true;
  model.mins = mins;
  model.maxs = maxs;

  return model;
}

void describe('TransparentPass.Collect', () => {
  let visibleEntities: ClientEdict[] = [];
  let restores: Array<() => void> = [];
  const previousVieworg = new Vector();

  beforeEach(() => {
    visibleEntities = [];
    previousVieworg.set(Camera.refdef.vieworg);
    Camera.refdef.vieworg.setTo(0, 0, 0);

    modelRendererRegistry.register(new BrushModelRenderer());
    modelRendererRegistry.register(new SpriteModelRenderer());

    restores = [
      patchMembers(rendererCvars, { drawentities: { value: 1 } }),
      patchMembers(clientRuntimeState, {
        clientEntities: {
          * getVisibleEntities() {
            yield* visibleEntities;
          },
        },
      }),
    ];
  });

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }

    Camera.refdef.vieworg.set(previousVieworg);
    modelRendererRegistry.clear();
  });

  // The world entity has no brush model here, so only decals, particles and entities are gathered.
  const worldEntity = { model: null } as unknown as ClientEdict;

  void test('ranks a sprite by the distance of its origin', () => {
    visibleEntities.push(createEntity(new SpriteModel('sprites/flame.spr'), new Vector(300, 0, 0)));

    const items = TransparentPass.Collect(worldEntity);

    assert.equal(items.length, 1);
    assert.equal(items[0].kind, TransparentKind.Sprite);
    assert.equal(items[0].dist, 300);
  });

  void test('ranks a brush entity by how far its geometry is, not by its origin', () => {
    // An inline brush model keeps its vertices at world coordinates, so a func_wall that never moves has
    // the origin 0 0 0 wherever it is in the map. This one is a window 500 units along +x.
    const window = createEntity(
      createSubmodel(new Vector(500, -64, -64), new Vector(508, 64, 64)),
      new Vector(0, 0, 0),
    );
    visibleEntities.push(window);

    const items = TransparentPass.Collect(worldEntity);

    assert.equal(items.length, 1);
    assert.equal(items[0].kind, TransparentKind.Entity);
    assert.equal(items[0].dist, 500);
  });

  void test('offsets the bounds of a brush entity by its origin', () => {
    // A door that has moved 100 units: geometry at x 200..208 at rest, entity origin x = 100.
    const door = createEntity(
      createSubmodel(new Vector(200, -32, -32), new Vector(208, 32, 32)),
      new Vector(100, 0, 0),
    );
    visibleEntities.push(door);

    const items = TransparentPass.Collect(worldEntity);

    assert.equal(items[0].dist, 300);
  });

  void test('bounds a brush model that is not a submodel by its radius around the origin', () => {
    // A pickup like b_batt0.bsp is its own file: the vertices are centered on the origin.
    const model = new BrushModel('maps/b_batt0.bsp');
    model.radius = 16;
    visibleEntities.push(createEntity(model, new Vector(0, 200, 0)));

    const items = TransparentPass.Collect(worldEntity);

    assert.equal(items[0].dist, 184);
  });

  void test('is zero for a view origin inside the bounds of a brush entity', () => {
    // The nearest point of a box that contains the view is the view itself, which is how a window the
    // player stands in ranks in front of everything that is further away.
    visibleEntities.push(createEntity(
      createSubmodel(new Vector(-64, -64, -64), new Vector(64, 64, 64)),
      new Vector(0, 0, 0),
    ));

    const items = TransparentPass.Collect(worldEntity);

    assert.equal(items[0].dist, 0);
  });

  void test('draws a sprite in front of a window that is behind it, and a nearer window in front of a sprite', () => {
    const farWindow = createEntity(
      createSubmodel(new Vector(500, -64, -64), new Vector(508, 64, 64)),
      new Vector(0, 0, 0),
    );
    const nearWindow = createEntity(
      createSubmodel(new Vector(100, -64, -64), new Vector(108, 64, 64)),
      new Vector(0, 0, 0),
    );
    const sprite = createEntity(new SpriteModel('sprites/flame.spr'), new Vector(300, 0, 0));
    visibleEntities.push(nearWindow, sprite, farWindow);

    const items = [...TransparentPass.Collect(worldEntity)].sort(TransparentPass.Compare);

    assert.deepEqual(items.map((item) => item.data), [farWindow, sprite, nearWindow]);
  });
});
