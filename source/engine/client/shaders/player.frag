#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DShadow;
precision highp samplerCubeShadow;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uGamma;
uniform vec3 uAmbientLight;
uniform vec3 uShadeLight;
uniform vec3 uDynamicShadeLight;
uniform float uTime;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform sampler2D tTexture;
uniform sampler2D tLuminance;
uniform sampler2D tPlayer;
uniform float uAlpha;
uniform float uBloomEmissiveScale;

// Shadow mapping
uniform sampler2DShadow tShadowMap0;
uniform sampler2DShadow tShadowMap1;
uniform sampler2DShadow tShadowMap2;
uniform float uShadowEnabled;
uniform int uShadowCount;
uniform float uShadowDarkness;

// Point light shadow mapping — up to 3 independent point-light shadow casters
// (see ShadowMap.selectPointLights()); combined via min() below since the
// player model only tracks a single dominant analytic dlight direction/color.
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
uniform float uPointShadowBias;

in vec2 vTexCoord;
in float vLightDot;
in float vDynamicLightDot;
in float vFog;
in vec4 vShadowCoord0;
in vec4 vShadowCoord1;
in vec4 vShadowCoord2;
in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vLightVec;
in vec3 vDynamicLightVec;
in vec3 vViewVec;
uniform vec3 uFogColor;

// Specular highlight for the player model — no per-texel specular map exists
// here, so intensity/shininess are fixed, tuned for a subtle, non-metallic
// highlight rather than a per-material property. Ambient light is
// intentionally excluded since it is non-directional and produces no
// highlight.
const float kPlayerSpecularShininess = 24.0;
const float kPlayerSpecularIntensity = 0.25;

float sampleLocalShadow(sampler2DShadow shadowMap, vec4 shadowCoordH) {
  vec3 shadowCoord = shadowCoordH.xyz / shadowCoordH.w * 0.5 + 0.5;
  float zValid = step(0.0, shadowCoord.z) * step(shadowCoord.z, 1.0);

  float edgeDist = max(abs(shadowCoord.x * 2.0 - 1.0), abs(shadowCoord.y * 2.0 - 1.0));
  float fade = (1.0 - smoothstep(0.7, 1.0, edgeDist)) * zValid;

  float rawShadow = texture(shadowMap, shadowCoord);
  return mix(1.0, mix(uShadowDarkness, 1.0, rawShadow), fade);
}

/**
 * 5-tap PCF for the point light cube shadow map: samples the direction plus
 * four small angular offsets along axes perpendicular to it, softening the
 * low-resolution (256px/face) map (a single hardware-filtered tap otherwise
 * shows up as visible speckle). Offsets are applied to the normalized
 * direction so the angular jitter stays constant regardless of the
 * fragment's distance from the light — except close to the light, where a
 * fixed angular offset is no longer safe: a nearby corner or second surface
 * can occupy a large fraction of the light's surrounding sphere, so an
 * offset tap is likely to land on a completely different, disjoint piece of
 * geometry than the one actually being shaded. Comparing that unrelated
 * stored depth against this fragment's refDepth produces exactly the
 * fragment-to-fragment inconsistent result that reads as shadow acne, so the
 * disk is tapered down to a single hard tap as fragDist approaches the light.
 */
float samplePointShadowPCF(samplerCubeShadow shadowMap, vec3 dir, float refDepth, float fragDist) {
  vec3 dirN = normalize(dir);
  float useAltUp = step(0.99, abs(dirN.y));
  vec3 upHint = mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), useAltUp);
  vec3 right = normalize(cross(upHint, dirN));
  vec3 up = cross(dirN, right);

  const float kDiskReferenceDistance = 48.0;
  float diskRadius = 0.02 * clamp(fragDist / kDiskReferenceDistance, 0.0, 1.0);
  float lit = 0.0;
  lit += texture(shadowMap, vec4(dirN, refDepth));
  lit += texture(shadowMap, vec4(normalize(dirN + right * diskRadius), refDepth));
  lit += texture(shadowMap, vec4(normalize(dirN - right * diskRadius), refDepth));
  lit += texture(shadowMap, vec4(normalize(dirN + up * diskRadius), refDepth));
  lit += texture(shadowMap, vec4(normalize(dirN - up * diskRadius), refDepth));
  return lit * 0.2;
}

/**
 * Point-light shadow test for one slot, occluded by its own cube depth map.
 * Radius is floored well above the near plane so the depth reconstruction
 * never divides by zero for an unused (zero-radius) slot.
 */
float samplePointShadow(samplerCubeShadow shadowMap, vec3 lightPos, float lightRadius) {
  vec3 fragToLight = vWorldPos - lightPos;
  float fragDist = length(fragToLight);
  vec3 absFTL = abs(fragToLight);
  float viewZ = max(absFTL.x, max(absFTL.y, absFTL.z));
  float n = 1.0;
  float f = max(lightRadius, 2.0);
  // Window-space depth stored by the cube face projection (kept in sync with
  // ShadowMap.buildPointFaceMatrix). viewZ is clamped to the near plane to
  // avoid a division by zero when a fragment coincides with the light origin.
  float clampedViewZ = max(viewZ, n);
  float refDepth = f * (clampedViewZ - n) / ((f - n) * clampedViewZ);
  // Constant bias applied in normalized depth space (post-projection) rather
  // than world space: the near/far mapping is hyperbolic, so a fixed
  // world-unit offset is only effective close to the light and vanishes for
  // casters further out within the same radius, leaving acne everywhere else.
  refDepth = clamp(refDepth - uPointShadowBias, 0.0, 1.0);
  float cubeShadow = samplePointShadowPCF(shadowMap, fragToLight, refDepth, fragDist);
  return mix(1.0, cubeShadow, step(fragDist, f) * step(0.5, uPointShadowEnabled));
}

void main(void) {
  vec4 texel = texture(tTexture, vTexCoord);
  vec3 luminance = texture(tLuminance, vTexCoord).rgb;
  vec4 player = texture(tPlayer, vTexCoord);

  // Local entity shadow — small local depth map, BSP-light-driven direction.
  // Fades smoothly to fully-lit at the coverage edge (no hard clip).
  float s0 = sampleLocalShadow(tShadowMap0, vShadowCoord0);
  float s1 = sampleLocalShadow(tShadowMap1, vShadowCoord1);
  float s2 = sampleLocalShadow(tShadowMap2, vShadowCoord2);

  float shadow = mix(1.0, s0, step(1.0, float(uShadowCount)));
  shadow = mix(shadow, min(s0, s1), step(2.0, float(uShadowCount)));
  shadow = mix(shadow, min(min(s0, s1), s2), step(3.0, float(uShadowCount)));
  shadow = mix(1.0, shadow, step(0.5, uShadowEnabled));

  // Point light shadows — entity shadows from up to 3 nearby dynamic lights.
  // Combined via min() since this model only tracks one dominant analytic
  // dlight term below, so it darkens if occluded from any active light.
  float pointShadow0 = samplePointShadow(tPointShadowMap0, uPointLightPos0, uPointLightRadius0);
  float pointShadow1 = samplePointShadow(tPointShadowMap1, uPointLightPos1, uPointLightRadius1);
  float pointShadow2 = samplePointShadow(tPointShadowMap2, uPointLightPos2, uPointLightRadius2);
  float pointShadow = min(min(pointShadow0, pointShadow1), pointShadow2);

  vec3 lighting = (vLightDot * uShadeLight + uAmbientLight + vDynamicLightDot * uDynamicShadeLight * pointShadow) * shadow;

  // Blinn-Phong specular, tinted by the light color rather than the diffuse
  // texture (a dielectric-style highlight), gated by the same shadow terms
  // as the matching diffuse contribution above.
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vViewVec);
  float specDot = max(0.0, dot(N, normalize(vLightVec + V)));
  float dynamicSpecDot = max(0.0, dot(N, normalize(vDynamicLightVec + V)));
  vec3 specular = (pow(specDot, kPlayerSpecularShininess) * uShadeLight * shadow
                 + pow(dynamicSpecDot, kPlayerSpecularShininess) * uDynamicShadeLight * pointShadow) * kPlayerSpecularIntensity;

  vec3 baseColor = mix(mix(texel.rgb, uTop * ((1.0 / 191.25) * player.x), player.y), uBottom * ((1.0 / 191.25) * player.z), player.w);

  fragColor = vec4(baseColor * mix(vec3(1.0), lighting, texel.a) + specular * texel.a, texel.a);
  fragColor.rgb = pow(fragColor.rgb, vec3(uGamma));
  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a * uAlpha);
  vec3 emissiveColor = baseColor * clamp(luminance + vec3(uBloomEmissiveScale), 0.0, 1.0);
  emissiveColor = pow(emissiveColor, vec3(uGamma));
  emissiveColor = mix(uFogColor, emissiveColor, vFog);
  fragEmissive = vec4(emissiveColor, fragColor.a);
}

