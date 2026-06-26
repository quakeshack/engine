import type { BaseMaterial } from '../../client/renderer/Materials.ts';
import type Vector from '../../../shared/Vector.ts';

import { content } from '../../../shared/Defs.ts';
import { BaseModel, type Face, type Plane } from './BaseModel.ts';
import { SkyRenderer } from '../../client/renderer/Sky.ts';
import { AreaPortals, type PortalDefinition } from './AreaPortals.ts';

export interface Clipnode {
  /** Index into planes array. */
  readonly planenum: number;

  /** Child node indices `[front, back]`. */
  readonly children: [number, number];
}

export interface Hull {
  /** Clipnodes for this hull. */
  readonly clipnodes: Clipnode[];

  /** Planes for collision detection. */
  readonly planes: Plane[];

  /** Index of the first clipnode, when the hull is a subrange. */
  firstclipnode?: number;

  /** Index of the last clipnode. */
  readonly lastclipnode: number;

  /** Minimum bounding box for this hull. */
  readonly clip_mins: Vector;

  /** Maximum bounding box for this hull. */
  readonly clip_maxs: Vector;

  /** Optional mask restricting traversal to the owning clipnode subtree. */
  allowedClipNodes?: Uint8Array | null;
}

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

export interface WorldTurbulentChainInfo {
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

export interface LightgridStyleSample {
  readonly stylenum: number;
  readonly rgb: [number, number, number];
}

export interface LightgridPointSample {
  readonly stylecount: number;
  readonly styles: LightgridStyleSample[];
}

export interface LightgridLeaf {
  readonly mins: [number, number, number];
  readonly size: [number, number, number];
  readonly points: LightgridPointSample[];
}

export interface LightgridNode {
  readonly mid: [number, number, number];
  readonly child: number[];
}

export interface LightgridOctree {
  readonly step: [number, number, number];
  readonly size: [number, number, number];
  readonly mins: Vector;
  readonly numstyles: number;
  readonly rootnode: number;
  readonly nodes: LightgridNode[];
  readonly leafs: LightgridLeaf[];
}

type NodeChild = Node | number | null;

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
   * Recursive helper for `addFatPoint`.
   * @param p Point in world space.
   * @param node Current BSP node.
   */
  #addToFatPoint(p: Vector, node: Node): void {
    const model = this.#model;

    if (model === null) {
      return;
    }

    while (true) {
      if (node.contents < content.CONTENT_NONE) {
        if (node.contents !== content.CONTENT_SOLID && node.cluster >= 0 && model.clusterPvsOffsets !== null) {
          const visofs = model.clusterPvsOffsets[node.cluster];
          const vis = Visibility.fromBrushModel(model, visofs);

          for (let index = 0; index < this.#data.length; index++) {
            this.#data[index] |= vis.#data[index];
          }
        }

        return;
      }

      const plane = node.plane as Plane;
      const d = p.dot(plane.normal) - plane.dist;

      if (d > 8.0) {
        node = node.children[0] as Node;
        continue;
      }

      if (d < -8.0) {
        node = node.children[1] as Node;
        continue;
      }

      this.#addToFatPoint(p, node.children[0] as Node);
      node = node.children[1] as Node;
    }
  }

  /**
   * Merge visibility from all leafs connected to the point.
   * @param p Point in world space.
   * @returns This visibility object.
   */
  addFatPoint(p: Vector): this {
    const model = this.#model;

    if (model !== null) {
      this.#addToFatPoint(p, model.nodes[0] as Node);
    }

    return this;
  }

  /**
   * Check whether any of the given leaf indices have visible clusters.
   * @param leafIndices Leaf array indices (`Node.num` values).
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
      const cluster = model.leafs[leafIndices[index]]?.cluster ?? -1;

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
   * @param leafIndex Leaf array index (`Node.num`).
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

    const cluster = model.leafs[leafIndex]?.cluster ?? -1;

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

/**
 * BSP tree node, also reused for BSP leafs.
 */
export class Node extends BrushModelComponent {
  /** Node index in the nodes array. */
  num = 0;

  contents: content = content.CONTENT_NONE;

  /** Index into planes array. */
  planenum = 0;

  /** Splitting plane. */
  plane: Plane | null = null;

  /** Parent node. */
  parent: Node | null = null;

  /** Frontside/backside, numbers during loading and `Node` refs after linking. */
  children: [NodeChild, NodeChild] = [null, null];

  /** Visibility offset for PVS. */
  visofs = 0;

  /** Minimum bounding box. */
  mins: Vector | null = null;

  /** Maximum bounding box. */
  maxs: Vector | null = null;

  /** Immutable bounds loaded from BSP data. */
  baseMins: Vector | null = null;

  /** Immutable bounds loaded from BSP data. */
  baseMaxs: Vector | null = null;

  /** First marksurface index for leafs, aka `firstleafface`. */
  firstmarksurface = 0;

  /** Number of marksurfaces for leafs, aka `numleaffaces`. */
  nummarksurfaces = 0;

  /** First face index for nodes. */
  firstface = 0;

  /** Number of faces for nodes. */
  numfaces = 0;

  /** Ambient sound levels `[water, sky, slime, lava]`. */
  ambient_level: [number, number, number, number] = [0, 0, 0, 0];

  /** Used by the renderer to determine what to draw. */
  markvisframe = 0;

  /** Used by the renderer to determine what to draw. */
  visframe = 0;

  /** Index into skychain list. */
  skychain = 0;

  /** Index into waterchain list. */
  waterchain = 0;

  /** Render command list. */
  cmds: number[][] = [];

  /** Tight turbulent draw batches for sorted world rendering. */
  turbulentChains: WorldTurbulentChainInfo[] = [];

  /** Cluster for PVS. */
  cluster = 0;

  /** Area id for area portals. */
  area = 0;

  /** First leaf brush index. */
  firstleafbrush = 0;

  /** Number of leaf brushes. */
  numleafbrushes = 0;

  *facesIter(): Generator<Face, void, void> {
    for (let index = 0; index < this.numfaces; index++) {
      yield this._brushmodel.faces[this.firstface + index] as Face;
    }
  }

  /**
   * Reset renderer-owned runtime state on this BSP node or leaf.
   * Leaf bounds may be expanded during display-list packing, so restore them
   * from the immutable BSP bounds before rebuilding world render chains.
   */
  resetRenderState(): void {
    this.markvisframe = 0;
    this.visframe = 0;
    this.skychain = 0;
    this.waterchain = 0;
    this.cmds.length = 0;
    this.turbulentChains.length = 0;

    if (this.mins !== null && this.baseMins !== null) {
      this.mins.set(this.baseMins);
    }

    if (this.maxs !== null && this.baseMaxs !== null) {
      this.maxs.set(this.baseMaxs);
    }
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
  nodes: Node[] = [];

  /** BSP leaf nodes. */
  leafs: Node[] = [];

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
  lightgrid: LightgridOctree | null = null;

  /** Visibility data for PVS. */
  visdata: Uint8Array | null = null;

  /** Clipnodes for collision detection. */
  clipnodes: Clipnode[] = [];

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
   * Find the leaf node for a given point in 3D space.
   * @param p Position.
   * @returns The leaf node containing the point.
   */
  getLeafForPoint(p: Vector): Node {
    let node = this.nodes[0] as Node;

    while (true) {
      if (node.contents < content.CONTENT_NONE) {
        return node;
      }

      const plane = node.plane as Plane;

      if (p.dot(plane.normal) - plane.dist > 0) {
        node = node.children[0] as Node;
      } else {
        node = node.children[1] as Node;
      }
    }
  }

  /**
   * @param point Point in world space.
   * @returns Visibility data for the leaf containing the point.
   */
  getPvsByPoint(point: Vector): Visibility {
    return this.getPvsByLeaf(this.getLeafForPoint(point));
  }

  /**
   * @param leaf Leaf node.
   * @returns Visibility data for the given leaf.
   */
  getPvsByLeaf(leaf: Node): Visibility {
    if (leaf === this.leafs[0] || leaf.cluster < 0 || this.clusterPvsOffsets === null) {
      return hiddenVisibility;
    }

    return Visibility.fromBrushModel(this, this.clusterPvsOffsets[leaf.cluster]);
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
    return this.getPhsByLeaf(this.getLeafForPoint(point));
  }

  /**
   * Get PHS for a given leaf.
   * Returns a `Visibility` where `isRevealed` and `areRevealed` check hearability.
   * @param leaf Leaf node.
   * @returns PHS data for the given leaf.
   */
  getPhsByLeaf(leaf: Node): Visibility {
    if (this.phsdata === null || leaf === this.leafs[0] || leaf.cluster < 0 || this.clusterPhsOffsets === null) {
      return hiddenVisibility;
    }

    return Visibility.fromBrushModel(this, this.clusterPhsOffsets[leaf.cluster], this.phsdata);
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
   * Reset renderer-owned world BSP runtime state before rebuilding display lists.
   * This clears stale per-leaf command chains and restores original BSP bounds
   * without cloning the full node graph per scoped model view.
   */
  resetWorldRenderState(): void {
    for (let index = 0; index < this.nodes.length; index++) {
      this.nodes[index].resetRenderState();
    }

    for (let index = 0; index < this.leafs.length; index++) {
      this.leafs[index].resetRenderState();
    }

    this._resetScopedFaces();
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
