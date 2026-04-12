import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { AliasModel } from '../../source/engine/common/model/AliasModel.ts';

function createPoseVertex(x, y, z) {
  return {
    v: new Vector(x, y, z),
    lightnormalindex: 0,
  };
}

void describe('AliasModel', () => {
  void describe('getCollisionBounds', () => {
    void test('covers every pose and respects scale origin with signed scale', () => {
      const model = new AliasModel('progs/test.mdl');
      model._scale = new Vector(-2, 3, -4);
      model._scale_origin = new Vector(10, -5, 20);
      model.frames = [
        {
          group: false,
          bboxmin: new Vector(1, 0, 2),
          bboxmax: new Vector(4, 2, 5),
          name: 'idle',
          v: [createPoseVertex(1, 0, 2)],
        },
        {
          group: true,
          bboxmin: new Vector(),
          bboxmax: new Vector(),
          frames: [
            {
              interval: 0.5,
              bboxmin: new Vector(0, 3, 1),
              bboxmax: new Vector(6, 4, 7),
              name: 'step',
              v: [createPoseVertex(0, 3, 1)],
            },
          ],
        },
      ];

      const bounds = model.getCollisionBounds();

      assert.notEqual(bounds, null);
      assert.deepEqual([...bounds.mins], [-2, -5, -8]);
      assert.deepEqual([...bounds.maxs], [10, 7, 16]);
    });
  });

  void describe('resolveCollisionFrame', () => {
    void test('resolves grouped frames from the current time without lerping', () => {
      const model = new AliasModel('progs/grouped-test.mdl');
      model.frames = [
        {
          group: true,
          bboxmin: new Vector(),
          bboxmax: new Vector(),
          frames: [
            {
              interval: 0.25,
              bboxmin: new Vector(),
              bboxmax: new Vector(),
              name: 'frame-a',
              v: [createPoseVertex(0, 0, 0)],
            },
            {
              interval: 0.5,
              bboxmin: new Vector(),
              bboxmax: new Vector(),
              name: 'frame-b',
              v: [createPoseVertex(1, 0, 0)],
            },
            {
              interval: 1.0,
              bboxmin: new Vector(),
              bboxmax: new Vector(),
              name: 'frame-c',
              v: [createPoseVertex(2, 0, 0)],
            },
          ],
        },
      ];

      assert.equal(model.resolveCollisionFrame(0, 0.10)?.name, 'frame-a');
      assert.equal(model.resolveCollisionFrame(0, 0.30)?.name, 'frame-b');
      assert.equal(model.resolveCollisionFrame(0, 0.90)?.name, 'frame-c');
      assert.equal(model.resolveCollisionFrame(0, 1.10)?.name, 'frame-a');
    });
  });
});
