#include "shadow-point.glsl"
#include "shadow-topdown.glsl"

// Top-down shadow mapping — a single fixed-direction directional shadow,
// centered on the camera every frame (see ShadowMap.renderTopDownShadow()).
uniform float uShadowEnabled;
uniform float uShadowDarkness;
uniform vec3 uShadowLightDir;

// Point light shadow mapping — up to 3 independent point-light shadow casters
// (see ShadowMap.selectPointLights()). The caller combines the three results,
// e.g. via min() when only a single dominant analytic dlight is tracked.
uniform samplerCubeShadow tPointShadowMap0;
uniform samplerCubeShadow tPointShadowMap1;
uniform samplerCubeShadow tPointShadowMap2;
uniform vec3 uPointLightPos0;
uniform vec3 uPointLightPos1;
uniform vec3 uPointLightPos2;
uniform float uPointLightRadius0;
uniform float uPointLightRadius1;
uniform float uPointLightRadius2;
uniform float uPointShadowEnabled;

// World position of the fragment, read by samplePointShadow().
in vec3 vWorldPos;

/**
 * Top-down shadow test, softened by the hardware's free 2×2 PCF (sampler2DShadow
 * + LINEAR filtering). Fades to fully-lit near the frustum edge instead of a
 * hard clip, and floors at uShadowDarkness rather than going fully black.
 */
float sampleLocalShadow(sampler2DShadow shadowMap, vec4 shadowCoordH) {
  // a uniform, so the draw does not diverge: the reads are skipped with r_shadows 0, see brush.frag
  if (uShadowEnabled < 0.5) {
    return 1.0;
  }

  vec3 shadowCoord = shadowCoordH.xyz / shadowCoordH.w * 0.5 + 0.5;
  float zValid = step(0.0, shadowCoord.z) * step(shadowCoord.z, 1.0);

  float edgeDist = max(abs(shadowCoord.x * 2.0 - 1.0), abs(shadowCoord.y * 2.0 - 1.0));
  float fade = (1.0 - smoothstep(0.7, 1.0, edgeDist)) * zValid;

  float rawShadow = limitTopDownShadowReach(texture(shadowMap, shadowCoord), shadowCoord);

  return mix(1.0, mix(uShadowDarkness, 1.0, rawShadow), fade);
}

/**
 * Point-light shadow test for one slot, occluded by its own cube depth map.
 * Radius is floored well above the near plane so the depth reconstruction
 * never divides by zero for an unused (zero-radius) slot.
 * @param normal World-space surface normal of the fragment.
 */
float samplePointShadow(samplerCubeShadow shadowMap, vec3 lightPos, float lightRadius, vec3 normal) {
  // uniforms, so the draw does not diverge: no point shadows this frame, or a slot without a light, see brush.frag
  if (uPointShadowEnabled < 0.5 || lightRadius <= 0.0) {
    return 1.0;
  }

  // The dynamic light falls off linearly and reaches zero at the radius, so the shadow test stays fully active up to
  // it: fading it out towards the edge lets the light through walls in a ring. Beyond it nothing is shadowed, and the
  // five cube reads are skipped; the side only changes on a sphere around the light, see brush.frag.
  float far = max(lightRadius, 2.0);
  if (length(vWorldPos - lightPos) > far) {
    return 1.0;
  }

  return samplePointShadowMap(shadowMap, vWorldPos, normal, lightPos, far);
}
