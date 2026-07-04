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
uniform sampler2D tTexture;
uniform sampler2D tLuminance;
uniform float uAlpha;
uniform float uBloomEmissiveScale;

// Top-down shadow mapping — a single fixed-direction directional shadow,
// centered on the camera every frame (see ShadowMap.renderTopDownShadow()).
uniform sampler2DShadow tShadowMap;
uniform float uShadowEnabled;
uniform float uShadowDarkness;
uniform float uShadowMaxDepthNDC;
uniform vec3 uShadowLightDir;

// Point light shadow mapping — up to 3 independent point-light shadow casters
// (see ShadowMap.selectPointLights()); combined via min() below since alias
// models only track a single dominant analytic dlight direction/color.
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
in vec4 vShadowCoord;
in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vLightVec;
in vec3 vDynamicLightVec;
in vec3 vViewVec;
uniform vec3 uFogColor;

// Specular highlight for alias models — MDL models carry no per-texel
// specular map, so intensity/shininess are fixed, tuned for a subtle,
// non-metallic highlight rather than a per-material property. Ambient light
// is intentionally excluded since it is non-directional and produces no
// highlight.
const float kAliasSpecularShininess = 64.0;
const float kAliasSpecularIntensity = 0.125;

/**
 * Top-down shadow test, softened by the hardware's free 2×2 PCF (sampler2DShadow
 * + LINEAR filtering). Fades to fully-lit near the frustum edge instead of a
 * hard clip, and floors at uShadowDarkness rather than going fully black.
 */
float sampleLocalShadow(sampler2DShadow shadowMap, vec4 shadowCoordH) {
  vec3 shadowCoord = shadowCoordH.xyz / shadowCoordH.w * 0.5 + 0.5;
  float zValid = step(0.0, shadowCoord.z) * step(shadowCoord.z, 1.0);

  float edgeDist = max(abs(shadowCoord.x * 2.0 - 1.0), abs(shadowCoord.y * 2.0 - 1.0));
  float fade = (1.0 - smoothstep(0.7, 1.0, edgeDist)) * zValid;

  float lit = texture(shadowMap, shadowCoord);

  // Discount the occlusion when the nearest recorded caster is farther than
  // uShadowMaxDepthNDC above this fragment — see brush.frag's
  // sampleLocalShadowPCF for why (a caster overhead should not bleed its
  // shadow through intervening geometry onto a much lower surface).
  float inRange = texture(shadowMap, vec3(shadowCoord.xy, shadowCoord.z - uShadowMaxDepthNDC));
  lit = 1.0 - (1.0 - lit) * inRange;

  float shadow = mix(1.0, mix(uShadowDarkness, 1.0, lit), fade);
  return mix(1.0, shadow, step(0.5, uShadowEnabled));
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
  // The surface dlight attenuation falls off linearly and reaches exactly
  // zero at fragDist == f (radius), so the shadow test must stay active for
  // that whole range or occluded surfaces bleed unshadowed light in the band
  // between the old, premature cutoff and the light's true edge.
  float ptFade = 1.0 - smoothstep(f * 0.85, f, fragDist);
  return mix(1.0, cubeShadow, ptFade * step(fragDist, f) * step(0.5, uPointShadowEnabled));
}

void main(void){
  vec4 texel = texture(tTexture, vTexCoord);
  vec3 luminance = texture(tLuminance, vTexCoord).rgb;

  // Top-down shadow — fades smoothly to fully-lit at the coverage edge (no hard clip).
  float shadow = sampleLocalShadow(tShadowMap, vShadowCoord);

  // Mask the shadow off surfaces that face away from the top-down light
  // direction — see brush.frag's main() for why.
  float shadowFacing = clamp(dot(normalize(vNormal), -uShadowLightDir), 0.0, 1.0);
  shadow = mix(1.0, shadow, shadowFacing);

  // Point light shadows — entity shadows from up to 3 nearby dynamic lights.
  // Combined via min() since this model only tracks one dominant analytic
  // dlight term below, so it darkens if occluded from any active light.
  float pointShadow0 = samplePointShadow(tPointShadowMap0, uPointLightPos0, uPointLightRadius0);
  float pointShadow1 = samplePointShadow(tPointShadowMap1, uPointLightPos1, uPointLightRadius1);
  float pointShadow2 = samplePointShadow(tPointShadowMap2, uPointLightPos2, uPointLightRadius2);
  float pointShadow = min(min(pointShadow0, pointShadow1), pointShadow2);

  // A nearby, unoccluded shadow-casting dlight locally fills in the top-down
  // shadow — see brush.frag's main() for why. pointShadow already accounts
  // for the dlight being blocked by geometry between it and this fragment.
  float dlightFill = clamp(vDynamicLightDot * max(uDynamicShadeLight.r, max(uDynamicShadeLight.g, uDynamicShadeLight.b)) * pointShadow, 0.0, 1.0);
  shadow = max(shadow, dlightFill);

  // Point shadow only occludes the dynamic light term — dlights are
  // additive, so it must never darken the base ambient/shade lighting.
  vec3 lighting = ((vLightDot * uShadeLight + uAmbientLight)
                + vDynamicLightDot * uDynamicShadeLight * pointShadow) * shadow;

  // Blinn-Phong specular, tinted by the light color rather than the diffuse
  // texture (a dielectric-style highlight), gated by the same shadow terms
  // as the matching diffuse contribution above.
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vViewVec);
  float specDot = max(0.0, dot(N, normalize(vLightVec + V)));
  float dynamicSpecDot = max(0.0, dot(N, normalize(vDynamicLightVec + V)));
  vec3 specular = (pow(specDot, kAliasSpecularShininess) * uShadeLight * shadow
                 + pow(dynamicSpecDot, kAliasSpecularShininess) * uDynamicShadeLight * pointShadow) * kAliasSpecularIntensity;

  fragColor = vec4(texel.rgb * mix(vec3(1.0), lighting, texel.a) + specular * texel.a, uAlpha);
  fragColor.rgb = pow(fragColor.rgb, vec3(uGamma));
  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);
  vec3 emissiveColor = texel.rgb * clamp(luminance + vec3(uBloomEmissiveScale), 0.0, 1.0);
  emissiveColor = pow(emissiveColor, vec3(uGamma));
  emissiveColor = mix(uFogColor, emissiveColor, vFog);
  fragEmissive = vec4(emissiveColor, fragColor.a);
}
