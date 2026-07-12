import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { BrushModel, Visibility } from '../../source/engine/common/model/BSP.ts';
import Vector from '../../source/shared/Vector.ts';

void describe('Visibility.mergeFrom', () => {
  /**
   * Builds a minimal real BrushModel instance for Visibility construction.
   * `Visibility.fromBrushModel` asserts its `model` argument is an actual BrushModel, so a
   * duck-typed plain object won't do here.
   * @returns {BrushModel} model fixture.
   */
  function buildFixtureModel() {
    const model = new BrushModel('test-model');
    model.numclusters = 8;
    model.visdata = new Uint8Array(0);
    model.leafs = [{ cluster: 0 }, { cluster: 1 }, { cluster: 2 }];

    return model;
  }

  void test('unions revealed clusters from another Visibility instance', () => {
    const model = buildFixtureModel();

    const visA = Visibility.fromBrushModel(model, 0, new Uint8Array([0x02])); // reveals cluster 1
    const visB = Visibility.fromBrushModel(model, 0, new Uint8Array([0x04])); // reveals cluster 2

    const merged = new Visibility(model);
    merged.mergeFrom(visA);
    merged.mergeFrom(visB);

    assert.equal(merged.isRevealed(0), false);
    assert.equal(merged.isRevealed(1), true);
    assert.equal(merged.isRevealed(2), true);
    assert.deepEqual(
      [merged.areRevealed([0]), merged.areRevealed([1]), merged.areRevealed([2])],
      [false, true, true],
    );
  });

  void test('propagates unconditional reveal from the merged-in instance', () => {
    const model = buildFixtureModel();

    const hidden = new Visibility(model);
    const revealed = new Visibility(model).revealAll();

    hidden.mergeFrom(revealed);

    assert.equal(hidden.areRevealed([0]), true);
    assert.equal(hidden.areRevealed([999]), true); // unconditional reveal ignores leaf validity
  });
});

void describe('BrushModel.getPhsByLeafs', () => {
  /**
   * Builds a minimal BrushModel with hand-crafted PHS rows for two clusters.
   * Leaf index 0 is reserved (matches the real "outside/solid" leaf convention that
   * getPhsByLeaf special-cases), so occupied leafs start at index 1.
   * @returns {BrushModel} model fixture.
   */
  function buildFixtureModel() {
    const model = new BrushModel('test-model');
    model.numclusters = 8;
    model.visdata = new Uint8Array(0);
    // cluster 0's PHS row reveals cluster 1 (0x02); cluster 1's PHS row reveals cluster 2 (0x04).
    model.phsdata = new Uint8Array([0x02, 0x04]);
    model.clusterPhsOffsets = [0, 1];
    model.leafs = [
      { cluster: -1 }, // index 0: reserved outside/solid leaf, never contributes
      { cluster: 0 },  // index 1: entity-occupied leaf A
      { cluster: 1 },  // index 2: entity-occupied leaf B
      { cluster: 2 },  // index 3: a client leaf only reachable through leaf B's row
    ];

    return model;
  }

  void test('merges PHS across every leaf an entity occupies, reaching beyond any single leaf\'s own row', () => {
    const model = buildFixtureModel();

    const merged = model.getPhsByLeafs([1, 2]);

    assert.equal(merged.isRevealed(1), false); // leaf A's own cluster never appears in either row
    assert.equal(merged.isRevealed(2), true); // reached via leaf A's row (cluster 0 -> cluster 1)
    assert.equal(merged.isRevealed(3), true); // reached via leaf B's row (cluster 1 -> cluster 2), missed if only leaf A were sampled
  });

  void test('ignores unknown leaf indices without throwing', () => {
    const model = buildFixtureModel();

    const merged = model.getPhsByLeafs([1, 99]);

    assert.equal(merged.isRevealed(2), true);
  });

  void test('returns a fully hidden result for an entity with no linked leafs', () => {
    const model = buildFixtureModel();

    const merged = model.getPhsByLeafs([]);

    assert.equal(merged.areRevealed([1, 2, 3]), false);
  });
});

void describe('BrushModel.getFatPhsByPoint', () => {
  void test('recovers PHS across a plane split when the point sits inside solid content near a wall', () => {
    const model = new BrushModel('test-model');
    model.numclusters = 8;
    model.visdata = new Uint8Array(0);
    model.clusterPhsOffsets = [0];
    model.phsdata = new Uint8Array([0x02]); // cluster 0's row reveals cluster 1

    const solidLeaf = { cluster: -1, contents: -2 }; // CONTENT_SOLID, must never contribute
    const openLeaf = { cluster: 0, contents: -1 }; // CONTENT_EMPTY, the room beside the wall

    model.nodes = [{
      contents: 0, // CONTENT_NONE: internal split node, not a leaf
      plane: { normal: new Vector(1, 0, 0), dist: 0 },
      children: [solidLeaf, openLeaf],
    }];
    model.leafs = [{ cluster: 1 }];

    // 2 units past the plane, on the solid side: a strict single-path descent lands in the
    // solid leaf and yields nothing. Within the 8-unit fat-point fudge, both sides are merged,
    // and the open-air leaf's PHS row is picked up.
    const merged = model.getFatPhsByPoint(new Vector(2, 0, 0));

    assert.equal(merged.isRevealed(0), true);
  });

  void test('does not merge anything beyond the 8-unit fudge, matching a single strict leaf', () => {
    const model = new BrushModel('test-model');
    model.numclusters = 8;
    model.visdata = new Uint8Array(0);
    model.clusterPhsOffsets = [0];
    model.phsdata = new Uint8Array([0x02]); // cluster 0's row reveals cluster 1

    const solidLeaf = { cluster: -1, contents: -2 };
    const openLeaf = { cluster: 0, contents: -1 };

    model.nodes = [{
      contents: 0,
      plane: { normal: new Vector(1, 0, 0), dist: 0 },
      children: [solidLeaf, openLeaf],
    }];
    model.leafs = [{ cluster: 1 }];

    // 20 units past the plane, well outside the fudge: only the solid leaf is visited, which
    // never contributes, so the result stays fully hidden.
    const merged = model.getFatPhsByPoint(new Vector(20, 0, 0));

    assert.equal(merged.isRevealed(0), false);
  });
});
