import { BaseMaterial } from '../../client/renderer/Materials.mjs';
import { content } from '../../../shared/Defs.ts';
import { BaseModel } from './BaseModel.mjs';
import { SkyRenderer } from '../../client/renderer/Sky.mjs';
import { AreaPortals } from './AreaPortals.mjs';

/** @typedef {import('../../../shared/Vector.mjs').default} Vector */
/** @typedef {import('./BaseModel.mjs').Face} Face */
/** @typedef {import('./BaseModel.mjs').Plane} Plane */

/**
 * @typedef {object} Clipnode
 * @property {number} planenum - Index into planes array
 * @property {number[]} children - Child node indices [front, back]
 */

/**
 * @typedef {object} Hull
 * @property {Clipnode[]} clipnodes - Clipnodes for this hull
 * @property {Plane[]} planes - Planes for collision detection
 * @property {number} [firstclipnode] - Index of first clipnode (optional)
 * @property {number} lastclipnode - Index of last clipnode
 * @property {Vector} clip_mins - Minimum bounding box for this hull
 * @property {Vector} clip_maxs - Maximum bounding box for this hull
 */

/**
 * @typedef {Record<string, string>} WorldspawnInfo
 * Parsed worldspawn entity key-value pairs
 */

/**
 * @typedef {object} FogVolumeInfo
 * @property {number} modelIndex - The inline brush model index (from *N notation), 0 for world water
 * @property {number[]} color - Fog color as [r, g, b] in 0-255 range
 * @property {number} density - Fog density for exponential falloff
 * @property {number} maxOpacity - Maximum fog opacity (0-1 clamped)
 * @property {number[]} mins - AABB minimum corner [x, y, z]
 * @property {number[]} maxs - AABB maximum corner [x, y, z]
 */

/**
 * @typedef {object} WorldTurbulentChainInfo
 * @property {number} texture Texture index used by the draw batch
 * @property {number} firstVertex First vertex in the turbulent VBO region
 * @property {number} vertexCount Number of vertices in the draw batch
 * @property {Vector} mins Tight world-space bounds minimum
 * @property {Vector} maxs Tight world-space bounds maximum
 */

/**
 * @typedef {Record<string, {fileofs: number, filelen: number}>} BSPXLumps
 * BSPX extended lump data (RGBLIGHTING, LIGHTINGDIR, etc.)
 */

const VISDATA_SIZE = 1024; // fallback for singleton Visibility instances (no model)

/**
 * Visibility data for PVS/PHS.
 * Stored as cluster-indexed bits. Each bit corresponds to a cluster;
 * leaf → cluster mapping is resolved via the owning BrushModel.
 */
export class Visibility {
  #data = new Uint8Array(VISDATA_SIZE);

  #model = /** @type {BrushModel} */ (null);

  /** @type {boolean} when set, isRevealed/areRevealed always return true */
  #unconditionalReveal = false;

  constructor(model = null) {
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
   * @param {BrushModel} model map model
   * @param {number} visofs byte offset into sourceData
   * @param {Uint8Array} sourceData compressed vis data (defaults to model.visdata)
   * @returns {Visibility} visibility instance
   */
  static fromBrushModel(model, visofs, sourceData = model.visdata) {
    console.assert(model instanceof BrushModel);

    const modelVisSize = (model.numclusters + 7) >> 3;
    const visibility = new Visibility(model);

    if (sourceData !== null && visofs >= 0) {
      for (let _out = 0, _in = visofs; _out < modelVisSize;) {
        // Bounds check to prevent reading past end of sourceData
        // Note: It's normal for visibility data to end before modelVisSize is filled;
        // remaining bytes stay zero, which is correct for unvisible clusters.
        if (_in >= sourceData.length) {
          break;
        }

        if (sourceData[_in] !== 0) {
          visibility.#data[_out++] = sourceData[_in++];
          continue;
        }

        // RLE: 0 byte followed by count of zeros
        if (_in + 1 >= sourceData.length) {
          // End of RLE data; remaining output stays zero (unvisible)
          break;
        }

        for (let c = sourceData[_in + 1]; c > 0; c--) {
          visibility.#data[_out++] = 0x00;
        }

        _in += 2;
      }
    }

    return visibility;
  }

  /**
   * Will reveal all clusters.
   * @returns {Visibility} this
   */
  revealAll() {
    this.#data.fill(0xff);
    this.#unconditionalReveal = true;

    return this;
  }

  /**
   * Will hide all clusters.
   * @returns {Visibility} this
   */
  hideAll() {
    this.#data.fill(0x00);

    return this;
  }

  /**
   * Recursive helper for addFatPoint.
   * @param {Vector} p point in world
   * @param {Node} node current BSP node
   */
  #addToFatPoint(p, node) {
    while (true) {
      if (node.contents < 0) {
        if (node.contents !== content.CONTENT_SOLID && node.cluster >= 0) {
          const visofs = this.#model.clusterPvsOffsets[node.cluster];
          const vis = Visibility.fromBrushModel(this.#model, visofs);

          for (let i = 0; i < this.#data.length; i++) { // merge visibility from node to ours
            this.#data[i] |= vis.#data[i];
          }
        }
        return;
      }

      const normal = node.plane.normal;
      const d = p.dot(normal) - node.plane.dist;

      if (d > 8.0) {
        node = node.children[0];
        continue;
      }

      if (d < -8.0) {
        node = node.children[1];
        continue;
      }

      this.#addToFatPoint(p, node.children[0]);
      node = node.children[1];
    }
  }

  /**
   * Adds a point to the visibility, merging visibility from all leafs connected.
   * @param {Vector} p point in world
   * @returns {Visibility} this
   */
  addFatPoint(p) {
    this.#addToFatPoint(p, this.#model.nodes[0]);

    return this;
  }

  /**
   * Check if any of the given leaf indices have visible clusters.
   * @param {number[]} leafIndices leaf array indices (Node.num values)
   * @returns {boolean} whether any of the given leafs are revealed
   */
  areRevealed(leafIndices) {
    if (this.#unconditionalReveal) {
      return leafIndices.length > 0;
    }

    if (this.#model === null) {
      // Sentinel fallback (hiddenVisibility)
      for (let i = 0; i < leafIndices.length; i++) {
        if ((this.#data[leafIndices[i] >> 3] & (1 << (leafIndices[i] & 7))) !== 0) {
          return true;
        }
      }
      return false;
    }

    for (let i = 0; i < leafIndices.length; i++) {
      const cluster = this.#model.leafs[leafIndices[i]].cluster;

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
   * Check if a given leaf is revealed via its cluster.
   * @param {number} leafIndex leaf array index (Node.num)
   * @returns {boolean} whether the given leaf is revealed
   */
  isRevealed(leafIndex) {
    if (this.#unconditionalReveal) {
      return true;
    }

    if (this.#model === null) {
      // Sentinel fallback (hiddenVisibility)
      return (this.#data[leafIndex >> 3] & (1 << (leafIndex & 7))) !== 0;
    }

    const cluster = this.#model.leafs[leafIndex].cluster;

    if (cluster < 0) {
      return false;
    }

    return (this.#data[cluster >> 3] & (1 << (cluster & 7))) !== 0;
  }
};

/** @type {Visibility} @readonly */
export const revealedVisibility = (new Visibility()).revealAll();

/** @type {Visibility} @readonly */
export const hiddenVisibility = (new Visibility()).hideAll();

export class BrushModelComponent {
  /**
   * @param {BrushModel} brushmodel parent brush model
   */
  constructor(brushmodel) {
    /** @type {BrushModel} owning brush model @protected */
    this._brushmodel = brushmodel;
  }
};

/**
 * BSP tree node aka. BSP leaf
 */
export class Node extends BrushModelComponent {
  /** @type {number} node index in the nodes array */
  num = 0;

  /** @type {number} */
  contents = 0;
  /** @type {number} index into planes array */
  planenum = 0;
  /** @type {Plane} splitting plane */
  plane = null;
  /** @type {Node|null} parent node */
  parent = null;
  /** @type {Node[]} frontside, backside - numbers during loading, Node refs after */
  children = [null, null];
  /** @type {number} visibility offset for PVS */
  visofs = 0;
  /** @type {Vector|null} minimum bounding box */
  mins = null;
  /** @type {Vector|null} maximum bounding box */
  maxs = null;
  /** @type {Vector|null} immutable bounds loaded from BSP data */
  baseMins = null;
  /** @type {Vector|null} immutable bounds loaded from BSP data */
  baseMaxs = null;
  /** @type {number} first marksurface index (for leafs), aka firstleafface */
  firstmarksurface = 0;
  /** @type {number} number of marksurfaces (for leafs), aka numleaffaces */
  nummarksurfaces = 0;
  /** @type {number} first face index (for nodes) */
  firstface = 0;
  /** @type {number} number of faces (for nodes) */
  numfaces = 0;
  /** @type {number[]} ambient sound levels [water, sky, slime, lava] */
  ambient_level = [0, 0, 0, 0];

  // === Renderer related ===
  /** @type {number} used by the renderer to determine what to draw */
  markvisframe = 0;
  /** @type {number} used by the renderer to determine what to draw */
  visframe = 0;
  /** @type {number} index into skychain list */
  skychain = 0;
  /** @type {number} index into waterchain list */
  waterchain = 0;
  /** @type {number[]} render command list */
  cmds = [];
  /** @type {WorldTurbulentChainInfo[]} tight turbulent draw batches for sorted world rendering */
  turbulentChains = [];

  // === Quake 2 based features ===
  /** @type {number} cluster for PVS */
  cluster = 0;
  /** @type {number} area for area portals */
  area = 0;
  /** @type {number} first leaf brush index */
  firstleafbrush = 0;
  /** @type {number} number of leaf brushes */
  numleafbrushes = 0;

  *facesIter() {
    for (let i = 0; i < this.numfaces; i++) {
      yield this._brushmodel.faces[this.firstface + i];
    }
  }

  /**
   * Reset renderer-owned runtime state on this BSP node/leaf.
   * Leaf bounds may be expanded during display-list packing, so restore them
   * from the immutable BSP bounds before rebuilding world render chains.
   */
  resetRenderState() {
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
};

export class BrushSide extends BrushModelComponent {
  /** @type {number} plane index, facing leaf outwards */
  planenum = 0;
  /** @type {number} texture info index */
  texinfo = 0;
};

export class Brush extends BrushModelComponent {
  /** @type {number} first brush side index */
  firstside = 0;
  /** @type {number} number of brush sides */
  numsides = 0;
  /** @type {number} contents flags, see Def.contents */
  contents = 0;
  /** @type {Vector|null} axis-aligned bounding box minimum */
  mins = null;
  /** @type {Vector|null} axis-aligned bounding box maximum */
  maxs = null;
  /** @type {number} BrushTrace dedup counter to avoid testing the same brush twice */
  _brushTraceCheck = 0;

  *sidesIter() {
    for (let i = 0; i < this.numsides; i++) {
      yield this._brushmodel.brushsides[this.firstside + i];
    }
  }
};

/**
 * Base class for brush-based models (BSP maps)
 * All loading is handled by BSP29Loader.mjs
 */
export class BrushModel extends BaseModel {
  /** @type {number} BSP format version */
  version = null;

  /** @type {number} Bounding radius for culling */
  radius = 0;

  /** @type {Plane[]} All planes in the BSP tree */
  planes = [];

  /** @type {Face[]} All visible faces/surfaces */
  faces = [];

  /** @type {Vector[]} All vertex positions */
  vertexes = [];

  /** @type {number[][]} Edge vertex indices [v1, v2] */
  edges = [];

  /** @type {number[]} Surface edge list (index into edges, negative = reverse) */
  surfedges = [];

  /** @type {Node[]} BSP tree nodes */
  nodes = [];

  /** @type {Node[]} BSP leaf nodes */
  leafs = [];

  /** @type {BaseMaterial[]} Texture information */
  textures = [];

  /** @type {any[]} Texture coordinate info per face */
  texinfo = [];

  /** @type {number[]} Face indices visible from each leaf */
  marksurfaces = [];

  /** @type {Uint8Array} Lightmap data (grayscale) */
  lightdata = null;

  /** @type {Uint8Array} Lightmap data (RGB) */
  lightdata_rgb = null;

  /** @type {Uint8Array} Deluxemap data (normals) */
  deluxemap = null;

  /** @type {object|null} Lightgrid octree data */
  lightgrid = null;

  /** @type {Uint8Array} Visibility data for PVS */
  visdata = null;

  /** @type {Clipnode[]} Clipnodes for collision detection */
  clipnodes = [];

  /** @type {Hull[]} Collision hulls for physics (hull0, hull1, hull2) */
  hulls = [];

  /** @type {BrushModel[]} Submodels (brush entities) */
  submodels = [];

  /** @type {number} First face index for this submodel */
  firstface = 0;

  /** @type {number} Number of faces in this submodel */
  numfaces = 0;

  /** @type {string} Entity lump as string */
  entities = null;

  /** @type {WorldspawnInfo} Parsed worldspawn entity properties */
  worldspawnInfo = {};

  /** @type {number} Offset for BSPX extended data */
  bspxoffset = 0;

  /** @type {BSPXLumps} BSPX extended lumps */
  bspxlumps = null;

  /** @type {boolean} Whether this is an inline submodel (brush entity) vs the world */
  submodel = false;

  /** @type {Array<number[]>} Rendering chains (texture batches) for optimized drawing */
  chains = [];

  /** @type {number} Offset into vertex buffer for turbulent surfaces (water, slime, lava) */
  waterchain = 0;

  /** @type {number} Offset into vertex buffer for sky surfaces */
  skychain = 0;

  /** @type {boolean} Whether RGB lighting is used */
  coloredlights = false;

  /** @type {number} Number of visibility clusters */
  numclusters = 0;

  /** @type {number[]|null} PVS byte offset per cluster into visdata */
  clusterPvsOffsets = null;

  /** @type {Uint8Array|null} PHS (Potentially Hearable Set) data, cluster-indexed RLE */
  phsdata = null;

  /** @type {number[]|null} PHS byte offset per cluster into phsdata */
  clusterPhsOffsets = null;

  /** @type {number} Number of areas for area portals */
  numAreas = 0;

  /** @type {{ area0: number, area1: number, group?: number }[]} Area portal definitions */
  portalDefs = [];

  /** @type {AreaPortals} Area portal connectivity manager */
  areaPortals = new AreaPortals();

  /** @type {Record<string, number>} Maps brush model names (e.g. "*1") to auto-assigned portal numbers */
  modelPortalMap = {};

  /** @type {FogVolumeInfo[]} Fog volume brush entities parsed from the BSP entity lump */
  fogVolumes = [];

  /** @type {number[]|null} Leaf brushes, useful for PHS/PVS (optional) */
  leafbrushes = null;

  /** @type {BrushSide[]|null} Brush sides (optional) */
  brushsides = null;

  /** @type {Brush[]|null} Brushes (optional) */
  brushes = null;

  /** @type {number} First brush index in the shared brushes array for this model */
  firstBrush = 0;

  /** @type {number} Number of brushes belonging to this model */
  numBrushes = 0;

  /**
   * Whether this model has complete brush-based collision data.
   * When true, Q2-style brush tracing can be used instead of Q1-style hull tracing.
   * Requires brushes, brushsides, leafbrushes arrays plus nodes with leaf brush references.
   * @returns {boolean} true if brush data is available for Q2-style tracing
   */
  get hasBrushData() {
    return this.brushes !== null
      && this.brushsides !== null
      && this.leafbrushes !== null
      && this.brushes.length > 0;
  }

  type = 0; // Mod.type.brush;

  *facesIter() {
    for (let i = 0; i < this.numfaces; i++) {
      yield this.faces[this.firstface + i];
    }
  }

  /**
   * Find the leaf node for a given point in 3D space
   * @param {Vector} p position
   * @returns {Node} leaf node containing the point
   */
  getLeafForPoint(p) {
    let node = this.nodes[0];

    while (true) {
      if (node.contents < 0) {
        // reached a leaf
        return node;
      }

      /** @type {Vector} */
      const normal = node.plane.normal;

      if (p.dot(normal) - node.plane.dist > 0) {
        node = node.children[0];
      } else {
        node = node.children[1];
      }
    }
  }

  /**
   * @param {Vector} point point in world
   * @returns {Visibility} visibility data for the leaf containing the point
   */
  getPvsByPoint(point) {
    return this.getPvsByLeaf(this.getLeafForPoint(point));
  }

  /**
   * @param {Node} leaf leaf node
   * @returns {Visibility} visibility data for the given leaf
   */
  getPvsByLeaf(leaf) {
    if (leaf === this.leafs[0] || leaf.cluster < 0 || this.clusterPvsOffsets === null) {
      return hiddenVisibility;
    }

    return Visibility.fromBrushModel(this, this.clusterPvsOffsets[leaf.cluster]);
  }

  /**
   * This will merge visibility from all leafs from a given starting point.
   * @param {Vector} point point in world
   * @returns {Visibility} visibility data for the leaf containing the point
   */
  getFatPvsByPoint(point) {
    const vis = new Visibility(this);

    return vis.addFatPoint(point);
  }

  /**
   * Get PHS (Potentially Hearable Set) for a point in the world.
   * @param {Vector} point point in world
   * @returns {Visibility} PHS data for the leaf containing the point
   */
  getPhsByPoint(point) {
    return this.getPhsByLeaf(this.getLeafForPoint(point));
  }

  /**
   * Get PHS (Potentially Hearable Set) for a given leaf.
   * Returns a Visibility where isRevealed/areRevealed check hearability.
   * @param {Node} leaf leaf node
   * @returns {Visibility} PHS data for the given leaf
   */
  getPhsByLeaf(leaf) {
    if (this.phsdata === null || leaf === this.leafs[0] || leaf.cluster < 0 || this.clusterPhsOffsets === null) {
      return hiddenVisibility;
    }

    return Visibility.fromBrushModel(this, this.clusterPhsOffsets[leaf.cluster], this.phsdata);
  }

  /**
   * Will create a new sky renderer for this brush model, if supported.
   * @returns {SkyRenderer|null} desired sky renderer
   */
  newSkyRenderer() {
    return null;
  }

  /**
   * Reset runtime-only face state for a scoped brush model view.
   * Dynamic light bookkeeping is rebuilt per client frame and must not be
   * inherited from an earlier scoped instance of the same cached map.
   * @private
   */
  _resetScopedFaces() {
    for (let i = 0; i < this.faces.length; i++) {
      this.faces[i].dlightbits = 0;
      this.faces[i].dlightframe = -1;
    }
  }

  /**
   * Reset renderer-owned world BSP runtime state before rebuilding display lists.
   * This clears stale per-leaf command chains and restores original BSP bounds
   * without cloning the full node graph per scoped model view.
   */
  resetWorldRenderState() {
    for (let i = 0; i < this.nodes.length; i++) {
      this.nodes[i].resetRenderState();
    }

    for (let i = 0; i < this.leafs.length; i++) {
      this.leafs[i].resetRenderState();
    }

    this._resetScopedFaces();
  }

  /**
   * @returns {BrushModel} scoped runtime view
   */
  createScopedView() {
    const scopedView = /** @type {BrushModel} */ (super.createScopedView());

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
   */
  cleanupScopedView() {
    super.cleanupScopedView();

    const gl = this._getGLContext();

    if (gl === null) {
      return;
    }

    if (this.cmds !== null) {
      gl.deleteBuffer(this.cmds);
      this.cmds = null;
    }

    if (this.opaqueVAO) {
      gl.deleteVertexArray(this.opaqueVAO);
      this.opaqueVAO = null;
    }

    if (this.turbulentVAO) {
      gl.deleteVertexArray(this.turbulentVAO);
      this.turbulentVAO = null;
    }
  }
};
