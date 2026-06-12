import { EPSILON } from '../../../shared/Defs.ts';

/**
 * Mesh utility helpers.
 */
export default class Mesh {
  /**
   * Build a stable key for vertices that should share tangent-space accumulation.
   * Uses quantized position/UV/normal to tolerate tiny floating-point drift.
   * @returns Quantized key used for accumulation lookup.
   */
  static _buildTangentVertexKey(cmds: number[], base: number): string {
    const quantize = (value: number): number => Math.round(value * 1_000_000.0);

    return [
      quantize(cmds[base + 0]),
      quantize(cmds[base + 1]),
      quantize(cmds[base + 2]),
      quantize(cmds[base + 3]),
      quantize(cmds[base + 4]),
      quantize(cmds[base + 11]),
      quantize(cmds[base + 12]),
      quantize(cmds[base + 13]),
    ].join('|');
  }

  /**
   * Generate a deterministic tangent perpendicular to a normal.
   * @returns Unit-length fallback tangent.
   */
  static _fallbackTangentFromNormal(nx: number, ny: number, nz: number): [number, number, number] {
    if (Math.abs(nz) < 0.999) {
      const tx = -ny;
      const ty = nx;
      const tz = 0.0;
      const len = Math.hypot(tx, ty, tz) || 1.0;

      return [tx / len, ty / len, tz / len];
    }

    const tx = 0.0;
    const ty = nz;
    const tz = -ny;
    const len = Math.hypot(tx, ty, tz) || 1.0;

    return [tx / len, ty / len, tz / len];
  }

  /**
   * Calculate tangents and bitangents for a vertex array.
   * Stride is 20 floats: pos(3), uv(2), color(4), normal(3), tangent(3), bitangent(3).
   * @param cmds Vertex data array.
   * @param cutoff Number of floats to process (should be multiple of 60 for whole triangles).
   */
  static CalculateTangentBitangents(cmds: number[], cutoff: number): void {
    const stride = 20;
    const maxOffset = Math.min(cutoff, cmds.length);
    const accumulators = new Map<string, {
      tx: number;
      ty: number;
      tz: number;
      bx: number;
      by: number;
      bz: number;
    }>();

    for (let i = 0; i + stride * 3 <= maxOffset; i += stride * 3) {
      const i0 = i;
      const i1 = i + stride;
      const i2 = i + stride * 2;
      const p0 = [cmds[i0 + 0], cmds[i0 + 1], cmds[i0 + 2]];
      const p1 = [cmds[i1 + 0], cmds[i1 + 1], cmds[i1 + 2]];
      const p2 = [cmds[i2 + 0], cmds[i2 + 1], cmds[i2 + 2]];
      const uv0 = [cmds[i0 + 3], cmds[i0 + 4]];
      const uv1 = [cmds[i1 + 3], cmds[i1 + 4]];
      const uv2 = [cmds[i2 + 3], cmds[i2 + 4]];

      const edge1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const edge2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const deltaUV1 = [uv1[0] - uv0[0], uv1[1] - uv0[1]];
      const deltaUV2 = [uv2[0] - uv0[0], uv2[1] - uv0[1]];
      const det = deltaUV1[0] * deltaUV2[1] - deltaUV2[0] * deltaUV1[1];

      if (Math.abs(det) <= EPSILON) {
        continue;
      }

      const f = 1.0 / det;
      const tx = f * (deltaUV2[1] * edge1[0] - deltaUV1[1] * edge2[0]);
      const ty = f * (deltaUV2[1] * edge1[1] - deltaUV1[1] * edge2[1]);
      const tz = f * (deltaUV2[1] * edge1[2] - deltaUV1[1] * edge2[2]);
      const bx = f * (-deltaUV2[0] * edge1[0] + deltaUV1[0] * edge2[0]);
      const by = f * (-deltaUV2[0] * edge1[1] + deltaUV1[0] * edge2[1]);
      const bz = f * (-deltaUV2[0] * edge1[2] + deltaUV1[0] * edge2[2]);

      for (const base of [i0, i1, i2]) {
        const key = Mesh._buildTangentVertexKey(cmds, base);
        const entry = accumulators.get(key);

        if (entry) {
          entry.tx += tx;
          entry.ty += ty;
          entry.tz += tz;
          entry.bx += bx;
          entry.by += by;
          entry.bz += bz;
          continue;
        }

        accumulators.set(key, { tx, ty, tz, bx, by, bz });
      }
    }

    for (let base = 0; base + stride <= maxOffset; base += stride) {
      const key = Mesh._buildTangentVertexKey(cmds, base);
      const accumulator = accumulators.get(key);

      if (!accumulator) {
        continue;
      }

      let tx = accumulator.tx;
      let ty = accumulator.ty;
      let tz = accumulator.tz;
      let bx = accumulator.bx;
      let by = accumulator.by;
      let bz = accumulator.bz;

      {
        const nx = cmds[base + 11];
        const ny = cmds[base + 12];
        const nz = cmds[base + 13];

        const dot_nt = nx * tx + ny * ty + nz * tz;
        tx -= nx * dot_nt;
        ty -= ny * dot_nt;
        tz -= nz * dot_nt;

        const tlen = Math.hypot(tx, ty, tz);
        let tangentX = 0.0;
        let tangentY = 0.0;
        let tangentZ = 0.0;

        if (tlen > EPSILON) {
          tangentX = tx / tlen;
          tangentY = ty / tlen;
          tangentZ = tz / tlen;
        } else {
          const fallbackTangent = Mesh._fallbackTangentFromNormal(nx, ny, nz);
          tangentX = fallbackTangent[0];
          tangentY = fallbackTangent[1];
          tangentZ = fallbackTangent[2];
        }

        const dot_nb = nx * bx + ny * by + nz * bz;
        bx -= nx * dot_nb;
        by -= ny * dot_nb;
        bz -= nz * dot_nb;

        const dot_tb = tangentX * bx + tangentY * by + tangentZ * bz;
        let bitangentX = bx - tangentX * dot_tb;
        let bitangentY = by - tangentY * dot_tb;
        let bitangentZ = bz - tangentZ * dot_tb;
        const blen = Math.hypot(bitangentX, bitangentY, bitangentZ);

        if (blen > EPSILON) {
          bitangentX /= blen;
          bitangentY /= blen;
          bitangentZ /= blen;
        } else {
          bitangentX = ny * tangentZ - nz * tangentY;
          bitangentY = nz * tangentX - nx * tangentZ;
          bitangentZ = nx * tangentY - ny * tangentX;
        }

        cmds[base + 14] = tangentX;
        cmds[base + 15] = tangentY;
        cmds[base + 16] = tangentZ;
        cmds[base + 17] = bitangentX;
        cmds[base + 18] = bitangentY;
        cmds[base + 19] = bitangentZ;
      }
    }
  }
}
