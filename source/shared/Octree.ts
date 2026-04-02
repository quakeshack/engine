import Vector from './Vector.ts';

/**
 * Octree node holding a spatially indexed item.
 */
export interface OctreeItem<T extends OctreeItem<T>> {
  origin: Vector | null;
  absmin: Vector | null;
  absmax: Vector | null;
  octreeNode: OctreeNode<T> | null;
}

/**
 * Octree node holding a spatially indexed item.
 * @template T
 */
export class OctreeNode<T extends OctreeItem<T>> {
  center: Vector;
  halfSize: number;
  capacity: number;
  minSize: number;
  parent: OctreeNode<T> | null;
  totalCount: number;
  items: T[];
  children: OctreeNode<T>[] | null;

  /**
   * @param center center point, e.g (mins + maxs) / 2
   * @param halfSize half the size of the longest dimension, e.g. (Math.max of (maxs - mins)) / 2 +1
   * @param capacity maximum items per node before splitting
   * @param minSize minimum halfSize to allow splitting
   * @param parent parent node
   */
  constructor(center: Vector, halfSize: number, capacity = 8, minSize = 4, parent: OctreeNode<T> | null = null) {
    this.center = center;
    this.halfSize = halfSize;
    this.capacity = capacity;
    this.minSize = minSize;
    this.parent = parent;
    this.totalCount = 0;
    this.items = [];
    this.children = null;
  }

  /**
   * @param point position
   * @returns true if point is inside this node's box
   */
  #isInBox(point: Vector): boolean {
    const dx = Math.abs(point[0] - this.center[0]);
    const dy = Math.abs(point[1] - this.center[1]);
    const dz = Math.abs(point[2] - this.center[2]);

    return dx <= this.halfSize && dy <= this.halfSize && dz <= this.halfSize;
  }

  /**
   * @param mins minimum bounds
   * @param maxs maximum bounds
   * @returns true if box is fully inside this node's box
   */
  #isBoxInBox(mins: Vector, maxs: Vector): boolean {
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
   * @returns created children
   */
  #subdivide(): OctreeNode<T>[] {
    const hs = this.halfSize / 2;
    const offs = [-hs, hs];
    const children: OctreeNode<T>[] = [];

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
   * @param item item to insert
   * @param children child nodes
   * @returns child node that accepted the item, if any
   */
  #insertIntoChildren(item: T, children: OctreeNode<T>[]): OctreeNode<T> | null {
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
   * @param obj item
   * @returns node where item was inserted, or null
   */
  insert(obj: T): OctreeNode<T> | null {
    if (obj.absmin !== null && obj.absmax !== null) {
      if (!this.#isBoxInBox(obj.absmin, obj.absmax)) {
        return null;
      }
    } else {
      if (obj.origin === null || !this.#isInBox(obj.origin)) {
        return null;
      }
    }

    let children = this.children;

    if (children === null) {
      if (this.items.length < this.capacity || this.halfSize <= this.minSize) {
        this.items.push(obj);
        this.#updateCount(1);
        return this;
      }

      this.#updateCount(-this.items.length);
      children = this.#subdivide();

      const old = this.items;
      this.items = [];

      for (const item of old) {
        const node = this.#insertIntoChildren(item, children);
        if (node !== null) {
          item.octreeNode = node;
        }

        if (node === null) {
          this.items.push(item);
          item.octreeNode = this;
          this.#updateCount(1);
        }
      }
    }

    const node = this.#insertIntoChildren(obj, children);
    if (node !== null) {
      return node;
    }

    this.items.push(obj);
    this.#updateCount(1);
    return this;
  }

  /**
   * Updates totalCount up the tree.
   * @param delta changed number of items
   */
  #updateCount(delta: number): void {
    let node: OctreeNode<T> | null = this; // eslint-disable-line consistent-this
    while (node !== null) {
      node.totalCount += delta;
      node = node.parent;
    }
  }

  /**
   * Removes item from this node.
   * @param obj item
   * @returns true if removed
   */
  remove(obj: T): boolean {
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
  #checkMerge(): void {
    let node: OctreeNode<T> | null = this; // eslint-disable-line consistent-this
    while (node !== null) {
      if (node.children !== null && node.totalCount <= node.capacity) {
        node.#merge();
      }
      node = node.parent;
    }
  }

  /**
   * Merges all children into this node.
   */
  #merge(): void {
    const items = this.#getAllItems();
    this.items = items;
    this.children = null;
    for (const item of this.items) {
      item.octreeNode = this;
    }
  }

  /**
   * Returns all items in this node and its children.
   * @returns items
   */
  #getAllItems(): T[] {
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
   * @param mins minimum bounds
   * @param maxs maximum bounds
   * @yields item
   * @returns items inside AABB
   */
  *queryAABB(mins: Vector, maxs: Vector): IterableIterator<T> {
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

    if (this.items.length > 0) {
      for (const p of this.items) {
        if (p.absmin !== null && p.absmax !== null) {
          if (p.absmin[0] <= maxs[0] && p.absmax[0] >= mins[0] &&
            p.absmin[1] <= maxs[1] && p.absmax[1] >= mins[1] &&
            p.absmin[2] <= maxs[2] && p.absmax[2] >= mins[2]) {
            yield p;
          }
        } else if (p.origin !== null) {
          if (p.origin[0] >= mins[0] && p.origin[0] <= maxs[0] &&
            p.origin[1] >= mins[1] && p.origin[1] <= maxs[1] &&
            p.origin[2] >= mins[2] && p.origin[2] <= maxs[2]) {
            yield p;
          }
        }
      }
    }

    const children = this.children;

    if (children !== null) {
      for (const child of children) {
        yield* child.queryAABB(mins, maxs);
      }
    }
  }

  /**
   * Collect candidates inside sphere centered at pos with radius r.
   * @param point position
   * @param radius radius
   * @yields distance and item
   * @returns items inside sphere
   */
  *querySphere(point: Vector, radius: number): IterableIterator<[number, T]> {
    const dx = Math.max(0, Math.abs(point[0] - this.center[0]) - this.halfSize);
    const dy = Math.max(0, Math.abs(point[1] - this.center[1]) - this.halfSize);
    const dz = Math.max(0, Math.abs(point[2] - this.center[2]) - this.halfSize);
    const dist2 = dx * dx + dy * dy + dz * dz;

    if (dist2 > radius * radius) {
      return;
    }

    if (this.items.length > 0) {
      for (const item of this.items) {
        if (item.origin === null) {
          continue;
        }

        const d = item.origin.copy().subtract(point).len();
        if (d <= radius) {
          yield [d, item];
        }
      }
    }

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
 * @template T
 */
export class Octree<T extends OctreeItem<T>> {
  root: OctreeNode<T>;

  /**
   * @param center center point, e.g (mins + maxs) / 2
   * @param halfSize half the size of the longest dimension, e.g. (Math.max of (maxs - mins)) / 2 +1
   * @param capacity maximum items per node before splitting, default 8
   * @param minSize minimum halfSize to allow splitting, default 4
   */
  constructor(center: Vector, halfSize: number, capacity = 8, minSize = 4) {
    this.root = new OctreeNode(center, halfSize, capacity, minSize);
  }

  /**
   * Inserts item.
   * @param item item to add
   * @returns node where item was inserted
   */
  insert(item: T): OctreeNode<T> | null {
    return this.root.insert(item);
  }

  /**
   * Removes item.
   * @param item item to remove
   * @returns true if removed
   */
  remove(item: T): boolean {
    if (item.octreeNode !== null) {
      const removed = item.octreeNode.remove(item);
      if (removed) {
        item.octreeNode = null;
      }
      return removed;
    }

    return false;
  }

  /**
   * Collect candidates inside AABB.
   * @param mins minimum bounds
   * @param maxs maximum bounds
   * @yields item
   */
  *queryAABB(mins: Vector, maxs: Vector): IterableIterator<T> {
    yield* this.root.queryAABB(mins, maxs);
  }

  /**
   * Finds nearest item to point within maxDist.
   * @param point point in space to search nearest to
   * @param maxDist maximum distance to search, default unlimited
   * @returns nearest item whose origin is within maxDist, or null
   */
  nearest(point: Vector, maxDist = Infinity): T | null {
    let best: T | null = null;
    let bestDist = Infinity;

    for (const [d, item] of this.root.querySphere(point, maxDist)) {
      if (d < bestDist) {
        bestDist = d;
        best = item;
      }
    }

    return best;
  }
}
