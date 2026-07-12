import { eventBus, getCommonRegistry } from '../../registry.ts';
import Q from '../../../shared/Q.ts';
import Vector from '../../../shared/Vector.ts';
import { type BSPXLumps, type BrushModel, type LightgridLeaf, type LightgridNode, type LightgridPointSample, type LightgridStyleSample } from './BSP.ts';

let { Con } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con } = getCommonRegistry());
});

const BSPX_MAGIC = 0x58505342;

/**
 * Loads the BSPX extension trailer (an optional lump directory appended
 * after the end of a map's regular lump data) along with the lumps that are
 * genuinely format-agnostic: `LIGHTGRID_OCTREE` (volumetric light-probe grid
 * for dynamic entities), `LIGHTINGDIR` (per-lightmap-texel dominant light
 * direction, aka deluxemap, used for PBR normal/specular shading), and
 * `FACENORMALS` (precomputed per-face, per-vertex normals/tangents/bitangents,
 * used for phong-smoothed shading instead of the flat per-face normal). Shared
 * by every BSP loader (BSP29, BSP2, BSP38): callers just need to know where
 * their own lump data ends (`bspxoffset`).
 *
 * Format-specific BSPX lumps (`BRUSHLIST`, `RGBLIGHTING`) stay in
 * `BSP29Loader` — they exist to backfill data Quake 1's native format
 * doesn't have at all, which doesn't apply to formats with native brush
 * data or native RGB lighting.
 */
export class BSPXLoader {
  private constructor() {
    // Static-only helper class.
  }

  /**
   * Parse the BSPX trailer starting at `bspxoffset` (rounded up to the next
   * 4-byte boundary, matching the on-disk convention) and load the lightgrid
   * octree and deluxemap lumps when present.
   */
  static load(loadmodel: BrushModel, buffer: ArrayBuffer, bspxoffset: number): void {
    loadmodel.bspxlumps = null;
    loadmodel.lightgrid = null;
    loadmodel.deluxemap = null;

    const alignedOffset = (bspxoffset + 3) & ~3;

    if (alignedOffset + 8 > buffer.byteLength) {
      Con.DPrint('BSPXLoader: no BSPX data found\n');
      return;
    }

    const view = new DataView(buffer);
    const magic = view.getUint32(alignedOffset, true);

    if (magic !== BSPX_MAGIC) {
      Con.DPrint('BSPXLoader: no BSPX data found\n');
      return;
    }

    const numlumps = view.getUint32(alignedOffset + 4, true);
    Con.DPrint(`BSPXLoader: found BSPX data with ${numlumps} lumps\n`);

    const bspxLumps: BSPXLumps = {};

    for (let index = 0, pointer = alignedOffset + 8; index < numlumps; index++, pointer += 32) {
      const name = Q.memstr(new Uint8Array(buffer, pointer, 24));
      const fileofs = view.getUint32(pointer + 24, true);
      const filelen = view.getUint32(pointer + 28, true);
      bspxLumps[name] = { fileofs, filelen };
    }

    loadmodel.bspxlumps = bspxLumps;

    BSPXLoader.#loadLightgridOctree(loadmodel, buffer);
    BSPXLoader.#loadDeluxeMap(loadmodel, buffer);
    BSPXLoader.#loadFaceNormals(loadmodel, buffer);
  }

  /**
   * Load deluxemap (directional lighting normals) from the `LIGHTINGDIR` BSPX lump if available.
   */
  static #loadDeluxeMap(loadmodel: BrushModel, buf: ArrayBuffer): void {
    if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['LIGHTINGDIR']) {
      return;
    }

    const { fileofs, filelen } = loadmodel.bspxlumps['LIGHTINGDIR'];

    if (filelen === 0) {
      return;
    }

    loadmodel.deluxemap = new Uint8Array(buf.slice(fileofs, fileofs + filelen));
  }

  /**
   * Load the lightgrid octree from the `LIGHTGRID_OCTREE` BSPX lump if available.
   */
  static #loadLightgridOctree(loadmodel: BrushModel, buf: ArrayBuffer): void {
    if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['LIGHTGRID_OCTREE']) {
      return;
    }

    const { fileofs, filelen } = loadmodel.bspxlumps['LIGHTGRID_OCTREE'];

    if (filelen === 0) {
      return;
    }

    try {
      const view = new DataView(buf);
      let offset = fileofs;
      const endOffset = fileofs + filelen;

      // Minimum size check: vec3_t step (12) + ivec3_t size (12) + vec3_t mins (12) + byte numstyles (1) + uint32_t rootnode (4) + uint32_t numnodes (4) + uint32_t numleafs (4) = 49 bytes
      if (filelen < 49) {
        Con.DPrint('BSPXLoader: LIGHTGRID_OCTREE lump too small\n');
        return;
      }

      // vec3_t step
      const step: [number, number, number] = [
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true),
      ];
      offset += 12;

      // ivec3_t size
      const size: [number, number, number] = [
        view.getInt32(offset, true),
        view.getInt32(offset + 4, true),
        view.getInt32(offset + 8, true),
      ];
      offset += 12;

      // vec3_t mins
      const mins = new Vector(
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true),
      );
      offset += 12;

      // byte numstyles (WARNING: misaligns the rest of the data)
      const numstyles = view.getUint8(offset);
      offset += 1;

      // uint32_t rootnode
      const rootnode = view.getUint32(offset, true);
      offset += 4;

      // uint32_t numnodes
      const numnodes = view.getUint32(offset, true);
      offset += 4;

      // Check if we have enough data for nodes (each node is 44 bytes: 3*4 for mid + 8*4 for children)
      if (offset + (numnodes * 44) > endOffset) {
        Con.DPrint('BSPXLoader: LIGHTGRID_OCTREE nodes data truncated\n');
        return;
      }

      // Parse nodes
      const nodes: LightgridNode[] = [];
      for (let i = 0; i < numnodes; i++) {
        const mid = [
          view.getUint32(offset, true),
          view.getUint32(offset + 4, true),
          view.getUint32(offset + 8, true),
        ] as [number, number, number];
        offset += 12;

        const child: number[] = [];
        for (let j = 0; j < 8; j++) {
          child[j] = view.getUint32(offset, true);
          offset += 4;
        }

        nodes[i] = { mid, child };
      }

      // uint32_t numleafs
      if (offset + 4 > endOffset) {
        Con.DPrint('BSPXLoader: LIGHTGRID_OCTREE numleafs missing\n');
        return;
      }
      const numleafs = view.getUint32(offset, true);
      offset += 4;

      // Parse leafs
      const leafs: LightgridLeaf[] = [];
      for (let i = 0; i < numleafs; i++) {
        // Check bounds for leaf header (mins + size = 24 bytes)
        if (offset + 24 > endOffset) {
          Con.DPrint(`BSPXLoader: LIGHTGRID_OCTREE leaf ${i} header truncated\n`);
          return;
        }

        const leafMins: [number, number, number] = [
          view.getInt32(offset, true),
          view.getInt32(offset + 4, true),
          view.getInt32(offset + 8, true),
        ];
        offset += 12;

        const leafSize: [number, number, number] = [
          view.getInt32(offset, true),
          view.getInt32(offset + 4, true),
          view.getInt32(offset + 8, true),
        ];
        offset += 12;

        // Parse per-point data
        const totalPoints = leafSize[0] * leafSize[1] * leafSize[2];
        const points: LightgridPointSample[] = [];

        for (let p = 0; p < totalPoints; p++) {
          // Check bounds for stylecount byte
          if (offset >= endOffset) {
            Con.DPrint(`BSPXLoader: LIGHTGRID_OCTREE leaf ${i} point ${p} truncated\n`);
            return;
          }

          const stylecount = view.getUint8(offset);
          offset += 1;

          // Skip points with no data (stylecount = 0xff means missing)
          if (stylecount === 0xff) {
            points.push({ stylecount, styles: [] });
            continue;
          }

          const styles: LightgridStyleSample[] = [];
          for (let s = 0; s < stylecount; s++) {
            // Check bounds for style data (1 byte stylenum + 3 bytes rgb = 4 bytes)
            if (offset + 3 >= endOffset) {
              Con.DPrint(`BSPXLoader: LIGHTGRID_OCTREE leaf ${i} point ${p} style ${s} truncated\n`);
              return;
            }

            const stylenum = view.getUint8(offset);

            offset += 1;

            const rgb = [
              view.getUint8(offset),
              view.getUint8(offset + 1),
              view.getUint8(offset + 2),
            ] as [number, number, number];
            offset += 3;

            styles.push({ stylenum, rgb });
          }

          points.push({ stylecount, styles });
        }

        leafs.push({ mins: leafMins, size: leafSize, points });
      }

      loadmodel.lightgrid = {
        step,
        size,
        mins,
        numstyles,
        rootnode,
        nodes,
        leafs,
      };

      Con.DPrint(`BSPXLoader: loaded LIGHTGRID_OCTREE with ${numnodes} nodes and ${numleafs} leafs\n`);
    } catch (error) {
      if (error instanceof Error) {
        Con.PrintError(`BSPXLoader: error loading LIGHTGRID_OCTREE: ${error.message}\n`);
      } else {
        Con.PrintError('BSPXLoader: error loading LIGHTGRID_OCTREE\n');
      }
      loadmodel.lightgrid = null;
    }
  }

  /**
   * Load per-face, per-vertex normals/tangents/bitangents from the `FACENORMALS` BSPX lump if
   * available. Requires `loadmodel.faces` to already be populated — every loader calls
   * `BSPXLoader.load()` after its face lump has been parsed, since the per-face vertex count
   * comes from `face.numedges`.
   */
  static #loadFaceNormals(loadmodel: BrushModel, buf: ArrayBuffer): void {
    if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['FACENORMALS']) {
      return;
    }

    const { fileofs, filelen } = loadmodel.bspxlumps['FACENORMALS'];

    if (filelen === 0) {
      return;
    }

    try {
      const view = new DataView(buf);
      let offset = fileofs;
      const endOffset = fileofs + filelen;

      if (offset + 4 > endOffset) {
        Con.DPrint('BSPXLoader: FACENORMALS lump too small\n');
        return;
      }

      // uint32_t num_unique_vecs, followed by a table of vec3_t vectors. Per-face data below
      // refers into this table by index, since a single vertex may need different normals when
      // used by different faces (smoothing groups).
      const numVecs = view.getUint32(offset, true);
      offset += 4;

      if (offset + numVecs * 12 > endOffset) {
        Con.DPrint('BSPXLoader: FACENORMALS vector table truncated\n');
        return;
      }

      const vecs: Vector[] = new Array(numVecs);
      for (let i = 0; i < numVecs; i++) {
        vecs[i] = new Vector(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
        offset += 12;
      }

      // Parse per-face, per-vertex {normal, tangent, bitangent} index triplets into scratch
      // arrays first, and only commit them onto the Face objects once the whole lump has parsed
      // successfully — avoids leaving faces half-populated on a truncated/corrupt lump.
      const perFaceNormals: Vector[][] = new Array(loadmodel.faces.length);
      const perFaceTangents: Vector[][] = new Array(loadmodel.faces.length);
      const perFaceBitangents: Vector[][] = new Array(loadmodel.faces.length);

      for (let f = 0; f < loadmodel.faces.length; f++) {
        const face = loadmodel.faces[f];

        if (offset + face.numedges * 12 > endOffset) {
          Con.DPrint(`BSPXLoader: FACENORMALS data truncated at face ${f}\n`);
          return;
        }

        const normals: Vector[] = new Array(face.numedges);
        const tangents: Vector[] = new Array(face.numedges);
        const bitangents: Vector[] = new Array(face.numedges);

        for (let v = 0; v < face.numedges; v++) {
          const normalIndex = view.getUint32(offset, true);
          const tangentIndex = view.getUint32(offset + 4, true);
          const bitangentIndex = view.getUint32(offset + 8, true);
          offset += 12;

          if (normalIndex >= numVecs || tangentIndex >= numVecs || bitangentIndex >= numVecs) {
            Con.DPrint(`BSPXLoader: FACENORMALS vector index out of range at face ${f}\n`);
            return;
          }

          normals[v] = vecs[normalIndex];
          tangents[v] = vecs[tangentIndex];
          bitangents[v] = vecs[bitangentIndex];
        }

        perFaceNormals[f] = normals;
        perFaceTangents[f] = tangents;
        perFaceBitangents[f] = bitangents;
      }

      for (let f = 0; f < loadmodel.faces.length; f++) {
        loadmodel.faces[f].vertexNormals = perFaceNormals[f];
        loadmodel.faces[f].vertexTangents = perFaceTangents[f];
        loadmodel.faces[f].vertexBitangents = perFaceBitangents[f];
      }

      Con.DPrint(`BSPXLoader: loaded FACENORMALS for ${loadmodel.faces.length} faces\n`);
    } catch (error) {
      if (error instanceof Error) {
        Con.PrintError(`BSPXLoader: error loading FACENORMALS: ${error.message}\n`);
      } else {
        Con.PrintError('BSPXLoader: error loading FACENORMALS\n');
      }
    }
  }
}
