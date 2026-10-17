import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Octree, type OctreeItem, type OctreeNode } from '../../source/shared/Octree.ts';
import Vector from '../../source/shared/Vector.ts';

type TestOctreeNode = OctreeNode<TestItem>;

interface TestItem extends OctreeItem<TestItem> {
  /** Item identifier. */
  name: string;
  /** Item origin. */
  origin: Vector;
  /** Minimum bounds when the item has box extents. */
  absmin: Vector | null;
  /** Maximum bounds when the item has box extents. */
  absmax: Vector | null;
  /** Node currently storing the item. */
  octreeNode: TestOctreeNode | null;
}

/**
 * @param name item identifier
 * @param origin item origin
 * @returns point item
 */
function createPointItem(name: string, origin: Vector): TestItem {
  return {
    name,
    origin,
    absmin: null,
    absmax: null,
    octreeNode: null,
  };
}

/**
 * @param name item identifier
 * @param origin item origin
 * @param mins local minimum bounds
 * @param maxs local maximum bounds
 * @returns bounded item
 */
function createBoxItem(name: string, origin: Vector, mins: Vector, maxs: Vector): TestItem {
  return {
    name,
    origin,
    absmin: origin.copy().add(mins),
    absmax: origin.copy().add(maxs),
    octreeNode: null,
  };
}

/**
 * @param tree octree under test
 * @param item item to insert and track
 * @returns node that stored the item
 */
function insertTracked(tree: Octree<TestItem>, item: TestItem): TestOctreeNode {
  const node = tree.insert(item);
  assert.notEqual(node, null);
  item.octreeNode = node;
  return node!;
}

/**
 * @param node node whose children must exist
 * @returns node children
 */
function requireChildren(node: OctreeNode<TestItem>): TestOctreeNode[] {
  assert.notEqual(node.children, null);
  return node.children!;
}

void describe('Octree', () => {
  void test('splits into children once capacity is exceeded', () => {
    const tree = new Octree<TestItem>(new Vector(0, 0, 0), 16, 1, 1);
    const first = createPointItem('first', new Vector(-4, -4, -4));
    const second = createPointItem('second', new Vector(4, 4, 4));

    insertTracked(tree, first);
    insertTracked(tree, second);

    const children = requireChildren(tree.root);

    assert.equal(children.length, 8);
    assert.equal(tree.root.items.length, 0);
    assert.equal(tree.root.totalCount, 2);
    assert.notEqual(first.octreeNode, tree.root);
    assert.notEqual(second.octreeNode, tree.root);
    assert.deepEqual(
      [...tree.queryAABB(new Vector(-16, -16, -16), new Vector(16, 16, 16))].map((item) => item.name).sort(),
      ['first', 'second'],
    );
  });

  void test('keeps oversized bounds in the parent after a split', () => {
    const tree = new Octree<TestItem>(new Vector(0, 0, 0), 16, 1, 1);
    const anchor = createPointItem('anchor', new Vector(10, 10, 10));
    const straddling = createBoxItem('straddling', new Vector(0, 0, 0), new Vector(-2, -2, -2), new Vector(2, 2, 2));

    insertTracked(tree, anchor);
    insertTracked(tree, straddling);

    requireChildren(tree.root);

    assert.equal(tree.root.items.length, 1);
    assert.equal(tree.root.items[0], straddling);
    assert.equal(straddling.octreeNode, tree.root);
    assert.notEqual(anchor.octreeNode, tree.root);
  });

  void test('merges children back into the parent when removals drop below capacity', () => {
    const tree = new Octree<TestItem>(new Vector(0, 0, 0), 16, 1, 1);
    const first = createPointItem('first', new Vector(-4, -4, -4));
    const second = createPointItem('second', new Vector(4, 4, 4));

    insertTracked(tree, first);
    insertTracked(tree, second);

    assert.equal(tree.remove(second), true);

    assert.equal(tree.root.children, null);
    assert.equal(tree.root.totalCount, 1);
    assert.deepEqual(tree.root.items.map((item) => item.name), ['first']);
    assert.equal(first.octreeNode, tree.root);
    assert.equal(second.octreeNode, null);
  });
});
