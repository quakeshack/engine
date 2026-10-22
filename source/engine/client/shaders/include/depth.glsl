uniform mat4 uPerspective;

/**
 * Convert a depth buffer value (non-linear) to linear view-space distance.
 * Derives near/far from the actual perspective matrix elements:
 *   uPerspective[2][2] = -(far+near)/(far-near)
 *   uPerspective[3][2] = -2*near*far/(far-near)
 * Uses highp to avoid precision artifacts in the near-plane division.
 */
float linearizeDepth(highp float depth) {
  highp float z_ndc = depth * 2.0 - 1.0;
  return uPerspective[3][2] / (z_ndc + uPerspective[2][2]);
}
