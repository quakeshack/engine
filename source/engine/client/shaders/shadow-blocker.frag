#version 300 es
precision highp float;
precision highp sampler2DShadow;

// The caster map of the top-down shadow, drawn just before this pass with the same projection and size.
uniform sampler2DShadow tShadowMap;

// How far a world surface must lie below a caster to count as below it, in the caster map's depth units.
uniform float uCasterEpsilon;

/**
 * One tap of the caster map around this fragment's texel.
 * @returns 1 where this fragment is at or above the casters of the 2×2 texels around the tap, or none is there.
 */
float tapAboveCasters(vec2 uv, vec2 offset, vec2 texelSize, float reference) {
  return texture(tShadowMap, vec3(uv + offset * texelSize, reference));
}

// The blocker map keeps the nearest world surface below a caster (ShadowMap.renderTopDownBlockers()). A world fragment
// survives when a caster lies above it anywhere within the receivers' 5×5 PCF footprint, not only at its own texel:
// otherwise the soft edge of a shadow would find no blocker under it and outline the caster on the floor below.
void main(void) {
  vec2 texelSize = 1.0 / vec2(textureSize(tShadowMap, 0));
  vec2 uv = gl_FragCoord.xy * texelSize;
  float reference = gl_FragCoord.z - uCasterEpsilon;

  // The center tap reads its own texel, the taps 1.5 texels off read two texels each: together 2 texels around it.
  float aboveCasters = tapAboveCasters(uv, vec2(0.0, 0.0), texelSize, reference);
  aboveCasters = min(aboveCasters, tapAboveCasters(uv, vec2(-1.5, -1.5), texelSize, reference));
  aboveCasters = min(aboveCasters, tapAboveCasters(uv, vec2( 0.0, -1.5), texelSize, reference));
  aboveCasters = min(aboveCasters, tapAboveCasters(uv, vec2( 1.5, -1.5), texelSize, reference));
  aboveCasters = min(aboveCasters, tapAboveCasters(uv, vec2(-1.5,  0.0), texelSize, reference));
  aboveCasters = min(aboveCasters, tapAboveCasters(uv, vec2( 1.5,  0.0), texelSize, reference));
  aboveCasters = min(aboveCasters, tapAboveCasters(uv, vec2(-1.5,  1.5), texelSize, reference));
  aboveCasters = min(aboveCasters, tapAboveCasters(uv, vec2( 0.0,  1.5), texelSize, reference));
  aboveCasters = min(aboveCasters, tapAboveCasters(uv, vec2( 1.5,  1.5), texelSize, reference));

  if (aboveCasters > 0.999) {
    discard;
  }

  // Depth is written automatically by the rasterizer.
}
