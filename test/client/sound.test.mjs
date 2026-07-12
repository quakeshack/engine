import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { eventBus, registry } from '../../source/engine/registry.ts';
import { BrushModel } from '../../source/engine/common/model/BSP.ts';
import Sound from '../../source/engine/client/Sound.ts';
import Vector from '../../source/shared/Vector.ts';

void describe('Sound.IsPositionAudible', () => {
  /**
   * Builds a minimal single-leaf BrushModel: `nodes[0]` IS the source leaf directly, no plane
   * split needed. The listener sits in its own leaf (cluster 5) tracked separately in `leafs`.
   * @param {boolean} sourceReveals whether the source leaf's PHS row reveals the listener's cluster
   * @returns {{ model: BrushModel, listenerLeaf: object }} fixture.
   */
  function buildSingleLeafFixture(sourceReveals) {
    const model = new BrushModel('test-model');
    model.numclusters = 8;
    model.visdata = new Uint8Array(0);
    model.clusterPhsOffsets = [0];
    model.phsdata = new Uint8Array([sourceReveals ? 0x20 : 0x00]); // cluster 0's row; bit5 = listener's cluster

    model.nodes = [{ contents: -1, cluster: 0 }]; // CONTENT_EMPTY leaf, cluster 0

    const listenerLeaf = { num: 0, cluster: 5 };
    model.leafs = [listenerLeaf];

    return { model, listenerLeaf };
  }

  /**
   * Installs a minimal client registry context for IsPositionAudible tests.
   * @param {{ worldmodel?: object | null }} options fixture overrides
   * @returns {{ restore: () => void }} context handle
   */
  function installClientContext({ worldmodel = null } = {}) {
    const previousCL = registry.CL;
    const previousListenerLeaf = Sound._listenerLeaf;

    registry.CL = { state: { worldmodel } };
    eventBus.publish('registry.frozen');

    return {
      restore() {
        registry.CL = previousCL;
        Sound._listenerLeaf = previousListenerLeaf;
        eventBus.publish('registry.frozen');
      },
    };
  }

  void test('returns true when the source position\'s PHS reveals the listener\'s cluster', () => {
    const { model, listenerLeaf } = buildSingleLeafFixture(true);
    const context = installClientContext({ worldmodel: model });

    try {
      Sound._listenerLeaf = listenerLeaf;

      assert.equal(Sound.IsPositionAudible(new Vector(0, 0, 0)), true);
    } finally {
      context.restore();
    }
  });

  void test('returns false when the source position\'s PHS does not reveal the listener\'s cluster', () => {
    const { model, listenerLeaf } = buildSingleLeafFixture(false);
    const context = installClientContext({ worldmodel: model });

    try {
      Sound._listenerLeaf = listenerLeaf;

      assert.equal(Sound.IsPositionAudible(new Vector(0, 0, 0)), false);
    } finally {
      context.restore();
    }
  });

  void test('resolves audibility via the fat-point PHS when the source sits inside solid content near a wall (e.g. an explosion impact)', () => {
    const model = new BrushModel('test-model');
    model.numclusters = 8;
    model.visdata = new Uint8Array(0);
    model.clusterPhsOffsets = [0];
    model.phsdata = new Uint8Array([0x20]); // cluster 0's row reveals cluster 5 (the listener's cluster)

    const solidLeaf = { contents: -2, cluster: -1 }; // CONTENT_SOLID, must never contribute
    const openLeaf = { contents: -1, cluster: 0 }; // CONTENT_EMPTY, the room beside the wall

    model.nodes = [{
      contents: 0, // CONTENT_NONE: internal split node, not a leaf
      plane: { normal: new Vector(1, 0, 0), dist: 0 },
      children: [solidLeaf, openLeaf],
    }];

    const listenerLeaf = { num: 0, cluster: 5 };
    model.leafs = [listenerLeaf];

    const context = installClientContext({ worldmodel: model });

    try {
      Sound._listenerLeaf = listenerLeaf;

      // 2 units past the plane on the solid side: a strict single-path descent (as plain
      // getLeafForPoint would do) lands in the solid leaf and reads as inaudible. Within the
      // 8-unit fat-point fudge both sides are merged, and the open-air leaf's PHS correctly
      // reveals the listener — matching a real explosion's impact point against geometry.
      assert.equal(Sound.IsPositionAudible(new Vector(2, 0, 0)), true);
    } finally {
      context.restore();
    }
  });

  void test('defaults to audible when there is no worldmodel loaded', () => {
    const context = installClientContext({ worldmodel: null });

    try {
      Sound._listenerLeaf = null;

      assert.equal(Sound.IsPositionAudible(new Vector(0, 0, 0)), true);
    } finally {
      context.restore();
    }
  });

  void test('defaults to audible when the listener leaf has not been established yet', () => {
    const { model } = buildSingleLeafFixture(true);
    const context = installClientContext({ worldmodel: model });

    try {
      Sound._listenerLeaf = null;

      assert.equal(Sound.IsPositionAudible(new Vector(0, 0, 0)), true);
    } finally {
      context.restore();
    }
  });

  void test('defaults to audible when the worldmodel has no compiled PHS data', () => {
    const { model, listenerLeaf } = buildSingleLeafFixture(false);
    model.phsdata = null;
    const context = installClientContext({ worldmodel: model });

    try {
      Sound._listenerLeaf = listenerLeaf;

      assert.equal(Sound.IsPositionAudible(new Vector(0, 0, 0)), true);
    } finally {
      context.restore();
    }
  });
});
