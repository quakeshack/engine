import type { BaseMaterial } from '../../client/renderer/models/Materials.ts';
import type Vector from '../../../shared/Vector.ts';

import { content } from '../../../shared/Defs.ts';
import { BaseModel, type Face, type Plane } from './BaseModel.ts';
import { SkyRenderer } from '../../client/renderer/scene/Sky.ts';
import { AreaPortals, type PortalDefinition } from './AreaPortals.ts';
import type { Lightgrid } from './Lightgrid.ts';
import { ClipTree, PlaneTable, type Hull } from '../collision/Hull.ts';
import { LeafTable, NodeTable } from './BspTree.ts';
import type { WorldRenderState } from './WorldRenderState.ts';

/**
 * Optional settings carried by the worldspawn entity, which may be used by the renderer etc.
 */
export interface WorldspawnInfo extends Record<string, string | undefined> {
  /** optional skybox name, will make the renderer use a skybox if provided */
  skyname?: string;

  /** optional lightmap scale, @see https://ericw-tools.readthedocs.io/en/latest/light.html#cmdoption-light-lmscale */
  _lightmap_scale?: string;

  /** optional fteqw-style fog settings, e.g. "exp r g b" */
  fog?: string;

  /** optional semicolon seperated list of qsmat file names, e.g. "textures/my-set.qsmat.json" */
  _qs_mat?: string;

  /** opt-in for automatically enabling water fog effects (1 for on, 0 for off) */
  _qs_waterfog?: string;

  /** opt-in for the refraction of translucent liquids: its strength, 1 for the default one, 0 or absent for off */
  _qs_waterrefraction?: string;

  /**
   * Opt-in for BSP38 (Quake II) `.wal` texture loading (1 for on, anything
   * else/absent for off). Off by default: a map whose textures are fully
   * covered by qsmat has no use for `.wal` fallback data, and attempting a
   * `textures/<name>.wal` load per distinct texture anyway would fire off a
   * load request for every single one, almost all doomed to fail.
   */
  _qs_wal?: string;
}

export interface FogVolumeInfo {
  /** The inline brush model index from `*N` notation, or `0` for world water. */
  readonly modelIndex: number;

  /** Fog color as `[r, g, b]` in 0-255 range. */
  readonly color: [number, number, number];

  /** Fog density for exponential falloff. */
  readonly density: number;

  /** Maximum fog opacity, clamped to `0..1`. */
  readonly maxOpacity: number;

  /** AABB minimum corner. */
  readonly mins: [number, number, number];

  /** AABB maximum corner. */
  readonly maxs: [number, number, number];
}

export interface BrushRange {
  readonly firstBrush: number;
  readonly numBrushes: number;
}

/**
 * Surfaces of one texture in the world that the same leafs list, drawn together: the liquids and the translucent
 * surfaces, which must be drawn once however many of their leafs are visible.
 */
export interface WorldSurfaceBatch {
  /** Texture index used by the draw batch. */
  readonly texture: number;

  /** First vertex in the turbulent VBO region. */
  readonly firstVertex: number;

  /** Number of vertices in the draw batch. */
  readonly vertexCount: number;

  /** Tight world-space bounds minimum. */
  readonly mins: Vector;

  /** Tight world-space bounds maximum. */
  readonly maxs: Vector;
}

export type BSPXLumps = Record<string, { readonly fileofs: number; readonly filelen: number }>;

export type BrushTexVec = readonly [number, number, number, number];

export interface BrushTexInfo {
  /** Texture projection vectors with offsets. */
  readonly vecs: [BrushTexVec, BrushTexVec];

  /** Texture index or name, depending on the BSP format. */
  readonly texture: number | string;

  /** Material and surface flags. */
  readonly flags: number;

  /** Optional Quake 2 texture value field. */
  readonly value?: number;

  /** Optional Quake 2 linked texture-info index. */
  readonly nexttexinfo?: number;
}

const VISDATA_SIZE = 1024;

/**
 * Visibility data for PVS/PHS.
 * Stored as cluster-indexed bits. Each bit corresponds to a cluster;
 * leaf to cluster mapping is resolved via the owning BrushModel.
 */
export class Visibility {
  #data = new Uint8Array(VISDATA_SIZE);
  #model: BrushModel | null = null;

  /** When set, `isRevealed` and `areRevealed` always return true. */
  #unconditionalReveal = false;

  constructor(model: BrushModel | null = null) {
    this.#model = model;

    if (model !== null) {
      const clusterBytes = Math.max((model.numclusters + 7) >> 3, 1);
      this.#data = new Uint8Array(clusterBytes);

      if (model.visdata === null) {
        this.revealAll();
      }
    }
  }

  /**
   * Create a Visibility instance from RLE-compressed cluster PVS data.
   * @param model Map model.
   * @param visofs Byte offset into `sourceData`.
   * @param sourceData Compressed visibility data, defaulting to `model.visdata`.
   * @returns Visibility instance.
   */
  static fromBrushModel(model: BrushModel, visofs: number, sourceData: Uint8Array | null = model.visdata): Visibility {
    console.assert(model instanceof BrushModel);

    const modelVisSize = (model.numclusters + 7) >> 3;
    const visibility = new Visibility(model);

    if (sourceData !== null && visofs >= 0) {
      for (let outIndex = 0, inIndex = visofs; outIndex < modelVisSize;) {
        if (inIndex >= sourceData.length) {
          break;
        }

        if (sourceData[inIndex] !== 0) {
          visibility.#data[outIndex++] = sourceData[inIndex++];
          continue;
        }

        if (inIndex + 1 >= sourceData.length) {
          break;
        }

        for (let count = sourceData[inIndex + 1]; count > 0; count--) {
          visibility.#data[outIndex++] = 0x00;
        }

        inIndex += 2;
      }
    }

    return visibility;
  }

  /**
   * Reveal all clusters.
   * @returns This visibility object.
   */
  revealAll(): this {
    this.#data.fill(0xff);
    this.#unconditionalReveal = true;

    return this;
  }

  /**
   * Hide all clusters.
   * @returns This visibility object.
   */
  hideAll(): this {
    this.#data.fill(0x00);

    return this;
  }

  /**
   * Recursive helper shared by `addFatPoint` and `addFatPhsPoint`.
   * A point sitting inside solid content or right on a splitting plane (e.g. an explosion's
   * impact point against a wall or floor) resolves to a single meaningless leaf via a strict
   * BSP descent. Within an 8-unit fudge of a plane, both sides are descended and merged so a
   * point straddling geometry still picks up the open-air leaf's visibility.
   * @param p Point in world space.
   * @param node Current BSP node.
   * @param clusterOffsets Per-cluster byte offsets into `sourceData` (PVS or PHS).
   * @param sourceData Compressed visibility data to merge from (PVS or PHS).
   */
  #addToFatPoint(p: Vector, reference: number, clusterOffsets: number[] | null, sourceData: Uint8Array | null): void {
    const model = this.#model;

    if (model === null) {
      return;
    }

    const nodes = model.nodeTable;
    const leafs = model.leafTable;
    const planes = model.planes;

    while (true) {
      if (reference < 0) {
        const leaf = ~reference;
        const cluster = leafs.clusters[leaf];

        if (leafs.contents[leaf] !== content.CONTENT_SOLID && cluster >= 0 && clusterOffsets !== null) {
          const visofs = clusterOffsets[cluster];
          const vis = Visibility.fromBrushModel(model, visofs, sourceData);

          for (let index = 0; index < this.#data.length; index++) {
            this.#data[index] |= vis.#data[index];
          }
        }

        return;
      }

      const plane = planes[nodes.planeNums[reference]];
      const d = p.dot(plane.normal) - plane.dist;

      if (d > 8.0) {
        reference = nodes.children[reference * 2];
        continue;
      }

      if (d < -8.0) {
        reference = nodes.children[reference * 2 + 1];
        continue;
      }

      this.#addToFatPoint(p, nodes.children[reference * 2], clusterOffsets, sourceData);
      reference = nodes.children[reference * 2 + 1];
    }
  }

  /**
   * Merge PVS from all leafs connected to the point.
   * @param p Point in world space.
   * @returns This visibility object.
   */
  addFatPoint(p: Vector): this {
    const model = this.#model;

    if (model !== null) {
      this.#addToFatPoint(p, 0, model.clusterPvsOffsets, model.visdata);
    }

    return this;
  }

  /**
   * Merge PHS from all leafs connected to the point.
   * @param p Point in world space.
   * @returns This visibility object.
   */
  addFatPhsPoint(p: Vector): this {
    const model = this.#model;

    if (model !== null && model.phsdata !== null) {
      this.#addToFatPoint(p, 0, model.clusterPhsOffsets, model.phsdata);
    }

    return this;
  }

  /**
   * Merge another Visibility's revealed clusters into this one.
   * @param other Visibility instance to merge in.
   * @returns This visibility object.
   */
  mergeFrom(other: Visibility): this {
    if (other.#unconditionalReveal) {
      this.#unconditionalReveal = true;
    }

    const length = Math.min(this.#data.length, other.#data.length);
    for (let index = 0; index < length; index++) {
      this.#data[index] |= other.#data[index];
    }

    return this;
  }

  /**
   * Check whether any of the given leaf indices have visible clusters.
   * @param leafIndices Leaf indices.
   * @returns True when any of the given leafs are revealed.
   */
  areRevealed(leafIndices: number[]): boolean {
    if (this.#unconditionalReveal) {
      return leafIndices.length > 0;
    }

    const model = this.#model;

    if (model === null) {
      for (let index = 0; index < leafIndices.length; index++) {
        if ((this.#data[leafIndices[index] >> 3] & (1 << (leafIndices[index] & 7))) !== 0) {
          return true;
        }
      }

      return false;
    }

    for (let index = 0; index < leafIndices.length; index++) {
      const cluster = model.leafTable.clusters[leafIndices[index]] ?? -1;

      if (cluster < 0) {
        continue;
      }

      if ((this.#data[cluster >> 3] & (1 << (cluster & 7))) !== 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check whether a given leaf is revealed via its cluster.
   * @param leafIndex Leaf index.
   * @returns True when the given leaf is revealed.
   */
  isRevealed(leafIndex: number): boolean {
    if (this.#unconditionalReveal) {
      return true;
    }

    const model = this.#model;

    if (model === null) {
      return (this.#data[leafIndex >> 3] & (1 << (leafIndex & 7))) !== 0;
    }

    const cluster = model.leafTable.clusters[leafIndex] ?? -1;

    if (cluster < 0) {
      return false;
    }

    return (this.#data[cluster >> 3] & (1 << (cluster & 7))) !== 0;
  }
}

export const revealedVisibility = new Visibility().revealAll();
export const hiddenVisibility = new Visibility().hideAll();

export class BrushModelComponent {
  /** Owning brush model. */
  protected _brushmodel: BrushModel;

  constructor(brushmodel: BrushModel) {
    this._brushmodel = brushmodel;
  }
}

export class BrushSide extends BrushModelComponent {
  /** Plane index, facing leaf outwards. */
  planenum = 0;

  /** Texture info index. */
  texinfo = 0;
}

export class Brush extends BrushModelComponent {
  /** First brush side index. */
  firstside = 0;

  /** Number of brush sides. */
  numsides = 0;

  /** Contents of the brush. */
  contents: content = content.CONTENT_NONE;

  /** Axis-aligned bounding box minimum. */
  mins: Vector | null = null;

  /** Axis-aligned bounding box maximum. */
  maxs: Vector | null = null;

  /** BrushTrace dedup counter to avoid testing the same brush twice. */
  _brushTraceCheck = 0;

  *sidesIter(): Generator<BrushSide, void, void> {
    for (let index = 0; index < this.numsides; index++) {
      yield this._brushmodel.brushsides![this.firstside + index] as BrushSide;
    }
  }
}

/**
 * Base class for brush-based models (BSP maps).
 * All loading is handled by `BSP29Loader`.
 */
export class BrushModel extends BaseModel {
  /** BSP format version. */
  version: number | null = null;

  /** Bounding radius for culling. */
  radius = 0;

  /** All planes in the BSP tree. */
  planes: Plane[] = [];

  /** All visible faces and surfaces. */
  faces: Face[] = [];

  /** All vertex positions. */
  vertexes: Vector[] = [];

  /** Edge vertex indices `[v1, v2]`. */
  edges: number[][] = [];

  /** Surface edge list, negative indices mean reversed winding. */
  surfedges: number[] = [];

  /** BSP tree nodes. */
  nodeTable = new NodeTable(0);

  /** BSP leafs. */
  leafTable = new LeafTable(0);

  /** What the renderer keeps per node and leaf of this view of the map, `null` on a server and before the display lists exist. */
  renderState: WorldRenderState | null = null;

  /** Texture materials. */
  textures: BaseMaterial[] = [];

  /** Texture coordinate info per face. */
  texinfo: BrushTexInfo[] = [];

  /** Face indices visible from each leaf. */
  marksurfaces: number[] = [];

  /** Grayscale lightmap data. */
  lightdata: Uint8Array | null = null;

  /** RGB lightmap data. */
  lightdata_rgb: Uint8Array | null = null;

  /** Deluxemap data storing dominant light directions. */
  deluxemap: Uint8Array | null = null;

  /** Lightgrid octree data. */
  lightgrid: Lightgrid | null = null;

  /** Visibility data for PVS. */
  visdata: Uint8Array | null = null;

  /** The planes as typed arrays, which the collision hulls are cut by. */
  planeTable = new PlaneTable(0);

  /** Clipnodes for collision detection, shared by the hulls of the world and its inline models. */
  clipTree = new ClipTree(0);

  /** Collision hulls for physics. */
  hulls: Hull[] = [];

  /** Inline brush submodels. */
  submodels: BrushModel[] = [];

  /** First face index for this submodel. */
  firstface = 0;

  /** Number of faces in this submodel. */
  numfaces = 0;

  /** Entity lump as a string. */
  entities: string | null = null;

  /** Parsed worldspawn entity properties, some are supported and interpreted, others are stored as-is. */
  worldspawnInfo: WorldspawnInfo = {};

  /** Offset for BSPX extended data. */
  bspxoffset = 0;

  /** BSPX extended lumps. */
  bspxlumps: BSPXLumps | null = null;

  /** True when this is an inline submodel rather than the main world. */
  submodel = false;

  /** Rendering chains for optimized texture batching. */
  chains: number[][] = [];

  /** Offset into the vertex buffer for turbulent surfaces. */
  waterchain = 0;

  /** Offset into the vertex buffer for sky surfaces. */
  skychain = 0;

  /** True when RGB lighting is available. */
  coloredlights = false;

  /** Number of visibility clusters. */
  numclusters = 0;

  /** PVS byte offset per cluster into `visdata`. */
  clusterPvsOffsets: number[] | null = null;

  /** PHS data, cluster-indexed and RLE-compressed. */
  phsdata: Uint8Array | null = null;

  /** PHS byte offset per cluster into `phsdata`. */
  clusterPhsOffsets: number[] | null = null;

  /** Number of areas for area portals. */
  numAreas = 0;

  /** Area portal definitions. */
  portalDefs: PortalDefinition[] = [];

  /** Area portal connectivity manager. */
  areaPortals = new AreaPortals();

  /** Maps brush model names such as `*1` to auto-assigned portal numbers. */
  modelPortalMap: Record<string, number> = {};

  /** Fog volume brush entities parsed from the BSP entity lump. */
  fogVolumes: FogVolumeInfo[] = [];

  /**
   * Spatial anchors for liquid fog fallback, built at load time from liquid leafs whose mark
   * surfaces include at least one turbulent face with a known fog tint. When the viewleaf has
   * no visible turbulent chains (e.g. narrow passage), the renderer finds the nearest anchor
   * to the camera and uses its fog tint.
   *
   * A linear nearest-neighbor scan is used at runtime. This is intentional: the anchor count
   * is bounded by the number of distinct liquid surfaces in a map, typically well under 100,
   * making O(N) search negligible. If maps with hundreds of distinct liquid bodies become
   * common, swap this for a k-d tree or octree backed by the same interface.
   */
  liquidFogAnchors: { readonly center: Vector; readonly fogTint: [number, number, number] }[] = [];

  /** Leaf brushes, when present. */
  leafbrushes: number[] | null = null;

  /** Brush sides, when present. */
  brushsides: BrushSide[] | null = null;

  /** Brushes, when present. */
  brushes: Brush[] | null = null;

  /** First brush index in the shared brushes array for this model. */
  firstBrush = 0;

  /** Number of brushes belonging to this model. */
  numBrushes = 0;

  /** Per-submodel brush ranges parsed from BRUSHLIST BSPX data. */
  _brushRanges: Map<number, BrushRange> | null = null;

  /** Opaque world VAO created by the brush renderer. */
  opaqueVAO: WebGLVertexArrayObject | null = null;

  /** Turbulent world VAO created by the brush renderer. */
  turbulentVAO: WebGLVertexArrayObject | null = null;

  override type = 0;

  get isWorldModel(): boolean {
    return !this.submodel;
  }

  /**
   * Whether this model has complete brush-based collision data.
   * When true, Q2-style brush tracing can be used instead of Q1-style hull tracing.
   * Requires brushes, brushsides, leafbrushes arrays plus nodes with leaf brush references.
   * @returns True if brush data is available for Q2-style tracing.
   */
  get hasBrushData(): boolean {
    return this.brushes !== null
      && this.brushsides !== null
      && this.leafbrushes !== null
      && this.brushes.length > 0;
  }

  *facesIter(): Generator<Face, void, void> {
    for (let index = 0; index < this.numfaces; index++) {
      yield this.faces[this.firstface + index] as Face;
    }
  }

  /**
   * Find the leaf for a given point in 3D space.
   * @param p Position.
   * @returns Index of the leaf containing the point.
   */
  getLeafIndexForPoint(p: Vector): number {
    const nodes = this.nodeTable;
    const planes = this.planes;
    let reference = 0;

    while (reference >= 0) {
      const plane = planes[nodes.planeNums[reference]];

      reference = nodes.children[reference * 2 + (p.dot(plane.normal) - plane.dist > 0 ? 0 : 1)];
    }

    return ~reference;
  }

  /**
   * Whether two leafs are connected through open area portals.
   * @param leaf0 Index of the first leaf.
   * @param leaf1 Index of the second leaf.
   * @returns True when the areas of the two leafs are mutually reachable.
   */
  leafsConnected(leaf0: number, leaf1: number): boolean {
    return this.areaPortals.areasConnected(this.leafTable.areas[leaf0], this.leafTable.areas[leaf1]);
  }

  /**
   * @param point Point in world space.
   * @returns Visibility data for the leaf containing the point.
   */
  getPvsByPoint(point: Vector): Visibility {
    return this.getPvsByLeaf(this.getLeafIndexForPoint(point));
  }

  /**
   * @param leaf Leaf index.
   * @returns Visibility data for the given leaf.
   */
  getPvsByLeaf(leaf: number): Visibility {
    const cluster = this.leafTable.clusters[leaf];

    if (leaf === 0 || cluster < 0 || this.clusterPvsOffsets === null) {
      return hiddenVisibility;
    }

    return Visibility.fromBrushModel(this, this.clusterPvsOffsets[cluster]);
  }

  /**
   * Merge visibility from all leafs near the given starting point.
   * @param point Point in world space.
   * @returns Visibility data for the leaf containing the point.
   */
  getFatPvsByPoint(point: Vector): Visibility {
    const vis = new Visibility(this);

    return vis.addFatPoint(point);
  }

  /**
   * Get PHS for a point in the world.
   * @param point Point in world space.
   * @returns PHS data for the leaf containing the point.
   */
  getPhsByPoint(point: Vector): Visibility {
    return this.getPhsByLeaf(this.getLeafIndexForPoint(point));
  }

  /**
   * Get PHS for a given leaf.
   * Returns a `Visibility` where `isRevealed` and `areRevealed` check hearability.
   * @param leaf Leaf index.
   * @returns PHS data for the given leaf.
   */
  getPhsByLeaf(leaf: number): Visibility {
    const cluster = this.leafTable.clusters[leaf];

    if (this.phsdata === null || leaf === 0 || cluster < 0 || this.clusterPhsOffsets === null) {
      return hiddenVisibility;
    }

    return Visibility.fromBrushModel(this, this.clusterPhsOffsets[cluster], this.phsdata);
  }

  /**
   * Merge PHS from all leafs near the given starting point, the PHS counterpart to
   * `getFatPvsByPoint`. A single sampled point can resolve to the solid/outside leaf for
   * points sitting on or just inside geometry (e.g. an explosion's impact point against a
   * wall or floor), which would otherwise make the sound spuriously inaudible to everyone.
   * @param point Point in world space.
   * @returns Merged PHS data for leafs near the point.
   */
  getFatPhsByPoint(point: Vector): Visibility {
    const vis = new Visibility(this);

    return vis.addFatPhsPoint(point);
  }

  /**
   * Merge PHS across every leaf an entity occupies, rather than a single sampled point.
   * A single point (e.g. a bounding box center) can land in solid content or a leaf whose PHS
   * doesn't reflect the entity's actual extent, particularly for large or asymmetric movers
   * (doors, trains, platforms) whose origin can end up embedded in geometry after a move.
   * @param leafIndices Indices of the leafs the entity is linked into.
   * @returns Merged PHS data across all given leafs.
   */
  getPhsByLeafs(leafIndices: number[]): Visibility {
    const vis = new Visibility(this);

    for (const leafIndex of leafIndices) {
      if (leafIndex < 0 || leafIndex >= this.leafTable.count) {
        continue;
      }

      vis.mergeFrom(this.getPhsByLeaf(leafIndex));
    }

    return vis;
  }

  /**
   * Create a new sky renderer for this brush model, if supported.
   * @returns Desired sky renderer.
   */
  newSkyRenderer(): SkyRenderer | null {
    return null;
  }

  /**
   * Reset runtime-only face state for a scoped brush model view.
   * Dynamic light bookkeeping is rebuilt per client frame and must not be
   * inherited from an earlier scoped instance of the same cached map.
   */
  _resetScopedFaces(): void {
    for (let index = 0; index < this.faces.length; index++) {
      this.faces[index].dlightbits = 0;
      this.faces[index].dlightframe = -1;
    }
  }

  /**
   * @returns Scoped runtime view.
   */
  override createScopedView(): this {
    const scopedView = super.createScopedView() as this;

    scopedView.cmds = null;
    scopedView.chains = [];
    scopedView.waterchain = 0;
    scopedView.skychain = 0;
    scopedView.renderState = null;
    scopedView.opaqueVAO = null;
    scopedView.turbulentVAO = null;

    scopedView._resetScopedFaces();

    return scopedView;
  }

  /**
   * Release scoped GPU buffers and VAOs owned by this brush-model view.
   */
  override cleanupScopedView(): void {
    super.cleanupScopedView();

    const gl = this._getGLContext();

    if (gl === null) {
      return;
    }

    if (this.cmds !== null) {
      gl.deleteBuffer(this.cmds);
      this.cmds = null;
    }

    if (this.opaqueVAO !== null) {
      gl.deleteVertexArray(this.opaqueVAO);
      this.opaqueVAO = null;
    }

    if (this.turbulentVAO !== null) {
      gl.deleteVertexArray(this.turbulentVAO);
      this.turbulentVAO = null;
    }
  }
}
