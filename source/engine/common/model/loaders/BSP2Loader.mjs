import Vector from '../../../../shared/Vector.ts';
import { CorruptedResourceError } from '../../Errors.ts';
import { BSP29Loader } from './BSP29Loader.ts';
import { Face } from '../BaseModel.ts';
import { BrushModel, Node } from '../BSP.ts';
import { materialFlags } from '../../../client/renderer/Materials.mjs';

/**
 * Loader for BSP2 format (.bsp)
 * Magic: 'BSP2' (0x32425350 / 844124994 in little-endian)
 *
 * BSP2 is an extended version of BSP29 that uses 32-bit indices instead of 16-bit
 * to support larger maps with more vertices, edges, faces, etc.
 *
 * Key differences from BSP29:
 * - Faces: uint32 for planenum/numedges, int32 for side (28 bytes vs 20)
 * - Nodes: float for mins/maxs, int32 for children, uint32 for faces (44 bytes vs 24)
 * - Leafs: float for mins/maxs, uint32 for marksurfaces (44 bytes vs 28)
 * - Marksurfaces: uint32 indices instead of uint16
 * - Surfedges: same as BSP29 (int32)
 * - Clipnodes: int32 for child indices instead of int16
 * @augments BSP29Loader
 */
// @ts-ignore - Method override is intentional for BSP2 format differences
export class BSP2Loader extends BSP29Loader {
  /**
   * Get magic numbers that identify this format
   * @returns {number[]} Array of magic numbers
   */
  getMagicNumbers() {
    // 'BSP2' in little-endian = 0x32425350 = 844124994
    return [844124994];
  }

  /**
   * Get human-readable name of this loader
   * @returns {string} Loader name
   */
  getName() {
    return 'BSP2';
  }

  /**
   * Load faces from BSP lump (BSP2 version with 32-bit indices)
   * @protected
   * @param {BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {CorruptedResourceError} If faces lump size is not a multiple of 28
   */
  _loadFaces(loadmodel, buf) {
    const view = new DataView(buf);
    // Use parent class lump enum (it's private, so we calculate offset same way)
    const lumpIndex = 7; // faces lump
    let fileofs = view.getUint32((lumpIndex << 3) + 4, true);
    const filelen = view.getUint32((lumpIndex << 3) + 8, true);

    // BSP2 faces are 28 bytes
    if ((filelen % 28) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP2Loader: faces lump size is not a multiple of 28');
    }

    const lmshift = loadmodel.worldspawnInfo._lightmap_scale ? Math.log2(parseInt(loadmodel.worldspawnInfo._lightmap_scale)) : 4;
    const count = filelen / 28;
    loadmodel.firstface = 0;
    loadmodel.numfaces = count;
    loadmodel.faces.length = count;

    for (let i = 0; i < count; i++) {
      const styles = new Uint8Array(buf, fileofs + 20, 4);
      const out = Object.assign(new Face(), {
        plane: loadmodel.planes[view.getUint32(fileofs, true)], // int planenum (offset 0)
        planeBack: view.getInt32(fileofs + 4, true) !== 0, // int side (offset 4)
        firstedge: view.getUint32(fileofs + 8, true), // int firstedge (offset 8)
        numedges: view.getUint32(fileofs + 12, true), // int numedges (offset 12)
        texinfo: view.getUint32(fileofs + 16, true), // int texinfo (offset 16)
        lightofs: view.getInt32(fileofs + 24, true), // int lightofs (offset 24)
        lmshift,
      });

      for (let j = 0; j < 4; j++) {
        if (styles[j] !== 255) {
          out.styles[j] = styles[j];
        }
      }

      const mins = [Infinity, Infinity];
      const maxs = [-Infinity, -Infinity];
      const tex = loadmodel.texinfo[out.texinfo];
      out.texture = tex.texture;

      for (let j = 0; j < out.numedges; j++) {
        const e = loadmodel.surfedges[out.firstedge + j];
        const v = e >= 0
          ? loadmodel.vertexes[loadmodel.edges[e][0]]
          : loadmodel.vertexes[loadmodel.edges[-e][1]];

        const val0 = v.dot(new Vector(...tex.vecs[0])) + tex.vecs[0][3];
        const val1 = v.dot(new Vector(...tex.vecs[1])) + tex.vecs[1][3];

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

      const lmscale = 1 << out.lmshift;
      out.texturemins = [Math.floor(mins[0] / lmscale) * lmscale, Math.floor(mins[1] / lmscale) * lmscale];
      out.extents = [Math.ceil(maxs[0] / lmscale) * lmscale - out.texturemins[0], Math.ceil(maxs[1] / lmscale) * lmscale - out.texturemins[1]];

      if (loadmodel.textures[tex.texture].flags & materialFlags.MF_TURBULENT) {
        out.turbulent = true;
      } else if (loadmodel.textures[tex.texture].flags & materialFlags.MF_SKY) {
        out.sky = true;
      }

      out.normal.set(out.plane.normal);
      if (out.planeBack) {
        out.normal.multiply(-1.0);
      }

      loadmodel.faces[i] = out;
      fileofs += 28;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load BSP tree nodes from BSP lump (BSP2 version with 32-bit children indices)
   * @protected
   * @param {BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {CorruptedResourceError} If nodes lump is empty or incorrectly sized
   */
  _loadNodes(loadmodel, buf) {
    const view = new DataView(buf);
    const lumpIndex = 5; // nodes lump
    let fileofs = view.getUint32((lumpIndex << 3) + 4, true);
    const filelen = view.getUint32((lumpIndex << 3) + 8, true);

    // BSP2 nodes are 44 bytes (vs 24 in BSP29):
    // uint32 planenum, int32 children[2], float mins[3], float maxs[3],
    // uint32 firstface, uint32 numfaces
    if ((filelen === 0) || ((filelen % 44) !== 0)) {
      throw new Error('BSP2Loader: nodes lump size is invalid in ' + loadmodel.name);
    }
    const count = filelen / 44;
    loadmodel.nodes.length = count;

    for (let i = 0; i < count; i++) {
      loadmodel.nodes[i] = Object.assign(new Node(loadmodel), {
        num: i,
        planenum: view.getUint32(fileofs, true),
        children: [view.getInt32(fileofs + 4, true), view.getInt32(fileofs + 8, true)], // int32 instead of int16
        mins: new Vector(view.getFloat32(fileofs + 12, true), view.getFloat32(fileofs + 16, true), view.getFloat32(fileofs + 20, true)), // float instead of int16
        maxs: new Vector(view.getFloat32(fileofs + 24, true), view.getFloat32(fileofs + 28, true), view.getFloat32(fileofs + 32, true)), // float instead of int16
        firstface: view.getUint32(fileofs + 36, true), // uint32 instead of uint16
        numfaces: view.getUint32(fileofs + 40, true), // uint32 instead of uint16
      });
      loadmodel.nodes[i].baseMins = loadmodel.nodes[i].mins.copy();
      loadmodel.nodes[i].baseMaxs = loadmodel.nodes[i].maxs.copy();
      fileofs += 44;
    }

    for (let i = 0; i < count; i++) {
      const out = loadmodel.nodes[i];
      out.plane = loadmodel.planes[out.planenum];
      // At this point children contain indices, we convert them to Node references
      const child0Idx = /** @type {number} */ (out.children[0]);
      const child1Idx = /** @type {number} */ (out.children[1]);
      out.children[0] = child0Idx >= 0
        ? loadmodel.nodes[child0Idx]
        : loadmodel.leafs[-1 - child0Idx];
      out.children[1] = child1Idx >= 0
        ? loadmodel.nodes[child1Idx]
        : loadmodel.leafs[-1 - child1Idx];
    }

    // Set parent references recursively
    const setParent = (node, parent) => {
      node.parent = parent;
      // Stop recursion at leaf nodes (contents < 0 or null children)
      if (node.contents < 0 || !node.children[0] || !node.children[1]) {
        return;
      }
      setParent(/** @type {Node} */(node.children[0]), node);
      setParent(/** @type {Node} */(node.children[1]), node);
    };
    setParent(loadmodel.nodes[0], null);
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load BSP leaf nodes from BSP lump (BSP2 version with 32-bit indices)
   * @protected
   * @param {BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {Error} If leafs lump size is not a multiple of 44
   */
  _loadLeafs(loadmodel, buf) {
    const view = new DataView(buf);
    const lumpIndex = 10; // leafs lump
    let fileofs = view.getUint32((lumpIndex << 3) + 4, true);
    const filelen = view.getUint32((lumpIndex << 3) + 8, true);

    // BSP2 leafs are 44 bytes (vs 28 in BSP29):
    // int32 contents, int32 visofs, float mins[3], float maxs[3],
    // uint32 firstmarksurface, uint32 nummarksurfaces, uint8 ambient_level[4]
    if ((filelen % 44) !== 0) {
      throw new Error('BSP2Loader: leafs lump size is not a multiple of 44 in ' + loadmodel.name);
    }
    const count = filelen / 44;
    loadmodel.leafs.length = count;

    for (let i = 0; i < count; i++) {
      loadmodel.leafs[i] = Object.assign(new Node(loadmodel), {
        num: i,
        contents: view.getInt32(fileofs, true),
        visofs: view.getInt32(fileofs + 4, true),
        cluster: i > 0 ? i - 1 : -1,
        mins: new Vector(view.getFloat32(fileofs + 8, true), view.getFloat32(fileofs + 12, true), view.getFloat32(fileofs + 16, true)), // float instead of int16
        maxs: new Vector(view.getFloat32(fileofs + 20, true), view.getFloat32(fileofs + 24, true), view.getFloat32(fileofs + 28, true)), // float instead of int16
        firstmarksurface: view.getUint32(fileofs + 32, true), // uint32 instead of uint16
        nummarksurfaces: view.getUint32(fileofs + 36, true), // uint32 instead of uint16
        ambient_level: [
          view.getUint8(fileofs + 40),
          view.getUint8(fileofs + 41),
          view.getUint8(fileofs + 42),
          view.getUint8(fileofs + 43),
        ],
      });
      loadmodel.leafs[i].baseMins = loadmodel.leafs[i].mins.copy();
      loadmodel.leafs[i].baseMaxs = loadmodel.leafs[i].maxs.copy();
      fileofs += 44;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load marksurfaces from BSP lump (BSP2 version with 32-bit indices)
   * @protected
   * @param {BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {CorruptedResourceError} If marksurfaces lump size is not a multiple of 4
   */
  _loadMarksurfaces(loadmodel, buf) {
    const view = new DataView(buf);
    const lumpIndex = 11; // marksurfaces lump
    let fileofs = view.getUint32((lumpIndex << 3) + 4, true);
    const filelen = view.getUint32((lumpIndex << 3) + 8, true);

    // BSP2 uses uint32 for marksurfaces (vs uint16 in BSP29)
    if ((filelen & 3) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP2Loader: marksurfaces lump size is not a multiple of 4');
    }
    const count = filelen >> 2;
    loadmodel.marksurfaces.length = count;

    for (let i = 0; i < count; i++) {
      loadmodel.marksurfaces[i] = view.getUint32(fileofs, true); // uint32 instead of uint16
      fileofs += 4;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load collision clipnodes and initialize physics hulls (BSP2 version with 32-bit children)
   * @protected
   * @param {BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   */
  _loadClipnodes(loadmodel, buf) {
    const view = new DataView(buf);
    const lumpIndex = 9; // clipnodes lump
    let fileofs = view.getUint32((lumpIndex << 3) + 4, true);
    const filelen = view.getUint32((lumpIndex << 3) + 8, true);

    // BSP2 clipnodes are 12 bytes (vs 8 in BSP29):
    // int32 planenum, int32 children[2]
    if ((filelen % 12) !== 0) {
      throw new Error('BSP2Loader: clipnodes lump size is not a multiple of 12 in ' + loadmodel.name);
    }
    const count = filelen / 12;
    loadmodel.clipnodes.length = count;

    // Initialize hulls (same as BSP29)
    loadmodel.hulls.length = 3;
    loadmodel.hulls[1] = {
      clipnodes: loadmodel.clipnodes,
      firstclipnode: 0,
      lastclipnode: count - 1,
      planes: loadmodel.planes,
      clip_mins: new Vector(-16.0, -16.0, -24.0),
      clip_maxs: new Vector(16.0, 16.0, 32.0),
    };
    loadmodel.hulls[2] = {
      clipnodes: loadmodel.clipnodes,
      firstclipnode: 0,
      lastclipnode: count - 1,
      planes: loadmodel.planes,
      clip_mins: new Vector(-32.0, -32.0, -24.0),
      clip_maxs: new Vector(32.0, 32.0, 64.0),
    };

    for (let i = 0; i < count; i++) {
      loadmodel.clipnodes[i] = {
        planenum: view.getInt32(fileofs, true),
        children: [view.getInt32(fileofs + 4, true), view.getInt32(fileofs + 8, true)], // int32 instead of int16
      };
      fileofs += 12;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load edges from BSP lump
   * @protected
   * @param {BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {CorruptedResourceError} If edge lump size is not a multiple of 8
   */
  _loadEdges(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = 12; // edges lump
    let fileofs = view.getUint32((lump << 3) + 4, true);
    const filelen = view.getUint32((lump << 3) + 8, true);
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
