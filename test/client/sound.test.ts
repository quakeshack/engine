import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { BrushModel } from '../../source/engine/common/model/BSP.ts';
import Sound from '../../source/engine/client/Sound.ts';
import Vector from '../../source/shared/Vector.ts';
import { createTreeModel } from '../support/bspTree.ts';
import { installEngineMocks } from '../support/withEngineMocks.ts';

void describe('Sound.IsPositionAudible', () => {
  /**
   * Builds a minimal BrushModel where every point is in the source leaf (cluster 0), the tree splits so far out that
   * no test point reaches the other side. The listener sits in leaf 0 (cluster 5).
   * @param sourceReveals whether the source leaf's PHS row reveals the listener's cluster
   * @returns fixture.
   */
  function buildSingleLeafFixture(sourceReveals: boolean): { model: BrushModel, listenerLeaf: number } {
    const model = createTreeModel(
      [{ normal: [1, 0, 0], dist: 1e8, type: 0 }],
      [{ planeNum: 0, children: [~1, ~1] }],
      [{ contents: -1, cluster: 5 }, { contents: -1, cluster: 0 }], // CONTENT_EMPTY leafs: the listener's, then the source's
    );
    model.numclusters = 8;
    model.visdata = new Uint8Array(0);
    model.clusterPhsOffsets = [0];
    model.phsdata = new Uint8Array([sourceReveals ? 0x20 : 0x00]); // cluster 0's row; bit5 = listener's cluster

    return { model, listenerLeaf: 0 };
  }

  /**
   * Installs a minimal client registry context for IsPositionAudible tests.
   * @param options fixture overrides
   * @returns context handle
   */
  function installClientContext({ worldmodel = null }: { worldmodel?: BrushModel | null } = {}): { restore: () => void } {
    const previousListenerLeaf = Sound._listenerLeaf;

    const restoreEngineMocks = installEngineMocks({ CL: { state: { worldmodel } } });

    return {
      restore() {
        restoreEngineMocks();
        Sound._listenerLeaf = previousListenerLeaf;
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
    // leaf 0 is the listener's (cluster 5), leaf 1 the solid one, which must never contribute, leaf 2 the open room beside the wall
    const model = createTreeModel(
      [{ normal: [1, 0, 0], dist: 0, type: 0 }],
      [{ planeNum: 0, children: [~1, ~2] }],
      [{ contents: -1, cluster: 5 }, { contents: -2, cluster: -1 }, { contents: -1, cluster: 0 }],
    );
    model.numclusters = 8;
    model.visdata = new Uint8Array(0);
    model.clusterPhsOffsets = [0];
    model.phsdata = new Uint8Array([0x20]); // cluster 0's row reveals cluster 5 (the listener's cluster)

    const listenerLeaf = 0;

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
