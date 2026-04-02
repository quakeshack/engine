import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Octree } from '../../source/shared/Octree.mjs';
import Vector from '../../source/shared/Vector.ts';

/** @typedef {import('../../source/shared/Octree.mjs').OctreeNode<TestItem>} TestOctreeNode */

/**
 * @typedef TestItem
 * @property {string} name item identifier
 * @property {Vector} origin item origin
 * @property {Vector|null} absmin minimum bounds when the item has box extents
 * @property {Vector|null} absmax maximum bounds when the item has box extents
 * @property {TestOctreeNode|null} octreeNode node currently storing the item
 */

/**
 * @param {string} name item identifier
 * @param {Vector} origin item origin
 * @returns {TestItem} point item
 */
function createPointItem(name, origin) {
  return {
    name,
    origin,
    absmin: null,
    absmax: null,
    octreeNode: null,
  };
}

/**
 * @param {string} name item identifier
 * @param {Vector} origin item origin
 * @param {Vector} mins local minimum bounds
 * @param {Vector} maxs local maximum bounds
 * @returns {TestItem} bounded item
 */
function createBoxItem(name, origin, mins, maxs) {
  return {
    name,
    origin,
    absmin: origin.copy().add(mins),
    absmax: origin.copy().add(maxs),
    octreeNode: null,
  };
}

/**
 * @param {Octree<TestItem>} tree octree under test
 * @param {TestItem} item item to insert and track
 * @returns {TestOctreeNode} node that stored the item
 */
function insertTracked(tree, item) {
  const node = tree.insert(item);
  assert.notEqual(node, null);
  item.octreeNode = node;
  return node;
}

/**
 * @param {import('../../source/shared/Octree.mjs').OctreeNode<TestItem>} node node whose children must exist
 * @returns {TestOctreeNode[]} node children
 */
function requireChildren(node) {
  assert.notEqual(node.children, null);
  return node.children;
}

describe('Octree', () => {
  test('splits into children once capacity is exceeded', () => {
    const tree = new Octree(new Vector(0, 0, 0), 16, 1, 1);
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

  test('keeps oversized bounds in the parent after a split', () => {
    const tree = new Octree(new Vector(0, 0, 0), 16, 1, 1);
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

  test('merges children back into the parent when removals drop below capacity', () => {
    const tree = new Octree(new Vector(0, 0, 0), 16, 1, 1);
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
