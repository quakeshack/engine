import type { Trace as SharedBrushTrace } from '../../common/Pmove.ts';
import type { AliasCollisionFrame, AliasModel } from '../../common/model/AliasModel.ts';
import type { BrushModel } from '../../common/model/BSP.ts';
import type { MeshModel } from '../../common/model/MeshModel.ts';
import type { SkeletalMeshData, SkeletalModel } from '../../common/model/SkeletalModel.ts';
import { SkeletalAnimation } from '../../common/model/SkeletalAnimation.ts';
import type { ServerEdict } from '../Edict.ts';

import Vector from '../../../shared/Vector.ts';
import { Octree, type OctreeItem, type OctreeNode } from '../../../shared/Octree.ts';
import type { moveTypes } from '../../../shared/Defs.ts';

const TRIANGLE_QUERY_PADDING = 0.001;

interface TriangleSpatialIndexCache {
  readonly spatialIndex: TriangleSpatialIndex;
}

interface MeshTriangleSpatialIndexCache extends TriangleSpatialIndexCache {
  readonly indices: Uint16Array | Uint32Array;
  readonly vertices: Float32Array;
  readonly triangleCount: number;
}

interface AliasTriangleSpatialIndexCache extends TriangleSpatialIndexCache {
  readonly triangles: AliasModel['_triangles'];
  readonly frames: AliasModel['frames'];
  readonly scale: Vector | null;
  readonly scaleOrigin: Vector | null;
  readonly triangleCount: number;
  readonly vertexCount: number;
}

/**
 * What tracing against a skeletal model needs, built once per mesh (scoped views of a model share it): the mesh skinned
 * in every frame, as an MDL keeps every frame's vertices, triangle bounds that cover every frame, and the joint each
 * triangle belongs to.
 */
interface SkeletalCollisionGeometry {
  readonly meshData: SkeletalMeshData;
  readonly vertexCount: number;
  /** Skinned positions, `x, y, z` per vertex, one frame after the other. */
  readonly framePositions: Float32Array;
  /** Per triangle, the joint with the most weight on its three vertices. */
  readonly triangleJoints: Int32Array;
  readonly spatialIndex: TriangleSpatialIndex | null;
}

const meshTriangleSpatialIndexCache = new WeakMap<MeshModel, MeshTriangleSpatialIndexCache>();
const skeletalCollisionGeometryCache = new WeakMap<SkeletalMeshData, SkeletalCollisionGeometry>();
const aliasTriangleSpatialIndexCache = new WeakMap<AliasModel, AliasTriangleSpatialIndexCache>();

/**
 *
 */
function updateBounds(mins: Vector, maxs: Vector, point: Vector): void {
  mins[0] = Math.min(mins[0], point[0]);
  mins[1] = Math.min(mins[1], point[1]);
  mins[2] = Math.min(mins[2], point[2]);
  maxs[0] = Math.max(maxs[0], point[0]);
  maxs[1] = Math.max(maxs[1], point[1]);
  maxs[2] = Math.max(maxs[2], point[2]);
}

/**
 * Check whether a bounds pair is fully finite.
 * @returns True when every component of the bounds is finite.
 */
function boundsAreFinite(mins: Vector, maxs: Vector): boolean {
  return Number.isFinite(mins[0])
    && Number.isFinite(mins[1])
    && Number.isFinite(mins[2])
    && Number.isFinite(maxs[0])
    && Number.isFinite(maxs[1])
    && Number.isFinite(maxs[2]);
}

/**
 * Build a reusable octree-backed triangle bounds index.
 * @returns The spatial index, or `null` when no finite bounds can be built.
 */
function createTriangleSpatialIndex(items: TriangleBoundsItem[]): TriangleSpatialIndex | null {
  if (items.length === 0) {
    return null;
  }

  const mins = new Vector(Infinity, Infinity, Infinity);
  const maxs = new Vector(-Infinity, -Infinity, -Infinity);

  for (const item of items) {
    const itemMins = item.absmin;
    const itemMaxs = item.absmax;

    console.assert(itemMins !== null && itemMaxs !== null, 'triangle bounds items require finite bounds');

    updateBounds(mins, maxs, itemMins!);
    updateBounds(mins, maxs, itemMaxs!);
  }

  if (!boundsAreFinite(mins, maxs)) {
    return null;
  }

  const center = mins.copy().add(maxs).multiply(0.5);
  const halfSize = Math.max(
    (maxs[0] - mins[0]) * 0.5,
    (maxs[1] - mins[1]) * 0.5,
    (maxs[2] - mins[2]) * 0.5,
    1.0,
  ) + 1.0;

  const tree = new Octree<TriangleBoundsItem>(center, halfSize, 16, 8);

  for (const item of items) {
    tree.insert(item);
  }

  return new TriangleSpatialIndex(items, tree);
}

/**
 * Build the exact triangle bounds index for a static mesh model.
 * @returns The spatial index, or `null` when the mesh has no usable triangle data.
 */
function createMeshTriangleSpatialIndex(model: MeshModel): TriangleSpatialIndex | null {
  const indices = model.indices;
  const vertices = model.vertices;

  if (indices === null || vertices === null || model.numTriangles === 0) {
    return null;
  }

  const items: TriangleBoundsItem[] = [];

  for (let triangleIndex = 0; triangleIndex < model.numTriangles; triangleIndex++) {
    const baseIndex = triangleIndex * 3;
    const vertexIndex0 = indices[baseIndex];
    const vertexIndex1 = indices[baseIndex + 1];
    const vertexIndex2 = indices[baseIndex + 2];

    const vertex0 = readMeshVertex(vertices, vertexIndex0);
    const vertex1 = readMeshVertex(vertices, vertexIndex1);
    const vertex2 = readMeshVertex(vertices, vertexIndex2);

    if (vertex0 === null || vertex1 === null || vertex2 === null) {
      continue;
    }

    const mins = new Vector(Infinity, Infinity, Infinity);
    const maxs = new Vector(-Infinity, -Infinity, -Infinity);

    updateBounds(mins, maxs, vertex0);
    updateBounds(mins, maxs, vertex1);
    updateBounds(mins, maxs, vertex2);

    items.push(new TriangleBoundsItem(triangleIndex, mins, maxs));
  }

  return createTriangleSpatialIndex(items);
}

/**
 * Build conservative per-triangle bounds that cover every alias pose.
 * @returns The spatial index, or `null` when the alias model cannot provide collision triangles.
 */
function createAliasTriangleSpatialIndex(model: AliasModel): TriangleSpatialIndex | null {
  const triangleCount = model.getCollisionTriangleCount();
  const vertexCount = model._num_verts;

  if (triangleCount === 0 || vertexCount <= 0) {
    return null;
  }

  const vertexMins: Vector[] = [];
  const vertexMaxs: Vector[] = [];

  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex++) {
    vertexMins.push(new Vector(Infinity, Infinity, Infinity));
    vertexMaxs.push(new Vector(-Infinity, -Infinity, -Infinity));
  }

  for (const frame of model.frames) {
    if (frame.group) {
      for (const groupedFrame of frame.frames) {
        accumulateAliasVertexBounds(model, groupedFrame, vertexMins, vertexMaxs);
      }
      continue;
    }

    accumulateAliasVertexBounds(model, frame, vertexMins, vertexMaxs);
  }

  const items: TriangleBoundsItem[] = [];

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
    const indices = model.getCollisionTriangleVertexIndices(triangleIndex);

    if (indices === null) {
      continue;
    }

    const [index0, index1, index2] = indices;
    const mins0 = vertexMins[index0];
    const mins1 = vertexMins[index1];
    const mins2 = vertexMins[index2];
    const maxs0 = vertexMaxs[index0];
    const maxs1 = vertexMaxs[index1];
    const maxs2 = vertexMaxs[index2];

    if (mins0 === undefined || mins1 === undefined || mins2 === undefined
      || maxs0 === undefined || maxs1 === undefined || maxs2 === undefined
      || !boundsAreFinite(mins0, maxs0)
      || !boundsAreFinite(mins1, maxs1)
      || !boundsAreFinite(mins2, maxs2)) {
      continue;
    }

    const mins = new Vector(
      Math.min(mins0[0], mins1[0], mins2[0]),
      Math.min(mins0[1], mins1[1], mins2[1]),
      Math.min(mins0[2], mins1[2], mins2[2]),
    );
    const maxs = new Vector(
      Math.max(maxs0[0], maxs1[0], maxs2[0]),
      Math.max(maxs0[1], maxs1[1], maxs2[1]),
      Math.max(maxs0[2], maxs1[2], maxs2[2]),
    );

    items.push(new TriangleBoundsItem(triangleIndex, mins, maxs));
  }

  return createTriangleSpatialIndex(items);
}

/**
 *
 */
function accumulateAliasVertexBounds(
  model: AliasModel,
  frame: AliasCollisionFrame,
  vertexMins: Vector[],
  vertexMaxs: Vector[],
): void {
  for (let vertexIndex = 0; vertexIndex < vertexMins.length; vertexIndex++) {
    const vertex = model.getCollisionVertex(frame, vertexIndex);

    if (vertex === null) {
      continue;
    }

    const mins = vertexMins[vertexIndex];
    const maxs = vertexMaxs[vertexIndex];

    if (mins === undefined || maxs === undefined) {
      continue;
    }

    updateBounds(mins, maxs, vertex);
  }
}

/**
 * Read a mesh vertex from a flat position buffer.
 * @returns The vertex position, or `null` when the index is out of range.
 */
function readMeshVertex(vertices: Float32Array, vertexIndex: number): Vector | null {
  const baseIndex = vertexIndex * 3;

  if ((baseIndex + 2) >= vertices.length) {
    return null;
  }

  return new Vector(
    vertices[baseIndex],
    vertices[baseIndex + 1],
    vertices[baseIndex + 2],
  );
}

/**
 * Resolve or build the cached triangle bounds index for a mesh model.
 * @returns The cached spatial index, or `null` when the mesh has no usable triangle data.
 */
function getMeshTriangleSpatialIndex(model: MeshModel): TriangleSpatialIndex | null {
  const indices = model.indices;
  const vertices = model.vertices;

  if (indices === null || vertices === null || model.numTriangles === 0) {
    return null;
  }

  const cached = meshTriangleSpatialIndexCache.get(model);

  if (cached !== undefined
    && cached.indices === indices
    && cached.vertices === vertices
    && cached.triangleCount === model.numTriangles) {
    return cached.spatialIndex;
  }

  const spatialIndex = createMeshTriangleSpatialIndex(model);

  if (spatialIndex === null) {
    return null;
  }

  meshTriangleSpatialIndexCache.set(model, {
    indices,
    vertices,
    triangleCount: model.numTriangles,
    spatialIndex,
  });

  return spatialIndex;
}

/**
 * Resolve or build the cached conservative triangle bounds index for an alias model.
 * @returns The cached spatial index, or `null` when the alias model has no usable collision triangles.
 */
function getAliasTriangleSpatialIndex(model: AliasModel): TriangleSpatialIndex | null {
  const cached = aliasTriangleSpatialIndexCache.get(model);

  if (cached !== undefined
    && cached.triangles === model._triangles
    && cached.frames === model.frames
    && cached.scale === model._scale
    && cached.scaleOrigin === model._scale_origin
    && cached.triangleCount === model.getCollisionTriangleCount()
    && cached.vertexCount === model._num_verts) {
    return cached.spatialIndex;
  }

  const spatialIndex = createAliasTriangleSpatialIndex(model);

  if (spatialIndex === null) {
    return null;
  }

  aliasTriangleSpatialIndexCache.set(model, {
    triangles: model._triangles,
    frames: model.frames,
    scale: model._scale,
    scaleOrigin: model._scale_origin,
    triangleCount: model.getCollisionTriangleCount(),
    vertexCount: model._num_verts,
    spatialIndex,
  });

  return spatialIndex;
}

/**
 * The joint with the most weight on a triangle's three vertices; the lower index on a tie.
 * @returns The joint index, or -1 for a triangle without weights.
 */
function dominantJoint(meshData: SkeletalMeshData, triangles: Uint32Array, triangleIndex: number, weightByJoint: Map<number, number>): number {
  weightByJoint.clear();

  for (let corner = 0; corner < 3; corner++) {
    const vertex = triangles[triangleIndex * 3 + corner];

    for (let influence = 0; influence < 4; influence++) {
      const weight = meshData.blendWeights[vertex * 4 + influence];

      if (weight > 0.0) {
        const joint = meshData.blendIndexes[vertex * 4 + influence];
        weightByJoint.set(joint, (weightByJoint.get(joint) ?? 0.0) + weight);
      }
    }
  }

  let best = -1;
  let bestWeight = 0.0;

  for (const [joint, weight] of weightByJoint) {
    if (weight > bestWeight || (weight === bestWeight && joint < best)) {
      best = joint;
      bestWeight = weight;
    }
  }

  return best;
}

/**
 * Skin a skeletal model in every frame and index its triangles over all of them.
 * @returns The collision geometry, or `null` when the model kept no mesh (precached without `meshCollision`).
 */
function createSkeletalCollisionGeometry(model: SkeletalModel): SkeletalCollisionGeometry | null {
  const meshData = model.meshData;

  if (meshData === null) {
    return null;
  }

  const vertexCount = meshData.positions.length / 3;
  const frameCount = model.frameCount;
  const framePositions = new Float32Array(frameCount * vertexCount * 3);
  const jointMatrices = new Float32Array(model.jointCount * SkeletalAnimation.MATRIX_FLOATS);
  const skinningMatrices = new Float32Array(model.jointCount * SkeletalAnimation.MATRIX_FLOATS);
  const vertexMins = new Float32Array(vertexCount * 3).fill(Infinity);
  const vertexMaxs = new Float32Array(vertexCount * 3).fill(-Infinity);

  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * vertexCount * 3;
    SkeletalAnimation.computePose(model, frame, frame, 0.0, jointMatrices, skinningMatrices);
    SkeletalAnimation.skinPositionsInto(meshData, skinningMatrices, framePositions, offset);

    for (let index = 0; index < vertexCount * 3; index++) {
      const value = framePositions[offset + index];
      vertexMins[index] = Math.min(vertexMins[index], value);
      vertexMaxs[index] = Math.max(vertexMaxs[index], value);
    }
  }

  const triangles = meshData.triangles;
  const triangleCount = triangles.length / 3;
  const triangleJoints = new Int32Array(triangleCount);
  const weightByJoint = new Map<number, number>();
  const items: TriangleBoundsItem[] = [];

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
    triangleJoints[triangleIndex] = dominantJoint(meshData, triangles, triangleIndex, weightByJoint);

    const mins = new Vector(Infinity, Infinity, Infinity);
    const maxs = new Vector(-Infinity, -Infinity, -Infinity);

    for (let corner = 0; corner < 3; corner++) {
      const vertex = triangles[triangleIndex * 3 + corner];

      for (let axis = 0; axis < 3; axis++) {
        mins[axis] = Math.min(mins[axis], vertexMins[vertex * 3 + axis]);
        maxs[axis] = Math.max(maxs[axis], vertexMaxs[vertex * 3 + axis]);
      }
    }

    if (boundsAreFinite(mins, maxs)) {
      items.push(new TriangleBoundsItem(triangleIndex, mins, maxs));
    }
  }

  return { meshData, vertexCount, framePositions, triangleJoints, spatialIndex: createTriangleSpatialIndex(items) };
}

/**
 * Resolve or build the cached collision geometry of a skeletal model.
 * @returns The geometry, or `null` when the model kept no mesh.
 */
function getSkeletalCollisionGeometry(model: SkeletalModel): SkeletalCollisionGeometry | null {
  if (model.meshData === null) {
    return null;
  }

  const cached = skeletalCollisionGeometryCache.get(model.meshData);

  if (cached !== undefined) {
    return cached;
  }

  const geometry = createSkeletalCollisionGeometry(model);

  if (geometry !== null) {
    skeletalCollisionGeometryCache.set(model.meshData, geometry);
  }

  return geometry;
}

/**
 * Transform a world-space point into the entity's local model space.
 * @returns The point expressed in the entity's local basis.
 */
function transformWorldPointToLocal(
  point: Vector,
  origin: Vector,
  forward: Vector,
  right: Vector,
  up: Vector,
): Vector {
  const delta = point.copy().subtract(origin);

  return new Vector(
    delta.dot(forward),
    delta.dot(right),
    delta.dot(up),
  );
}

/**
 * Compute conservative local-space trace bounds for octree queries.
 * @returns Local-space minimum and maximum bounds that cover the trace box at both endpoints.
 */
function computeLocalTraceBounds(
  origin: Vector,
  forward: Vector,
  right: Vector,
  up: Vector,
  start: Vector,
  mins: Vector,
  maxs: Vector,
  end: Vector,
): { mins: Vector; maxs: Vector } {
  const queryMins = new Vector(Infinity, Infinity, Infinity);
  const queryMaxs = new Vector(-Infinity, -Infinity, -Infinity);

  const mergeTraceBox = (position: Vector): void => {
    for (const x of [mins[0], maxs[0]]) {
      for (const y of [mins[1], maxs[1]]) {
        for (const z of [mins[2], maxs[2]]) {
          const localPoint = transformWorldPointToLocal(
            new Vector(position[0] + x, position[1] + y, position[2] + z),
            origin,
            forward,
            right,
            up,
          );

          updateBounds(queryMins, queryMaxs, localPoint);
        }
      }
    }
  };

  mergeTraceBox(start);
  mergeTraceBox(end);

  queryMins[0] -= TRIANGLE_QUERY_PADDING;
  queryMins[1] -= TRIANGLE_QUERY_PADDING;
  queryMins[2] -= TRIANGLE_QUERY_PADDING;
  queryMaxs[0] += TRIANGLE_QUERY_PADDING;
  queryMaxs[1] += TRIANGLE_QUERY_PADDING;
  queryMaxs[2] += TRIANGLE_QUERY_PADDING;

  return { mins: queryMins, maxs: queryMaxs };
}

class TriangleBoundsItem implements OctreeItem<TriangleBoundsItem> {
  readonly triangleIndex: number;
  origin: Vector | null = null;
  absmin: Vector | null;
  absmax: Vector | null;
  octreeNode: OctreeNode<TriangleBoundsItem> | null = null;

  constructor(triangleIndex: number, mins: Vector, maxs: Vector) {
    this.triangleIndex = triangleIndex;
    this.absmin = mins;
    this.absmax = maxs;
  }
}

class TriangleSpatialIndex {
  readonly #items: TriangleBoundsItem[];
  readonly #tree: Octree<TriangleBoundsItem>;

  constructor(items: TriangleBoundsItem[], tree: Octree<TriangleBoundsItem>) {
    this.#items = items;
    this.#tree = tree;
  }

  *queryAABB(mins: Vector, maxs: Vector): IterableIterator<number> {
    for (const item of this.#tree.queryAABB(mins, maxs)) {
      yield item.triangleIndex;
    }
  }

  *queryAll(): IterableIterator<number> {
    for (const item of this.#items) {
      yield item.triangleIndex;
    }
  }
}

interface CollisionPlaneSource {
  readonly normal: Vector;
  readonly dist: number;
}

interface CollisionTraceOptions {
  readonly fraction?: number;
  readonly allsolid?: boolean;
  readonly startsolid?: boolean;
  readonly plane?: CollisionPlane;
  readonly ent?: ServerEdict | null;
  readonly inopen?: boolean;
  readonly inwater?: boolean;
}

export class CollisionState {
  readonly ent: ServerEdict;

  /**
   * @param ent Entity being traced against.
   */
  constructor(ent: ServerEdict) {
    this.ent = ent;
  }
}

interface TriangleCollisionAdapter {
  readonly triangleCount: number;

  getTriangleVertexIndices(triangleIndex: number): readonly [number, number, number] | null;

  /** The joint of a skeletal model the triangle belongs to, -1 for a model without joints. */
  getTriangleJoint(triangleIndex: number): number;

  getVertexPosition(vertexIndex: number): Vector | null;

  getCandidateTriangleIndices(queryMins: Vector, queryMaxs: Vector): IterableIterator<number>;
}

export abstract class TriangleCollisionState extends CollisionState {
  /**
   * Build the triangle adapter for the entity's current collision pose.
   */
  abstract createTriangleAdapter(serverTime: number): TriangleCollisionAdapter | null;
}

class MeshCollisionAdapter implements TriangleCollisionAdapter {
  readonly triangleCount: number;
  readonly #indices: Uint16Array | Uint32Array;
  readonly #vertices: Float32Array;
  readonly #spatialIndex: TriangleSpatialIndex | null;

  constructor(
    indices: Uint16Array | Uint32Array,
    vertices: Float32Array,
    triangleCount: number,
    spatialIndex: TriangleSpatialIndex | null,
  ) {
    this.#indices = indices;
    this.#vertices = vertices;
    this.triangleCount = triangleCount;
    this.#spatialIndex = spatialIndex;
  }

  getTriangleVertexIndices(triangleIndex: number): readonly [number, number, number] | null {
    if (triangleIndex < 0 || triangleIndex >= this.triangleCount) {
      return null;
    }

    const baseIndex = triangleIndex * 3;
    return [
      this.#indices[baseIndex],
      this.#indices[baseIndex + 1],
      this.#indices[baseIndex + 2],
    ];
  }

  getVertexPosition(vertexIndex: number): Vector | null {
    return readMeshVertex(this.#vertices, vertexIndex);
  }

  getTriangleJoint(_triangleIndex: number): number {
    return -1;
  }

  getCandidateTriangleIndices(queryMins: Vector, queryMaxs: Vector): IterableIterator<number> {
    if (this.#spatialIndex === null) {
      return this.#queryAllTriangles();
    }

    return this.#spatialIndex.queryAABB(queryMins, queryMaxs);
  }

  *#queryAllTriangles(): IterableIterator<number> {
    for (let triangleIndex = 0; triangleIndex < this.triangleCount; triangleIndex++) {
      yield triangleIndex;
    }
  }
}

class AliasCollisionAdapter implements TriangleCollisionAdapter {
  readonly triangleCount: number;
  readonly #model: AliasModel;
  readonly #frame: ReturnType<AliasModel['resolveCollisionFrame']>;
  readonly #spatialIndex: TriangleSpatialIndex | null;

  constructor(model: AliasModel, frameIndex: number, serverTime: number, spatialIndex: TriangleSpatialIndex | null) {
    this.#model = model;
    this.#frame = model.resolveCollisionFrame(frameIndex, serverTime);
    this.#spatialIndex = spatialIndex;
    this.triangleCount = this.#frame === null ? 0 : model.getCollisionTriangleCount();
  }

  getTriangleVertexIndices(triangleIndex: number): readonly [number, number, number] | null {
    if (this.#frame === null) {
      return null;
    }

    return this.#model.getCollisionTriangleVertexIndices(triangleIndex);
  }

  getVertexPosition(vertexIndex: number): Vector | null {
    if (this.#frame === null) {
      return null;
    }

    return this.#model.getCollisionVertex(this.#frame, vertexIndex);
  }

  getTriangleJoint(_triangleIndex: number): number {
    return -1;
  }

  getCandidateTriangleIndices(queryMins: Vector, queryMaxs: Vector): IterableIterator<number> {
    if (this.#spatialIndex === null) {
      return this.#queryAllTriangles();
    }

    return this.#spatialIndex.queryAABB(queryMins, queryMaxs);
  }

  *#queryAllTriangles(): IterableIterator<number> {
    for (let triangleIndex = 0; triangleIndex < this.triangleCount; triangleIndex++) {
      yield triangleIndex;
    }
  }
}

export class MeshCollisionState extends TriangleCollisionState {
  readonly model: MeshModel;

  /**
   * @param ent Entity being traced against.
   * @param model Collision model for the mesh entity.
   */
  constructor(ent: ServerEdict, model: MeshModel) {
    super(ent);
    this.model = model;
  }

  override createTriangleAdapter(_serverTime: number): TriangleCollisionAdapter | null {
    if (this.model.indices === null || this.model.vertices === null || this.model.numTriangles === 0) {
      return null;
    }

    return new MeshCollisionAdapter(
      this.model.indices,
      this.model.vertices,
      this.model.numTriangles,
      getMeshTriangleSpatialIndex(this.model),
    );
  }
}

export class AliasCollisionState extends TriangleCollisionState {
  readonly model: AliasModel;

  /**
   * @param ent Entity being traced against.
   * @param model Collision model for the alias entity.
   */
  constructor(ent: ServerEdict, model: AliasModel) {
    super(ent);
    this.model = model;
  }

  override createTriangleAdapter(serverTime: number): TriangleCollisionAdapter | null {
    const entity = this.ent.entity;

    if (entity === null) {
      return null;
    }

    return new AliasCollisionAdapter(
      this.model,
      entity.frame,
      serverTime,
      getAliasTriangleSpatialIndex(this.model),
    );
  }
}

class SkeletalCollisionAdapter implements TriangleCollisionAdapter {
  readonly triangleCount: number;
  readonly #geometry: SkeletalCollisionGeometry;
  readonly #frameOffset: number;

  constructor(geometry: SkeletalCollisionGeometry, frame: number) {
    this.#geometry = geometry;
    this.#frameOffset = frame * geometry.vertexCount * 3;
    this.triangleCount = geometry.meshData.triangles.length / 3;
  }

  getTriangleVertexIndices(triangleIndex: number): readonly [number, number, number] | null {
    if (triangleIndex < 0 || triangleIndex >= this.triangleCount) {
      return null;
    }

    const triangles = this.#geometry.meshData.triangles;
    return [triangles[triangleIndex * 3], triangles[triangleIndex * 3 + 1], triangles[triangleIndex * 3 + 2]];
  }

  getVertexPosition(vertexIndex: number): Vector | null {
    if (vertexIndex < 0 || vertexIndex >= this.#geometry.vertexCount) {
      return null;
    }

    const positions = this.#geometry.framePositions;
    const offset = this.#frameOffset + vertexIndex * 3;
    return new Vector(positions[offset], positions[offset + 1], positions[offset + 2]);
  }

  getTriangleJoint(triangleIndex: number): number {
    return this.#geometry.triangleJoints[triangleIndex] ?? -1;
  }

  getCandidateTriangleIndices(queryMins: Vector, queryMaxs: Vector): IterableIterator<number> {
    if (this.#geometry.spatialIndex === null) {
      return this.#queryAllTriangles();
    }

    return this.#geometry.spatialIndex.queryAABB(queryMins, queryMaxs);
  }

  *#queryAllTriangles(): IterableIterator<number> {
    for (let triangleIndex = 0; triangleIndex < this.triangleCount; triangleIndex++) {
      yield triangleIndex;
    }
  }
}

/**
 * A skeletal model traced as its posed triangles (`SOLID_MESH`), in the pose of the entity's `frame`. A trace that hits
 * it reports the joint of the triangle it hit (`CollisionTrace.joint`).
 *
 * The server poses by `frame` only: a sequence the entity plays (`sequence`, `animtime`) and the joint rotations a client
 * game adds are not seen here, as for tags on the server.
 */
export class SkeletalCollisionState extends TriangleCollisionState {
  readonly model: SkeletalModel;

  /**
   * @param ent Entity being traced against.
   * @param model Its skeletal model, loaded with its mesh.
   */
  constructor(ent: ServerEdict, model: SkeletalModel) {
    super(ent);
    this.model = model;
  }

  override createTriangleAdapter(_serverTime: number): TriangleCollisionAdapter | null {
    const entity = this.ent.entity;
    const geometry = getSkeletalCollisionGeometry(this.model);

    if (entity === null || geometry === null) {
      return null;
    }

    return new SkeletalCollisionAdapter(geometry, SkeletalCollisionState.frameOf(entity.frame, this.model.frameCount));
  }

  /**
   * The frame a pose is taken from: clamped to the model, as `SkeletalAnimation.computePose` does (a frame number comes from game code).
   * @returns A frame index in `0 .. frameCount - 1`.
   */
  static frameOf(frame: number, frameCount: number): number {
    if (!Number.isFinite(frame)) {
      return 0;
    }

    return Math.min(Math.max(Math.trunc(frame), 0), frameCount - 1);
  }
}

export class BrushCollisionState extends CollisionState {
  readonly model: BrushModel;
  readonly origin: Vector;
  readonly angles: Vector;

  /**
   * @param ent Entity being traced against.
   * @param model Brush collision model.
   * @param origin Brush-model origin.
   * @param angles Brush-model angles.
   */
  constructor(ent: ServerEdict, model: BrushModel, origin: Vector, angles: Vector) {
    super(ent);
    this.model = model;
    this.origin = origin;
    this.angles = angles;
  }
}

export class HullCollisionState extends CollisionState {
}

export class MoveClip {
  trace: CollisionTrace;
  start: Vector;
  end: Vector;
  mins: Vector;
  mins2: Vector;
  maxs: Vector;
  maxs2: Vector;
  type: moveTypes;
  passedict: ServerEdict | null;
  boxmins: Vector;
  boxmaxs: Vector;

  /**
   * @param trace Current best trace result.
   * @param start World-space trace start.
   * @param end World-space trace end.
   * @param mins Default tracing mins.
   * @param mins2 Alternate mins used for missile-vs-monster checks.
   * @param maxs Default tracing maxs.
   * @param maxs2 Alternate maxs used for missile-vs-monster checks.
   * @param type Move type constant from Defs.moveTypes.
   * @param passedict Entity to skip during tracing.
   */
  constructor(
    trace: CollisionTrace,
    start: Vector,
    end: Vector,
    mins: Vector,
    mins2: Vector,
    maxs: Vector,
    maxs2: Vector,
    type: number,
    passedict: ServerEdict | null,
  ) {
    this.trace = trace;
    this.start = start;
    this.end = end;
    this.mins = mins;
    this.mins2 = mins2;
    this.maxs = maxs;
    this.maxs2 = maxs2;
    this.type = type;
    this.passedict = passedict;
    this.boxmins = new Vector();
    this.boxmaxs = new Vector();
  }
}

export class CollisionPlane {
  normal: Vector;
  dist: number;

  /**
   * @param normal Collision normal.
   * @param dist Plane distance from origin.
   */
  constructor(normal: Vector = new Vector(), dist = 0.0) {
    this.normal = normal;
    this.dist = dist;
  }

  /**
   * @param plane Source plane.
   * @returns Copied collision plane.
   */
  static fromPlane(plane: CollisionPlaneSource): CollisionPlane {
    return new CollisionPlane(plane.normal.copy(), plane.dist);
  }
}

export class CollisionTrace {
  fraction: number;
  allsolid: boolean;
  startsolid: boolean;
  endpos: Vector;
  plane: CollisionPlane;
  ent: ServerEdict | null;
  inopen: boolean;
  inwater: boolean;
  /** The joint of a skeletal model whose triangle the trace hit (`SOLID_MESH`), -1 for anything else. */
  joint = -1;

  /**
   * @param endpos Final trace end position.
   * @param options Trace initialization options.
   */
  constructor(endpos: Vector, options: CollisionTraceOptions = {}) {
    this.fraction = options.fraction ?? 1.0;
    this.allsolid = options.allsolid ?? false;
    this.startsolid = options.startsolid ?? false;
    this.endpos = endpos;
    this.plane = options.plane ?? new CollisionPlane();
    this.ent = options.ent ?? null;
    this.inopen = options.inopen ?? false;
    this.inwater = options.inwater ?? false;
  }

  /**
   * @param end End position.
   * @returns Empty trace.
   */
  static empty(end: Vector): CollisionTrace {
    return new CollisionTrace(end.copy());
  }

  /**
   * @param end End position.
   * @returns Hull-initialized trace.
   */
  static hullInitial(end: Vector): CollisionTrace {
    return new CollisionTrace(end.copy(), { allsolid: true });
  }

  /**
   * @param brushTrace Shared brush trace result.
   * @param ent Entity that owns the brush model.
   * @returns Server collision trace.
   */
  static fromSharedTrace(brushTrace: SharedBrushTrace, ent: ServerEdict): CollisionTrace {
    const trace = new CollisionTrace(brushTrace.endpos.copy(), {
      fraction: brushTrace.fraction,
      allsolid: brushTrace.allsolid,
      startsolid: brushTrace.startsolid,
      plane: CollisionPlane.fromPlane(brushTrace.plane),
      inopen: brushTrace.inopen,
      inwater: brushTrace.inwater,
    });

    if (trace.allsolid) {
      trace.startsolid = true;
    }

    if (trace.fraction < 1.0 || trace.startsolid) {
      trace.ent = ent;
    }

    return trace;
  }
}

export class TriangleTraceContext {
  readonly ent: ServerEdict;
  readonly adapter: TriangleCollisionAdapter;
  readonly start: Vector;
  readonly end: Vector;
  readonly origin: Vector;
  readonly moveDir: Vector;
  readonly startCenter: Vector;
  readonly boxExtents: Vector;
  readonly forward: Vector;
  readonly right: Vector;
  readonly up: Vector;
  readonly localQueryMins: Vector;
  readonly localQueryMaxs: Vector;

  /**
   * @param ent Entity being traced against.
   * @param adapter Triangle collision adapter.
   * @param start Start position.
   * @param mins Minimum extents of the moving box.
   * @param maxs Maximum extents of the moving box.
   * @param end End position.
   */
  constructor(ent: ServerEdict, adapter: TriangleCollisionAdapter, start: Vector, mins: Vector, maxs: Vector, end: Vector) {
    this.ent = ent;
    this.adapter = adapter;
    this.start = start;
    this.end = end;
    this.origin = ent.entity!.origin;

    const mat = ent.entity!.angles.toRotationMatrix();
    this.forward = new Vector(mat[0], mat[1], mat[2]);
    this.right = new Vector(mat[3], mat[4], mat[5]);
    this.up = new Vector(mat[6], mat[7], mat[8]);
    this.moveDir = end.copy().subtract(start);
    this.boxExtents = maxs.copy().subtract(mins).multiply(0.5);
    this.startCenter = start.copy().add(mins.copy().add(maxs).multiply(0.5));

    const localBounds = computeLocalTraceBounds(
      this.origin,
      this.forward,
      this.right,
      this.up,
      start,
      mins,
      maxs,
      end,
    );
    this.localQueryMins = localBounds.mins;
    this.localQueryMaxs = localBounds.maxs;
  }

  /**
   * Transform a model-space vertex into world space.
   * @param x X component in model space.
   * @param y Y component in model space.
   * @param z Z component in model space.
   * @returns Transformed world-space vertex.
   */
  transformVertex(x: number, y: number, z: number): Vector {
    return this.origin.copy()
      .add(this.forward.copy().multiply(x))
      .add(this.right.copy().multiply(y))
      .add(this.up.copy().multiply(z));
  }

  /**
   * Project a point onto a plane.
   * @param point Point to project.
   * @param normal Plane normal.
   * @param planeDist Plane distance from origin.
   * @returns Projected point on the plane.
   */
  projectPointOntoPlane(point: Vector, normal: Vector, planeDist: number): Vector {
    const height = normal.dot(point) - planeDist;
    return new Vector(
      point[0] - normal[0] * height,
      point[1] - normal[1] * height,
      point[2] - normal[2] * height,
    );
  }

  /**
   * Compute the box support radius along a plane normal.
   * @param normal Plane normal.
   * @returns Support radius along the normal.
   */
  getBoxSupportRadius(normal: Vector): number {
    return this.boxExtents[0] * Math.abs(normal[0])
      + this.boxExtents[1] * Math.abs(normal[1])
      + this.boxExtents[2] * Math.abs(normal[2]);
  }

  /**
   * Compute the box-center position at a trace fraction.
   * @param fraction Trace fraction.
   * @returns Center position at the fraction.
   */
  getCenterAtFraction(fraction: number): Vector {
    return new Vector(
      this.startCenter[0] + this.moveDir[0] * fraction,
      this.startCenter[1] + this.moveDir[1] * fraction,
      this.startCenter[2] + this.moveDir[2] * fraction,
    );
  }

  /**
   * Compute the trace endpoint at a trace fraction.
   * @param fraction Trace fraction.
   * @returns End position at the fraction.
   */
  getTraceEndAtFraction(fraction: number): Vector {
    return new Vector(
      this.start[0] + this.moveDir[0] * fraction,
      this.start[1] + this.moveDir[1] * fraction,
      this.start[2] + this.moveDir[2] * fraction,
    );
  }

  /**
   * Return the triangle indices whose conservative local-space bounds overlap the trace.
   * @returns Candidate triangle indices for the current trace bounds.
   */
  getCandidateTriangleIndices(): IterableIterator<number> {
    return this.adapter.getCandidateTriangleIndices(this.localQueryMins, this.localQueryMaxs);
  }
}

export class CollisionTriangle {
  readonly triangleIndex: number;
  readonly v0: Vector;
  readonly v1: Vector;
  readonly v2: Vector;
  readonly normal: Vector;
  readonly planeDist: number;

  /**
   * @param v0 First world-space vertex.
   * @param v1 Second world-space vertex.
   * @param v2 Third world-space vertex.
   * @param normal Unit face normal.
   * @param planeDist Plane distance from origin.
   * @param triangleIndex The triangle's index in its model.
   */
  constructor(v0: Vector, v1: Vector, v2: Vector, normal: Vector, planeDist: number, triangleIndex: number) {
    this.triangleIndex = triangleIndex;
    this.v0 = v0;
    this.v1 = v1;
    this.v2 = v2;
    this.normal = normal;
    this.planeDist = planeDist;
  }

  /**
   * Build a world-space triangle from triangle-backed collision data.
   * @param triangleTrace Triangle tracing context.
   * @param triangleIndex Triangle index within the adapter.
   * @returns Transformed triangle, or null for degenerate faces.
   */
  static fromTraceContext(triangleTrace: TriangleTraceContext, triangleIndex: number): CollisionTriangle | null {
    const indices = triangleTrace.adapter.getTriangleVertexIndices(triangleIndex);

    if (indices === null) {
      return null;
    }

    const [index0, index1, index2] = indices;
    const vertex0 = triangleTrace.adapter.getVertexPosition(index0);
    const vertex1 = triangleTrace.adapter.getVertexPosition(index1);
    const vertex2 = triangleTrace.adapter.getVertexPosition(index2);

    if (vertex0 === null || vertex1 === null || vertex2 === null) {
      return null;
    }

    const v0 = triangleTrace.transformVertex(vertex0[0], vertex0[1], vertex0[2]);
    const v1 = triangleTrace.transformVertex(vertex1[0], vertex1[1], vertex1[2]);
    const v2 = triangleTrace.transformVertex(vertex2[0], vertex2[1], vertex2[2]);

    const normal = v1.copy().subtract(v0).cross(v2.copy().subtract(v0));
    const lenSq = normal.dot(normal);
    if (lenSq < 1e-12) {
      return null;
    }

    normal.multiply(1.0 / Math.sqrt(lenSq));
    return new CollisionTriangle(v0, v1, v2, normal, normal.dot(v0), triangleIndex);
  }

  /**
   * Compute the approach speed of a sweep against this triangle face.
   * @param moveDir Sweep direction in world space.
   * @returns Positive when moving toward the front face.
   */
  getApproach(moveDir: Vector): number {
    return -(this.normal[0] * moveDir[0] + this.normal[1] * moveDir[1] + this.normal[2] * moveDir[2]);
  }
}
