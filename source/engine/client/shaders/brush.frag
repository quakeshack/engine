#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp sampler2DShadow;
precision highp samplerCube;
precision highp samplerCubeShadow;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

#include "brush-shading.glsl"

// Shadow mapping
#include "shadow-topdown.glsl"

uniform float uShadowEnabled;
uniform float uShadowDarkness;
uniform float uShadowMapSize;
uniform vec3 uShadowLightDir;

// Point light shadow mapping — up to 3 independent point-light shadow casters,
// each with its own cube depth map so nearby dlights correctly occlude each
// other's contribution instead of only the single strongest one casting a
// shadow at all (see ShadowMap.selectPointLights()).
uniform samplerCubeShadow tPointShadowMap0;
uniform samplerCubeShadow tPointShadowMap1;
uniform samplerCubeShadow tPointShadowMap2;
uniform float uPointShadowEnabled;

/**
 * 5×5 Gaussian-weighted PCF for smooth top-down shadow edges. Each tap uses
 * the hardware sampler2DShadow (LINEAR gives free 2×2 PCF per tap), so this
 * is effectively a much wider, softer kernel than the single-tap version the
 * other model shaders use — worthwhile here since the world floor is the
 * largest, most prominent shadow receiver in the scene.
 */
float sampleLocalShadowPCF(sampler2DShadow shadowMap, vec4 shadowCoordH) {
  // a uniform, so the draw does not diverge: with r_shadows 0 the 27 reads are skipped, and the map is not read at
  // all, it is not drawn then and holds the shadow of the last frame that drew it
  if (uShadowEnabled < 0.5) {
    return 1.0;
  }

  vec3 shadowCoord = shadowCoordH.xyz / shadowCoordH.w * 0.5 + 0.5;
  if (shadowCoord.z < 0.0 || shadowCoord.z > 1.0) {
    return 1.0;
  }

  float edgeDist = max(abs(shadowCoord.x * 2.0 - 1.0), abs(shadowCoord.y * 2.0 - 1.0));
  float fade = 1.0 - smoothstep(0.7, 1.0, edgeDist);
  if (fade <= 0.0) {
    return 1.0;
  }

  float texelSize = 1.0 / uShadowMapSize;
  float lit = 0.0;
  lit += 1.0  * texture(shadowMap, shadowCoord + vec3(-2.0, -2.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3(-1.0, -2.0, 0.0) * texelSize);
  lit += 6.0  * texture(shadowMap, shadowCoord + vec3( 0.0, -2.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3( 1.0, -2.0, 0.0) * texelSize);
  lit += 1.0  * texture(shadowMap, shadowCoord + vec3( 2.0, -2.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3(-2.0, -1.0, 0.0) * texelSize);
  lit += 16.0 * texture(shadowMap, shadowCoord + vec3(-1.0, -1.0, 0.0) * texelSize);
  lit += 24.0 * texture(shadowMap, shadowCoord + vec3( 0.0, -1.0, 0.0) * texelSize);
  lit += 16.0 * texture(shadowMap, shadowCoord + vec3( 1.0, -1.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3( 2.0, -1.0, 0.0) * texelSize);
  lit += 6.0  * texture(shadowMap, shadowCoord + vec3(-2.0,  0.0, 0.0) * texelSize);
  lit += 24.0 * texture(shadowMap, shadowCoord + vec3(-1.0,  0.0, 0.0) * texelSize);
  lit += 36.0 * texture(shadowMap, shadowCoord + vec3( 0.0,  0.0, 0.0) * texelSize);
  lit += 24.0 * texture(shadowMap, shadowCoord + vec3( 1.0,  0.0, 0.0) * texelSize);
  lit += 6.0  * texture(shadowMap, shadowCoord + vec3( 2.0,  0.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3(-2.0,  1.0, 0.0) * texelSize);
  lit += 16.0 * texture(shadowMap, shadowCoord + vec3(-1.0,  1.0, 0.0) * texelSize);
  lit += 24.0 * texture(shadowMap, shadowCoord + vec3( 0.0,  1.0, 0.0) * texelSize);
  lit += 16.0 * texture(shadowMap, shadowCoord + vec3( 1.0,  1.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3( 2.0,  1.0, 0.0) * texelSize);
  lit += 1.0  * texture(shadowMap, shadowCoord + vec3(-2.0,  2.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3(-1.0,  2.0, 0.0) * texelSize);
  lit += 6.0  * texture(shadowMap, shadowCoord + vec3( 0.0,  2.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3( 1.0,  2.0, 0.0) * texelSize);
  lit += 1.0  * texture(shadowMap, shadowCoord + vec3( 2.0,  2.0, 0.0) * texelSize);
  lit /= 256.0;
  lit = limitTopDownShadowReach(lit, shadowCoord);

  return mix(1.0, mix(uShadowDarkness, 1.0, lit), fade);
}

#include "shadow-point.glsl"

/**
 * Analytic point-light contribution for one shadow-casting dlight, occluded
 * by its own cube depth map. Replaces the baked surface dlight texel for this
 * light (excluded from R.AddDynamicLights — see uPointLightPos0/1/2 wiring
 * in R.ts) so each shadow-casting light's brightness and occlusion stay
 * independent instead of a single shadow darkening every light's combined
 * contribution at once. The light itself is pointLightAttenuation().
 */
vec3 samplePointLightContribution(samplerCubeShadow shadowMap, vec3 lightPos, float lightRadius, vec3 lightColor) {
  vec3 light = pointLightAttenuation(lightPos, lightRadius, lightColor);

  // uniforms, so the draw does not diverge: without point shadows this frame, or for a slot that holds no light
  // (radius 0, a stale position and a cube map not drawn this frame), the five cube reads would be multiplied away
  if (uPointShadowEnabled < 0.5 || lightRadius <= 0.0) {
    return light;
  }

  // The light falls off linearly and reaches zero at the radius, so the shadow test stays fully active up to it:
  // fading it out towards the edge lets the light through walls in a ring. Beyond it there is no light to shadow, and
  // the five cube reads are skipped. Not a uniform, but the side only changes on a sphere around the light, so
  // neighboring fragments take the same one, and most of a frame's fragments are outside every light.
  float far = max(lightRadius, 2.0);
  if (length(vWorldPos - lightPos) >= far) {
    return light;
  }

  return light * samplePointShadowMap(shadowMap, vWorldPos, vNormal, lightPos, far);
}

void main(void) {
  // Mask the shadow off surfaces that face away from the top-down light
  // direction (walls, the underside of beams/ceilings) — such a surface
  // never receives direct light from straight overhead in the first place,
  // so it should never show a contact-shadow blotch either. Falls off
  // smoothly to zero at grazing angles rather than a hard cutoff.
  float shadowFacing = clamp(dot(normalize(vNormal), -uShadowLightDir), 0.0, 1.0);

  // Top-down shadow — modulates the lightmap; fades smoothly to fully-lit at
  // coverage edge. 5×5 Gaussian-weighted PCF for smooth shadow edges. A surface
  // the mask takes it off entirely skips the 27 reads: the normal is the same
  // across a world face, so the whole face takes the same side of the branch.
  float shadow = 1.0;
  if (shadowFacing > 0.0) {
    shadow = mix(1.0, sampleLocalShadowPCF(tShadowMap, vShadowCoord), shadowFacing);
  }

  // Point light shadows — up to 3 independent shadow-casting dlights, each
  // occluded by its own cube depth map and added on top of the baked dlight
  // texture (which excludes these lights; see R.AddDynamicLights). This way
  // nearby dlights correctly shadow each other instead of a single shadow
  // darkening every light's combined contribution at once.
  vec3 pointDlight = samplePointLightContribution(tPointShadowMap0, uPointLightPos0, uPointLightRadius0, uPointLightColor0)
                    + samplePointLightContribution(tPointShadowMap1, uPointLightPos1, uPointLightRadius1, uPointLightColor1)
                    + samplePointLightContribution(tPointShadowMap2, uPointLightPos2, uPointLightRadius2, uPointLightColor2);

  // A nearby, unoccluded shadow-casting dlight (rocket, explosion) locally
  // fills in the top-down shadow — a surface lit brightly by a point light
  // right next to it isn't really "in the dark" there anymore, regardless of
  // what the fixed overhead shadow direction says. pointDlight is already
  // occlusion-tested against its own cube depth map, so a dlight blocked by
  // geometry between it and this fragment correctly does not fill anything in.
  float dlightFill = clamp(max(pointDlight.r, max(pointDlight.g, pointDlight.b)), 0.0, 1.0);
  shadow = max(shadow, dlightFill);

  vec3 color;
  vec3 emissive;
  float alpha;
  shadeBrushSurface(shadow, pointDlight, color, emissive, alpha);

  fragColor = vec4(color, alpha);
  fragEmissive = vec4(emissive, alpha);
}
