import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { moveType, solid } from '../../source/shared/Defs.ts';
import { BrushModel } from '../../source/engine/common/Mod.ts';
import type { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import type { CollisionModelSource } from '../../source/engine/common/CollisionModelSource.ts';
import { EntityHulls } from '../../source/engine/common/collision/EntityHulls.ts';
import { ClipTree, Hull, PlaneTable } from '../../source/engine/common/collision/Hull.ts';
import type { ServerEdict } from '../../source/engine/server/Edict.ts';

/** Fields of an entity that a hull is picked by. */
interface HullEntity {
  origin: Vector;
  mins: Vector;
  maxs: Vector;
  solid: solid;
  modelindex: number;
  movetype: moveType;
}

/**
 * Makes an edict around an entity.
 * @returns The edict.
 */
function createEdict(fields: Partial<HullEntity>): ServerEdict {
  const entity: HullEntity = {
    origin: new Vector(),
    mins: new Vector(),
    maxs: new Vector(),
    solid: solid.SOLID_NOT,
    modelindex: 0,
    movetype: moveType.MOVETYPE_NONE,
    ...fields,
  };

  return { entity } as unknown as ServerEdict;
}

/**
 * Makes a brush model whose three hulls are told apart by their clip bounds.
 * @returns The model.
 */
function createDoorModel(): BrushModel {
  const model = new BrushModel('*1');

  model.hulls = [0, 1, 2].map((index) => new Hull(new PlaneTable(0), new ClipTree(0), new Vector(-index * 10, -index * 10, -index * 10)));

  return model;
}

/**
 * Makes a model source that knows the given models by index.
 * @returns The source.
 */
function createSource(models: Array<BaseModel | null>): CollisionModelSource {
  return { getWorldEntity: () => null, getWorldModel: () => null, getModelByIndex: (index) => models[index] ?? null };
}

void describe('EntityHulls', () => {
  void describe('for an entity without a brush model', () => {
    void test('is a box around the entity, with the extents of what moves added to its sides', () => {
      const hulls = new EntityHulls(createSource([]));
      const offset = new Vector();
      const edict = createEdict({ origin: new Vector(10, 20, 30), mins: new Vector(-16, -16, -24), maxs: new Vector(16, 16, 32), solid: solid.SOLID_BBOX });
      const hull = hulls.forEntity(edict, new Vector(-4, -5, -6), new Vector(7, 8, 9), offset);

      assert.deepEqual([...offset], [10, 20, 30], 'the box sits at the origin of the entity');
      // the planes are the entity's bounds pushed out by the mover's: max - mover mins, min - mover maxs
      assert.deepEqual([...hull.planes.dists], [16 + 4, -16 - 7, 16 + 5, -16 - 8, 32 + 6, -24 - 9]);
      assert.equal(hull.firstClipNode, 0);
      assert.equal(hull.lastClipNode, 5);
    });

    void test('is the same box hull every time, updated in place', () => {
      const hulls = new EntityHulls(createSource([]));
      const first = hulls.forEntity(createEdict({ maxs: new Vector(1, 1, 1), mins: new Vector(-1, -1, -1) }), Vector.origin, Vector.origin, new Vector());
      const second = hulls.forEntity(createEdict({ maxs: new Vector(5, 5, 5), mins: new Vector(-5, -5, -5) }), Vector.origin, Vector.origin, new Vector());

      assert.equal(first, second);
      assert.equal(second.planes.dists[0], 5);
    });

    void test('is also the hull of a BSP entity whose model this realm does not have', () => {
      const hulls = new EntityHulls(createSource([]));
      const offset = new Vector();
      const edict = createEdict({ origin: new Vector(1, 2, 3), solid: solid.SOLID_BSP, modelindex: 1, movetype: moveType.MOVETYPE_PUSH });

      assert.equal(hulls.forEntity(edict, Vector.origin, Vector.origin, offset).planes.count, 6);
      assert.deepEqual([...offset], [1, 2, 3]);
    });

    void test('keeps its own box for each instance, one realm does not move the other\'s', () => {
      const server = new EntityHulls(createSource([]));
      const client = new EntityHulls(createSource([]));
      const edict = createEdict({ maxs: new Vector(9, 9, 9) });

      server.forEntity(edict, Vector.origin, Vector.origin, new Vector());

      assert.equal(client.forEntity(createEdict({ maxs: new Vector(2, 2, 2) }), Vector.origin, Vector.origin, new Vector()).planes.dists[0], 2);
      assert.equal(server.forEntity(edict, Vector.origin, Vector.origin, new Vector()).planes.dists[0], 9);
    });
  });

  void describe('for a BSP entity', () => {
    const door = createDoorModel();
    const hulls = new EntityHulls(createSource([null, door]));

    /**
     * Asks for the hull of the door for something of the given width.
     * @returns The hull and the offset.
     */
    function hullFor(width: number): { hull: unknown; offset: Vector } {
      const offset = new Vector();
      const edict = createEdict({ origin: new Vector(100, 200, 300), solid: solid.SOLID_BSP, modelindex: 1, movetype: moveType.MOVETYPE_PUSH });

      return { hull: hulls.forEntity(edict, new Vector(-width / 2, -width / 2, -width / 2), new Vector(width / 2, width / 2, width / 2), offset), offset };
    }

    void test('picks the point hull for something thinner than 3 units', () => {
      assert.equal(hullFor(2).hull, door.hulls[0]);
    });

    void test('picks the standing hull up to 32 units', () => {
      assert.equal(hullFor(3).hull, door.hulls[1]);
      assert.equal(hullFor(32).hull, door.hulls[1]);
    });

    void test('picks the large hull above 32 units', () => {
      assert.equal(hullFor(33).hull, door.hulls[2]);
    });

    void test('offsets by the clip bounds of the hull, the mover and the origin of the entity', () => {
      // hull 1: clipMins = -10; mover mins = -16 -> -10 - (-16) + origin
      assert.deepEqual([...hullFor(32).offset], [-10 + 16 + 100, -10 + 16 + 200, -10 + 16 + 300]);
    });
  });
});
