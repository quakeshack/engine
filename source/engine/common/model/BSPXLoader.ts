import type { ConsoleOutput } from '../Services.ts';
import Q from '../../../shared/Q.ts';
import Vector from '../../../shared/Vector.ts';
import type { BSPXLumps, BrushModel } from './BSP.ts';
import { Lightgrid } from './Lightgrid.ts';

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
   * octree, deluxemap and face normal lumps when present.
   *
   * Those three lumps are only read by the renderer, so they are skipped when
   * `loadRenderData` is false (a server). The lightgrid alone costs up to a
   * thousand times its lump size as objects. The lump directory is kept either way.
   */
  static load(loadmodel: BrushModel, buffer: ArrayBuffer, bspxoffset: number, con: ConsoleOutput, loadRenderData: boolean): void {
    loadmodel.bspxlumps = null;
    loadmodel.lightgrid = null;
    loadmodel.deluxemap = null;

    const alignedOffset = (bspxoffset + 3) & ~3;

    if (alignedOffset + 8 > buffer.byteLength) {
      con.DPrint('BSPXLoader: no BSPX data found\n');
      return;
    }

    const view = new DataView(buffer);
    const magic = view.getUint32(alignedOffset, true);

    if (magic !== BSPX_MAGIC) {
      con.DPrint('BSPXLoader: no BSPX data found\n');
      return;
    }

    const numlumps = view.getUint32(alignedOffset + 4, true);
    con.DPrint(`BSPXLoader: found BSPX data with ${numlumps} lumps\n`);

    const bspxLumps: BSPXLumps = {};

    for (let index = 0, pointer = alignedOffset + 8; index < numlumps; index++, pointer += 32) {
      const name = Q.memstr(new Uint8Array(buffer, pointer, 24));
      const fileofs = view.getUint32(pointer + 24, true);
      const filelen = view.getUint32(pointer + 28, true);
      bspxLumps[name] = { fileofs, filelen };
    }

    loadmodel.bspxlumps = bspxLumps;

    if (!loadRenderData) {
      return;
    }

    BSPXLoader.#loadLightgridOctree(loadmodel, buffer, con);
    BSPXLoader.#loadDeluxeMap(loadmodel, buffer);
    BSPXLoader.#loadFaceNormals(loadmodel, buffer, con);
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
  static #loadLightgridOctree(loadmodel: BrushModel, buf: ArrayBuffer, con: ConsoleOutput): void {
    if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['LIGHTGRID_OCTREE']) {
      return;
    }

    const { fileofs, filelen } = loadmodel.bspxlumps['LIGHTGRID_OCTREE'];

    if (filelen === 0) {
      return;
    }

    try {
      loadmodel.lightgrid = Lightgrid.parse(buf, fileofs, filelen, con);

      if (loadmodel.lightgrid !== null) {
        con.DPrint(`BSPXLoader: loaded LIGHTGRID_OCTREE with ${loadmodel.lightgrid.nodeCount} nodes and ${loadmodel.lightgrid.leafCount} leafs\n`);
      }
    } catch (error) {
      if (error instanceof Error) {
        con.PrintError(`BSPXLoader: error loading LIGHTGRID_OCTREE: ${error.message}\n`);
      } else {
        con.PrintError('BSPXLoader: error loading LIGHTGRID_OCTREE\n');
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
  static #loadFaceNormals(loadmodel: BrushModel, buf: ArrayBuffer, con: ConsoleOutput): void {
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
        con.DPrint('BSPXLoader: FACENORMALS lump too small\n');
        return;
      }

      // uint32_t num_unique_vecs, followed by a table of vec3_t vectors. Per-face data below
      // refers into this table by index, since a single vertex may need different normals when
      // used by different faces (smoothing groups).
      const numVecs = view.getUint32(offset, true);
      offset += 4;

      if (offset + numVecs * 12 > endOffset) {
        con.DPrint('BSPXLoader: FACENORMALS vector table truncated\n');
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
          con.DPrint(`BSPXLoader: FACENORMALS data truncated at face ${f}\n`);
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
            con.DPrint(`BSPXLoader: FACENORMALS vector index out of range at face ${f}\n`);
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

      con.DPrint(`BSPXLoader: loaded FACENORMALS for ${loadmodel.faces.length} faces\n`);
    } catch (error) {
      if (error instanceof Error) {
        con.PrintError(`BSPXLoader: error loading FACENORMALS: ${error.message}\n`);
      } else {
        con.PrintError('BSPXLoader: error loading FACENORMALS\n');
      }
    }
  }
}
