import Vector from '../../../../shared/Vector.ts';
import { CorruptedResourceError } from '../../Errors.ts';
import { Face } from '../BaseModel.ts';
import type { BrushModel } from '../BSP.ts';
import { LeafTable, NodeTable } from '../BspTree.ts';
import { ClipTree, Hull } from '../../collision/Hull.ts';
import { MaterialFlags } from '../../../client/renderer/models/Materials.ts';
import { BSP29Loader } from './BSP29Loader.ts';

/**
 * Loader for BSP2 format (.bsp).
 *
 * BSP2 is an extended version of BSP29 that uses 32-bit indices instead of
 * 16-bit indices for larger maps.
 */
export class BSP2Loader extends BSP29Loader {
  /** BSP2 lump indices used by the overridden readers below. */
  static readonly #lump = Object.freeze({
    faces: 7,
    nodes: 5,
    clipnodes: 9,
    leafs: 10,
    marksurfaces: 11,
    edges: 12,
  });

  override getMagicNumbers(): number[] {
    return [844124994];
  }

  override getName(): string {
    return 'BSP2';
  }

  /**
   * Load faces from the BSP2 faces lump.
   */
  protected override _loadFaces(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP2Loader.#lump;
    let fileofs = view.getUint32((lump.faces << 3) + 4, true);
    const filelen = view.getUint32((lump.faces << 3) + 8, true);

    if ((filelen % 28) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP2Loader: faces lump size is not a multiple of 28');
    }

    const lmshift = loadmodel.worldspawnInfo._lightmap_scale ? Math.log2(parseInt(loadmodel.worldspawnInfo._lightmap_scale, 10)) : 4;
    const count = filelen / 28;
    loadmodel.firstface = 0;
    loadmodel.numfaces = count;
    loadmodel.faces.length = count;

    for (let i = 0; i < count; i++) {
      const styles = new Uint8Array(buf, fileofs + 20, 4);
      const face = Object.assign(new Face(), {
        plane: loadmodel.planes[view.getUint32(fileofs, true)],
        planeBack: view.getInt32(fileofs + 4, true) !== 0,
        firstedge: view.getUint32(fileofs + 8, true),
        numedges: view.getUint32(fileofs + 12, true),
        texinfo: view.getUint32(fileofs + 16, true),
        lightofs: view.getInt32(fileofs + 24, true),
        lmshift,
      });

      for (let j = 0; j < 4; j++) {
        if (styles[j] !== 255) {
          face.styles[j] = styles[j];
        }
      }

      const mins = [Infinity, Infinity];
      const maxs = [-Infinity, -Infinity];
      const tex = loadmodel.texinfo[face.texinfo];
      console.assert(typeof tex.texture === 'number', 'BSP2 texture indices must stay numeric');
      if (typeof tex.texture !== 'number') {
        throw new CorruptedResourceError(loadmodel.name, 'BSP2Loader: face texture index is not numeric');
      }
      face.texture = tex.texture;
      const texVec0 = new Vector(tex.vecs[0][0], tex.vecs[0][1], tex.vecs[0][2]);
      const texVec1 = new Vector(tex.vecs[1][0], tex.vecs[1][1], tex.vecs[1][2]);

      for (let j = 0; j < face.numedges; j++) {
        const edgeIndex = loadmodel.surfedges[face.firstedge + j];
        const vertex = edgeIndex >= 0
          ? loadmodel.vertexes[loadmodel.edges[edgeIndex][0]]
          : loadmodel.vertexes[loadmodel.edges[-edgeIndex][1]];

        const val0 = vertex.dot(texVec0) + tex.vecs[0][3];
        const val1 = vertex.dot(texVec1) + tex.vecs[1][3];

        if (val0 < mins[0]) {
          mins[0] = val0;
        }
        if (val0 > maxs[0]) {
          maxs[0] = val0;
        }
        if (val1 < mins[1]) {
          mins[1] = val1;
        }
        if (val1 > maxs[1]) {
          maxs[1] = val1;
        }
      }

      const lmscale = 1 << face.lmshift;
      face.texturemins = [Math.floor(mins[0] / lmscale) * lmscale, Math.floor(mins[1] / lmscale) * lmscale];
      face.extents = [Math.ceil(maxs[0] / lmscale) * lmscale - face.texturemins[0], Math.ceil(maxs[1] / lmscale) * lmscale - face.texturemins[1]];

      if ((loadmodel.textures[tex.texture].flags & MaterialFlags.MF_TURBULENT) !== 0) {
        face.turbulent = true;
      } else if ((loadmodel.textures[tex.texture].flags & MaterialFlags.MF_SKY) !== 0) {
        face.sky = true;
      }

      face.normal.set(face.plane.normal);
      if (face.planeBack) {
        face.normal.multiply(-1.0);
      }

      loadmodel.faces[i] = face;
      fileofs += 28;
    }

    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load BSP tree nodes from the BSP2 nodes lump.
   */
  protected override _loadNodes(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP2Loader.#lump;
    let fileofs = view.getUint32((lump.nodes << 3) + 4, true);
    const filelen = view.getUint32((lump.nodes << 3) + 8, true);

    if ((filelen === 0) || ((filelen % 44) !== 0)) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP2Loader: nodes lump size is invalid');
    }

    const count = filelen / 44;
    const nodes = new NodeTable(count);
    loadmodel.nodeTable = nodes;

    for (let i = 0; i < count; i++) {
      nodes.planeNums[i] = view.getUint32(fileofs, true);
      nodes.children[i * 2] = view.getInt32(fileofs + 4, true);
      nodes.children[i * 2 + 1] = view.getInt32(fileofs + 8, true);

      for (let k = 0; k < 6; k++) {
        nodes.bounds[i * 6 + k] = view.getFloat32(fileofs + 12 + k * 4, true);
      }

      nodes.firstFaces[i] = view.getUint32(fileofs + 36, true);
      nodes.numFaces[i] = view.getUint32(fileofs + 40, true);
      fileofs += 44;
    }

    this._linkTree(loadmodel);
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  protected override _loadLeafs(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP2Loader.#lump;
    let fileofs = view.getUint32((lump.leafs << 3) + 4, true);
    const filelen = view.getUint32((lump.leafs << 3) + 8, true);

    if ((filelen % 44) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP2Loader: leafs lump size is not a multiple of 44');
    }

    const count = filelen / 44;
    const leafs = new LeafTable(count);
    loadmodel.leafTable = leafs;

    for (let i = 0; i < count; i++) {
      leafs.contents[i] = view.getInt32(fileofs, true);
      leafs.visofs[i] = view.getInt32(fileofs + 4, true);
      leafs.clusters[i] = i > 0 ? i - 1 : -1;

      for (let k = 0; k < 6; k++) {
        leafs.bounds[i * 6 + k] = view.getFloat32(fileofs + 8 + k * 4, true);
      }

      leafs.firstMarkSurfaces[i] = view.getUint32(fileofs + 32, true);
      leafs.numMarkSurfaces[i] = view.getUint32(fileofs + 36, true);

      for (let k = 0; k < 4; k++) {
        leafs.ambient[i * 4 + k] = view.getUint8(fileofs + 40 + k);
      }

      fileofs += 44;
    }

    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load marksurfaces from the BSP2 marksurfaces lump.
   */
  protected override _loadMarksurfaces(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP2Loader.#lump;
    let fileofs = view.getUint32((lump.marksurfaces << 3) + 4, true);
    const filelen = view.getUint32((lump.marksurfaces << 3) + 8, true);

    if ((filelen & 3) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP2Loader: marksurfaces lump size is not a multiple of 4');
    }

    const count = filelen >> 2;
    loadmodel.marksurfaces.length = count;

    for (let i = 0; i < count; i++) {
      loadmodel.marksurfaces[i] = view.getUint32(fileofs, true);
      fileofs += 4;
    }

    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load clipnodes from the BSP2 clipnodes lump.
   */
  protected override _loadClipnodes(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP2Loader.#lump;
    let fileofs = view.getUint32((lump.clipnodes << 3) + 4, true);
    const filelen = view.getUint32((lump.clipnodes << 3) + 8, true);

    if ((filelen % 12) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP2Loader: clipnodes lump size is not a multiple of 12');
    }

    const count = filelen / 12;
    const tree = new ClipTree(count);
    loadmodel.clipTree = tree;
    loadmodel.hulls.length = 3;
    loadmodel.hulls[1] = new Hull(loadmodel.planeTable, tree, new Vector(-16.0, -16.0, -24.0), new Vector(16.0, 16.0, 32.0), 0, count - 1);
    loadmodel.hulls[2] = new Hull(loadmodel.planeTable, tree, new Vector(-32.0, -32.0, -24.0), new Vector(32.0, 32.0, 64.0), 0, count - 1);

    for (let i = 0; i < count; i++) {
      tree.set(i, view.getInt32(fileofs, true), view.getInt32(fileofs + 4, true), view.getInt32(fileofs + 8, true));
      fileofs += 12;
    }

    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load edges from the BSP2 edges lump.
   */
  protected override _loadEdges(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP2Loader.#lump;
    let fileofs = view.getUint32((lump.edges << 3) + 4, true);
    const filelen = view.getUint32((lump.edges << 3) + 8, true);

    if ((filelen % 8) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP2Loader: edges lump size is not a multiple of 8');
    }

    const count = filelen >> 3;
    loadmodel.edges.length = count;

    for (let i = 0; i < count; i++) {
      loadmodel.edges[i] = [view.getUint32(fileofs, true), view.getUint32(fileofs + 4, true)];
      fileofs += 8;
    }

    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }
}
