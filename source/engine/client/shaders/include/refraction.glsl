// Screen-space refraction: a translucent surface shows the copy of the scene drawn behind it, shifted by a
// distortion, instead of blending over it. The copies come from PostProcess.copySceneColor and copySceneDepth.
#include "depth.glsl"

uniform sampler2D tSceneColor;
uniform sampler2D tSceneEmissive;

// Strength of the shift, 0 = the surface does not refract and is blended as it always was.
uniform float uRefraction;

// Largest shift in screen UV, reached up close; it falls off with distance so far surfaces do not shimmer.
const float REFRACTION_MAX_SHIFT = 0.02;
const float REFRACTION_FULL_SHIFT_DISTANCE = 64.0;

/**
 * Where to sample what is behind the surface: the screen position shifted by the distortion, or the unshifted one
 * when the shifted sample lands on something in front of the surface, which would otherwise bleed into it.
 * distortion is in -1..1 per axis, surfaceDepth is the linear depth of the fragment.
 */
vec2 refractedScreenUV(sampler2D depthTexture, vec2 screenUV, vec2 distortion, float surfaceDepth) {
  float falloff = clamp(REFRACTION_FULL_SHIFT_DISTANCE / max(surfaceDepth, 1.0), 0.0, 1.0);
  vec2 shiftedUV = clamp(screenUV + distortion * (uRefraction * REFRACTION_MAX_SHIFT * falloff), vec2(0.0), vec2(1.0));
  float behind = step(surfaceDepth, linearizeDepth(texture(depthTexture, shiftedUV).r));

  return mix(screenUV, shiftedUV, behind);
}

/**
 * The surface over what is behind it at uv, as the blend would have put it, but opaque: the result replaces the
 * pixel because it already contains the scene. surface is the color the surface would have blended with alpha.
 */
vec4 composeRefraction(sampler2D sceneTexture, vec2 uv, vec3 surface, float alpha) {
  return vec4(mix(texture(sceneTexture, uv).rgb, surface, alpha), 1.0);
}
