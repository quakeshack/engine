import { EPSILON } from '../../../shared/Defs.ts';

/**
 * Mesh utility helpers.
 */
export default class Mesh {
  /**
   * Calculate tangents and bitangents for a vertex array.
   * Stride is 20 floats: pos(3), uv(2), color(4), normal(3), tangent(3), bitangent(3).
   * @param cmds Vertex data array.
   * @param cutoff Number of floats to process (should be multiple of 60 for whole triangles).
   */
  static CalculateTangentBitangents(cmds: number[], cutoff: number): void {
    // compute per-triangle tangent/bitangent (stride = 20 floats)
    const stride = 20;
    for (let i = 0; i + stride * 3 <= Math.min(cutoff, cmds.length); i += stride * 3) {
      // vertices of triangle
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
      let f = 0.0;
      if (Math.abs(det) > EPSILON) { // CR: must be non-zero
        f = 1.0 / det;
      }
      const tx = f * (deltaUV2[1] * edge1[0] - deltaUV1[1] * edge2[0]);
      const ty = f * (deltaUV2[1] * edge1[1] - deltaUV1[1] * edge2[1]);
      const tz = f * (deltaUV2[1] * edge1[2] - deltaUV1[1] * edge2[2]);
      const bx = f * (-deltaUV2[0] * edge1[0] + deltaUV1[0] * edge2[0]);
      const by = f * (-deltaUV2[0] * edge1[1] + deltaUV1[0] * edge2[1]);
      const bz = f * (-deltaUV2[0] * edge1[2] + deltaUV1[0] * edge2[2]);

      for (const base of [i0, i1, i2]) {
        // Get the correct normal from the vertex data
        const nx = cmds[base + 11];
        const ny = cmds[base + 12];
        const nz = cmds[base + 13];

        // Gram-Schmidt: tangent = tangent - normal * dot(normal, tangent)
        const dot_nt = nx * tx + ny * ty + nz * tz;
        const ortho_tx = tx - nx * dot_nt;
        const ortho_ty = ty - ny * dot_nt;
        const ortho_tz = tz - nz * dot_nt;

        // normalize orthogonalized tangent
        const tlen = Math.hypot(ortho_tx, ortho_ty, ortho_tz) || 1.0;
        const tnorm = [ortho_tx / tlen, ortho_ty / tlen, ortho_tz / tlen];

        const dot_nb = nx * bx + ny * by + nz * bz;
        const ortho_bx = bx - nx * dot_nb;
        const ortho_by = by - ny * dot_nb;
        const ortho_bz = bz - nz * dot_nb;

        const dot_tb = tnorm[0] * ortho_bx + tnorm[1] * ortho_by + tnorm[2] * ortho_bz;
        const bitangentX = ortho_bx - tnorm[0] * dot_tb;
        const bitangentY = ortho_by - tnorm[1] * dot_tb;
        const bitangentZ = ortho_bz - tnorm[2] * dot_tb;
        const blen = Math.hypot(bitangentX, bitangentY, bitangentZ);

        const bnorm = blen > EPSILON ? [
          bitangentX / blen,
          bitangentY / blen,
          bitangentZ / blen,
        ] : [
          ny * tnorm[2] - nz * tnorm[1],
          nz * tnorm[0] - nx * tnorm[2],
          nx * tnorm[1] - ny * tnorm[0],
        ];

        cmds[base + 14] = tnorm[0];
        cmds[base + 15] = tnorm[1];
        cmds[base + 16] = tnorm[2];
        cmds[base + 17] = bnorm[0];
        cmds[base + 18] = bnorm[1];
        cmds[base + 19] = bnorm[2];
      }
    }
  }
}
