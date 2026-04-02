import Vector from './Vector.ts';

/** @typedef {{origin: Vector|null, absmin: Vector|null, absmax: Vector|null, octreeNode: OctreeNode<OctreeItem>|null}} OctreeItem */

/**
 * Octree node holding a spatially indexed item.
 * @template {OctreeItem} T
 */
export class OctreeNode {
  /**
   * @param {Vector} center center point, e.g (mins + maxs) / 2
   * @param {number} halfSize half the size of the longest dimension, e.g. (Math.max of (maxs - mins)) / 2 +1
   * @param {number} capacity maximum items per node before splitting
   * @param {number} minSize minimum halfSize to allow splitting
   * @param {OctreeNode<T>|null} parent parent node
   */
  constructor(center, halfSize, capacity = 8, minSize = 4, parent = null) {
    this.center = center; // Vector
    this.halfSize = halfSize; // number
    this.capacity = capacity;
    this.minSize = minSize;
    this.parent = parent;
    this.totalCount = 0;
    /** @type {T[]} */
    this.items = [];
    /** @type {OctreeNode<T>[]|null} */
    this.children = null;
  }

  /**
   * @param {Vector} point position
   * @returns {boolean} true if point is inside this node's box
   */
  #isInBox(point) {
    const dx = Math.abs(point[0] - this.center[0]);
    const dy = Math.abs(point[1] - this.center[1]);
    const dz = Math.abs(point[2] - this.center[2]);

    return dx <= this.halfSize && dy <= this.halfSize && dz <= this.halfSize;
  }

  /**
   * @param {Vector} mins minimum bounds
   * @param {Vector} maxs maximum bounds
   * @returns {boolean} true if box is fully inside this node's box
   */
  #isBoxInBox(mins, maxs) {
    const nodeMinX = this.center[0] - this.halfSize;
    const nodeMaxX = this.center[0] + this.halfSize;
    const nodeMinY = this.center[1] - this.halfSize;
    const nodeMaxY = this.center[1] + this.halfSize;
    const nodeMinZ = this.center[2] - this.halfSize;
    const nodeMaxZ = this.center[2] + this.halfSize;

    return mins[0] >= nodeMinX && maxs[0] <= nodeMaxX &&
      mins[1] >= nodeMinY && maxs[1] <= nodeMaxY &&
      mins[2] >= nodeMinZ && maxs[2] <= nodeMaxZ;
  }

  /**
   * Subdivides this node into eight children.
   * @returns {OctreeNode<T>[]} created children
   */
  #subdivide() {
    const hs = this.halfSize / 2;
    const offs = [-hs, hs];
    /** @type {OctreeNode<T>[]} */
    const children = [];

    for (let ix = 0; ix < 2; ix++) {
      for (let iy = 0; iy < 2; iy++) {
        for (let iz = 0; iz < 2; iz++) {
          const c = new Vector(
            this.center[0] + offs[ix],
            this.center[1] + offs[iy],
            this.center[2] + offs[iz],
          );

          children.push(new OctreeNode(c, hs, this.capacity, this.minSize, this));
        }
      }
    }

    this.children = children;
    return children;
  }

  /**
   * Inserts an item into the first child that fully contains it.
   * @param {T} item item to insert
   * @param {OctreeNode<T>[]} children child nodes
   * @returns {OctreeNode<T>|null} child node that accepted the item, if any
   */
  #insertIntoChildren(item, children) {
    for (const child of children) {
      const node = child.insert(item);
      if (node !== null) {
        return node;
      }
    }

    return null;
  }

  /**
   * Inserts item.
   * @param {T} obj item
   * @returns {OctreeNode<T>|null} node where item was inserted, or null
   */
  insert(obj) {
    // if the object has bounds, check if it fits in this node
    if (obj.absmin && obj.absmax) {
      if (!this.#isBoxInBox(obj.absmin, obj.absmax)) {
        return null;
      }
    } else {
      if (!this.#isInBox(obj.origin)) {
        return null;
      }
    }

    let children = this.children;

    if (children === null) {
      // is there enough space? if so, add it here
      if (this.items.length < this.capacity || this.halfSize <= this.minSize) {
        this.items.push(obj);
        this.#updateCount(1);
        return this;
      }

      // split
      // temporarily reduce count for items we are about to move
      this.#updateCount(-this.items.length);
      children = this.#subdivide();

      // move items into children
      const old = this.items;
      this.items = [];

      // re-insert old items
      for (const item of old) {
        const node = this.#insertIntoChildren(item, children);
        if (node !== null) {
          if (item.octreeNode) {
            item.octreeNode = node;
          }
        }

        if (node === null) {
          this.items.push(item); // keep in parent if it doesn’t fit in any child
          if (item.octreeNode) {
            item.octreeNode = this;
          }
          this.#updateCount(1); // re-add count for the item kept in this node
        }
      }
    }

    // insert into child
    const node = this.#insertIntoChildren(obj, children);
    if (node !== null) {
      return node;
    }

    // if it didn’t fit in any child (e.g. straddles boundary), keep it here
    this.items.push(obj);
    this.#updateCount(1);
    return this;
  }

  /**
   * Updates totalCount up the tree.
   * @param {number} delta changed number of items
   */
  #updateCount(delta) {
    /** @type {OctreeNode<T>|null} */
    let node = this; // eslint-disable-line consistent-this
    while (node) {
      node.totalCount += delta;
      node = node.parent;
    }
  }

  /**
   * Removes item from this node.
   * @param {T} obj item
   * @returns {boolean} true if removed
   */
  remove(obj) {
    const idx = this.items.indexOf(obj);
    if (idx !== -1) {
      this.items.splice(idx, 1);
      this.#updateCount(-1);
      this.#checkMerge();
      return true;
    }
    return false;
  }

  /**
   * Checks if children can be merged.
   */
  #checkMerge() {
    /** @type {OctreeNode<T>|null} */
    let node = this; // eslint-disable-line consistent-this
    while (node) {
      if (node.children && node.totalCount <= node.capacity) {
        node.#merge();
      }
      node = node.parent;
    }
  }

  /**
   * Merges all children into this node.
   */
  #merge() {
    const items = this.#getAllItems();
    this.items = items;
    this.children = null;
    for (const item of this.items) {
      if (item.octreeNode) {
        item.octreeNode = this;
      }
    }
  }

  /**
   * Returns all items in this node and its children.
   * @returns {T[]} items
   */
  #getAllItems() {
    let items = [...this.items];
    const children = this.children;

    if (children !== null) {
      for (const child of children) {
        items = items.concat(child.#getAllItems());
      }
    }

    return items;
  }

  /**
   * Collect candidates inside AABB.
   * @param {Vector} mins minimum bounds
   * @param {Vector} maxs maximum bounds
   * @yields {T} item
   * @returns {IterableIterator<T>} items inside AABB
   */
  *queryAABB(mins, maxs) {
    // AABB-AABB intersection test
    // node bounds:
    const nodeMinX = this.center[0] - this.halfSize;
    const nodeMaxX = this.center[0] + this.halfSize;
    const nodeMinY = this.center[1] - this.halfSize;
    const nodeMaxY = this.center[1] + this.halfSize;
    const nodeMinZ = this.center[2] - this.halfSize;
    const nodeMaxZ = this.center[2] + this.halfSize;

    if (maxs[0] < nodeMinX || mins[0] > nodeMaxX ||
      maxs[1] < nodeMinY || mins[1] > nodeMaxY ||
      maxs[2] < nodeMinZ || mins[2] > nodeMaxZ) {
      return;
    }

    // check items
    if (this.items.length > 0) {
      for (const p of this.items) {
        // check if item is inside query AABB
        if (p.absmin && p.absmax) {
          // AABB-AABB overlap
          if (p.absmin[0] <= maxs[0] && p.absmax[0] >= mins[0] &&
            p.absmin[1] <= maxs[1] && p.absmax[1] >= mins[1] &&
            p.absmin[2] <= maxs[2] && p.absmax[2] >= mins[2]) {
            yield p;
          }
        } else {
          // item in AABB
          if (p.origin[0] >= mins[0] && p.origin[0] <= maxs[0] &&
            p.origin[1] >= mins[1] && p.origin[1] <= maxs[1] &&
            p.origin[2] >= mins[2] && p.origin[2] <= maxs[2]) {
            yield p;
          }
        }
      }
    }

    // traverse children
    const children = this.children;

    if (children !== null) {
      for (const child of children) {
        yield* child.queryAABB(mins, maxs);
      }
    }
  }

  /**
   * Collect candidates inside sphere centered at pos with radius r.
   * @param {Vector} point position
   * @param {number} radius radius
   * @yields {[number, T]} distance and item
   * @returns {IterableIterator<[number, T]>} items inside sphere
   */
  *querySphere(point, radius) {
    // AABB-sphere intersection test
    const dx = Math.max(0, Math.abs(point[0] - this.center[0]) - this.halfSize);
    const dy = Math.max(0, Math.abs(point[1] - this.center[1]) - this.halfSize);
    const dz = Math.max(0, Math.abs(point[2] - this.center[2]) - this.halfSize);
    const dist2 = dx * dx + dy * dy + dz * dz;

    if (dist2 > radius * radius) {
      // no intersection
      return;
    }

    // check items
    if (this.items.length > 0) {
      for (const item of this.items) {
        const d = item.origin.copy().subtract(point).len();
        if (d <= radius) {
          yield [d, item];
        }
      }
    }

    // traverse children
    const children = this.children;

    if (children !== null) {
      for (const child of children) {
        yield* child.querySphere(point, radius);
      }
    }
  }
}

/**
 * Simple Octree for spatial-indexing of anything.
 * @template {OctreeItem} T
 */
export class Octree {
  /**
   * @param {Vector} center center point, e.g (mins + maxs) / 2
   * @param {number} halfSize half the size of the longest dimension, e.g. (Math.max of (maxs - mins)) / 2 +1
   * @param {number} capacity maximum items per node before splitting, default 8
   * @param {number} minSize minimum halfSize to allow splitting, default 4
   */
  constructor(center, halfSize, capacity = 8, minSize = 4) {
    /** @type {OctreeNode<T>} */
    this.root = new OctreeNode(center, halfSize, capacity, minSize);
  }

  /**
   * Inserts item.
   * @param {T} item item to add
   * @returns {OctreeNode<T>|null} node where item was inserted
   */
  insert(item) {
    return this.root.insert(item);
  }

  /**
   * Removes item.
   * @param {T} item item to remove
   * @returns {boolean} true if removed
   */
  remove(item) {
    // if an item knows its node, use it
    if (item.octreeNode) {
      const removed = item.octreeNode.remove(item);
      if (removed) {
        item.octreeNode = null;
      }
      return removed;
    }

    // otherwise we can’t easily remove without searching, which is slow
    // for now assume item has octreeNode if it was inserted
    // TODO: fallback search removal
    return false;
  }

  /**
   * Collect candidates inside AABB.
   * @param {Vector} mins minimum bounds
   * @param {Vector} maxs maximum bounds
   * @yields {T} item
   */
  *queryAABB(mins, maxs) {
    yield* this.root.queryAABB(mins, maxs);
  }

  /**
   * Finds nearest item to point within maxDist.
   * @param {Vector} point point in space to search nearest to
   * @param {number} maxDist maximum distance to search, default unlimited
   * @returns {T|null} nearest item whose origin is within maxDist, or null
   */
  nearest(point, maxDist = Infinity) {
    let best = null;
    let bestDist = Infinity;

    for (const [d, item] of this.root.querySphere(point, maxDist)) {
      if (d < bestDist) {
        bestDist = d;
        best = item;
      }
    }

    return best;
  }
};
