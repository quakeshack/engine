import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { LeafTable, NodeTable } from '../../source/engine/common/model/BspTree.ts';

/**
 * Builds nodes from their children.
 * @param children Front and back child of each node: a node index, or `~leaf`.
 * @returns The nodes.
 */
function createNodes(children: readonly (readonly [number, number])[]): NodeTable {
  const nodes = new NodeTable(children.length);

  children.forEach(([front, back], index) => {
    nodes.children[index * 2] = front;
    nodes.children[index * 2 + 1] = back;
  });

  return nodes;
}

void describe('NodeTable', () => {
  void describe('linkParents', () => {
    void test('sets the parent of every node and leaf below the root', () => {
      // 0 -> [1, 2], 1 -> [leaf 1, leaf 2], 2 -> [leaf 3, leaf 4]
      const nodes = createNodes([[1, 2], [~1, ~2], [~3, ~4]]);
      const leafs = new LeafTable(5);

      nodes.linkParents(leafs);

      assert.deepEqual([...nodes.parents], [-1, 0, 0]);
      assert.deepEqual([...leafs.parents].slice(1), [1, 1, 2, 2]);
    });

    void test('leaves the subtree of an inline model alone, which shares leafs with the world', () => {
      // the world: 0 -> [leaf 1, leaf 2]; an inline model hangs from node 1, which nothing refers to, and has leaf 2 as well
      const nodes = createNodes([[~1, ~2], [~2, ~3]]);
      const leafs = new LeafTable(4);

      nodes.linkParents(leafs);

      assert.deepEqual([...nodes.parents], [-1, -1]);
      assert.equal(leafs.parents[1], 0);
      assert.equal(leafs.parents[2], 0, 'a leaf has the parent it has in the world tree');
      assert.equal(leafs.parents[3], -1, 'a leaf only the inline model reaches has none');
    });

    void test('resets what an earlier call set, and copes with an empty tree', () => {
      const nodes = createNodes([[~0, ~1]]);
      const leafs = new LeafTable(2);

      nodes.linkParents(leafs);
      assert.equal(leafs.parents[0], 0);

      new NodeTable(0).linkParents(new LeafTable(0));
    });
  });

  void describe('tables', () => {
    void test('start without clusters and visibility offsets, solid and empty-handed', () => {
      const leafs = new LeafTable(2);

      assert.deepEqual([...leafs.clusters], [-1, -1]);
      assert.deepEqual([...leafs.visofs], [-1, -1]);
      assert.deepEqual([...leafs.numMarkSurfaces], [0, 0]);
      assert.equal(leafs.ambient.length, 8);
      assert.equal(leafs.bounds.length, 12);
    });
  });
});
