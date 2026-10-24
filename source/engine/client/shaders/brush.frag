#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp sampler2DShadow;
precision highp samplerCube;
precision highp samplerCubeShadow;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uGamma;
uniform float uInterpolation;
uniform float uLightstyleInterpolation;
uniform float uAlpha;
uniform float uBloomEmissiveScale;
uniform float uBloomDlightScale;
uniform float uBloomSpecularScale;

uniform sampler2D tTextureA;
uniform sampler2D tTextureB;
uniform sampler2DArray tLightmap;
uniform sampler2D tDlight;
uniform sampler2D tLightStyleA;
uniform sampler2D tLightStyleB;
uniform sampler2D tLuminance;
uniform sampler2D tNormal;
uniform sampler2D tSpecular;
uniform sampler2DArray tDeluxemap;

// Shadow mapping
uniform sampler2DShadow tShadowMap;
uniform float uShadowEnabled;
uniform float uShadowDarkness;
uniform float uShadowMapSize;
uniform float uShadowMaxDepthNDC;
uniform vec3 uShadowLightDir;

// Point light shadow mapping — up to 3 independent point-light shadow casters,
// each with its own cube depth map so nearby dlights correctly occlude each
// other's contribution instead of only the single strongest one casting a
// shadow at all (see ShadowMap.selectPointLights()).
uniform samplerCubeShadow tPointShadowMap0;
uniform samplerCubeShadow tPointShadowMap1;
uniform samplerCubeShadow tPointShadowMap2;
uniform vec3 uPointLightPos0;
uniform vec3 uPointLightPos1;
uniform vec3 uPointLightPos2;
uniform float uPointLightRadius0;
uniform float uPointLightRadius1;
uniform float uPointLightRadius2;
uniform vec3 uPointLightColor0;
uniform vec3 uPointLightColor1;
uniform vec3 uPointLightColor2;
uniform float uPointShadowEnabled;
uniform float uPointShadowBias;

uniform bool uPerformDotLighting;
uniform bool uHaveDeluxemap;

uniform vec3 uAmbientLight;
uniform vec3 uShadeLight;
uniform vec3 uDynamicShadeLight;

in vec4 vTexCoord;
in vec4 vLightStyle;
in float vLightDot;
in float vDynamicLightDot;
#include "fog-fragment.glsl"
in vec3 vNormal;
in vec3 vLightVec;
in vec3 vDynamicLightVec;
in vec3 vTangent;
in vec3 vBitangent;
in vec3 vViewVec;
in vec4 vShadowCoord;
in vec3 vWorldPos;

/**
 * 5×5 Gaussian-weighted PCF for smooth top-down shadow edges. Each tap uses
 * the hardware sampler2DShadow (LINEAR gives free 2×2 PCF per tap), so this
 * is effectively a much wider, softer kernel than the single-tap version the
 * other model shaders use — worthwhile here since the world floor is the
 * largest, most prominent shadow receiver in the scene.
 */
float sampleLocalShadowPCF(sampler2DShadow shadowMap, vec4 shadowCoordH) {
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

  // Discount the occlusion when the nearest recorded caster is farther than
  // uShadowMaxDepthNDC above this fragment along the shadow direction —
  // otherwise a caster high overhead (e.g. standing on a catwalk) bleeds its
  // shadow straight through the catwalk itself onto whatever floor happens
  // to be far below, since the depth map has no notion of the catwalk ever
  // being there. Reusing the same hardware-compare sampler with a shifted
  // reference depth answers "is there still an occluder within range?" for
  // free, with no extra texture or raw depth read needed.
  float inRange = texture(shadowMap, vec3(shadowCoord.xy, shadowCoord.z - uShadowMaxDepthNDC));
  lit = 1.0 - (1.0 - lit) * inRange;

  return mix(1.0, mix(uShadowDarkness, 1.0, lit), fade);
}

#include "shadow-point.glsl"

/**
 * Analytic point-light contribution for one shadow-casting dlight, occluded
 * by its own cube depth map. Replaces the baked surface dlight texel for this
 * light (excluded from R.AddDynamicLights — see uPointLightPos0/1/2 wiring
 * in R.ts) so each shadow-casting light's brightness and occlusion stay
 * independent instead of a single shadow darkening every light's combined
 * contribution at once.
 *
 * The linear falloff and 2.0/255.0 scale reproduce the brightness curve of
 * the baked surface dlight (see R.AddDynamicLights: byte = clamp((radius -
 * dist) * 2 * color, 0, 255)), just evaluated per-fragment against the true
 * 3D distance instead of the baked texel-space approximation. Radius is
 * floored well above the near plane so the depth reconstruction below never
 * divides by zero for an unused (zero-radius) slot.
 */
vec3 samplePointLightContribution(samplerCubeShadow shadowMap, vec3 lightPos, float lightRadius, vec3 lightColor) {
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
  // Falls off linearly and reaches exactly zero at fragDist == f (radius), so
  // the shadow test must stay active for that whole range or occluded
  // surfaces bleed unshadowed light in the band between the old, premature
  // cutoff and the light's true edge.
  float ptFade = 1.0 - smoothstep(f * 0.85, f, fragDist);
  float pointShadow = mix(1.0, cubeShadow, ptFade * step(fragDist, f) * step(0.5, uPointShadowEnabled));

  vec3 atten = clamp((f - fragDist) * (2.0 / 255.0) * lightColor, 0.0, 1.0);
  return atten * pointShadow;
}

void main(void) {
  // Combine texture samples at the start
  vec4 textureA = texture(tTextureA, vTexCoord.xy);
  vec4 textureB = texture(tTextureB, vTexCoord.xy);
  vec4 luminance = texture(tLuminance, vTexCoord.xy);

  // interpolation
  vec4 texel = mix(textureA, textureB, uInterpolation);

  // Pre-calculate lightstyle constant
  const float LIGHTSTYLE_SCALE = 43.828125;

  // Optimize lightstyle sampling - use texture lookups more efficiently
  vec4 lightstyleA = vec4(
    texture(tLightStyleA, vec2(vLightStyle.x, 0.0)).r,
    texture(tLightStyleA, vec2(vLightStyle.y, 0.0)).r,
    texture(tLightStyleA, vec2(vLightStyle.z, 0.0)).r,
    texture(tLightStyleA, vec2(vLightStyle.w, 0.0)).r
  );
  vec4 lightstyleB = vec4(
    texture(tLightStyleB, vec2(vLightStyle.x, 0.0)).r,
    texture(tLightStyleB, vec2(vLightStyle.y, 0.0)).r,
    texture(tLightStyleB, vec2(vLightStyle.z, 0.0)).r,
    texture(tLightStyleB, vec2(vLightStyle.w, 0.0)).r
  );
  vec4 lightstyle = mix(lightstyleA, lightstyleB, uLightstyleInterpolation) * LIGHTSTYLE_SCALE;

  // Sample lightmap layers (R, G, B each in a separate array layer). Each
  // column holds the four lightstyles of one color channel, so a row vector of
  // per-style weights times this matrix sums the styles per channel.
  vec4 lightmapR = texture(tLightmap, vec3(vTexCoord.zw, 0.0));
  vec4 lightmapG = texture(tLightmap, vec3(vTexCoord.zw, 1.0));
  vec4 lightmapB = texture(tLightmap, vec3(vTexCoord.zw, 2.0));
  mat3x4 lightmapStyles = mat3x4(lightmapR, lightmapG, lightmapB);

  // Top-down shadow — modulates the lightmap; fades smoothly to fully-lit at
  // coverage edge. 5×5 Gaussian-weighted PCF for smooth shadow edges.
  float shadow = sampleLocalShadowPCF(tShadowMap, vShadowCoord);

  // Mask the shadow off surfaces that face away from the top-down light
  // direction (walls, the underside of beams/ceilings) — such a surface
  // never receives direct light from straight overhead in the first place,
  // so it should never show a contact-shadow blotch either. Falls off
  // smoothly to zero at grazing angles rather than a hard cutoff.
  float shadowFacing = clamp(dot(normalize(vNormal), -uShadowLightDir), 0.0, 1.0);
  shadow = mix(1.0, shadow, shadowFacing);

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

  vec3 surfaceDlight = texture(tDlight, vTexCoord.zw).rgb + pointDlight;

  // Every lightstyle is shaded as a light of its own, against its own baked
  // direction, and the styles are summed afterwards. Blending the directions
  // first would swing the shading direction whenever one style flickers, which
  // makes the bump-mapped surface look as if its geometry were moving.
  vec4 styleBump = vec4(1.0);
  vec4 styleSpecular = vec4(0.0);
  float dlightBump = 1.0;
  float dynSpecFactor = 0.0;

  if (uPerformDotLighting) {
    float dynamicStrength = clamp(max(uDynamicShadeLight.r, max(uDynamicShadeLight.g, uDynamicShadeLight.b)), 0.0, 1.0);

    // Sample normal and specular maps once
    vec3 normalPoint = texture(tNormal, vTexCoord.xy).xyz;
    float specIntensity = texture(tSpecular, vTexCoord.xy).r;

    // Convert normal from [0,1] to [-1,1] and invert X,Y in one operation
    vec3 normalMap = normalize(vec3(
      -(normalPoint.x * 2.0 - 1.0),
      -(normalPoint.y * 2.0 - 1.0),
      normalPoint.z * 2.0 - 1.0
    ));

    // Gram-Schmidt orthogonalize tangent against normal (inline to avoid extra variables)
    vec3 n = normalize(vNormal);
    vec3 t = normalize(vTangent - n * dot(n, vTangent));
    vec3 b = normalize(vBitangent - n * dot(n, vBitangent) - t * dot(t, vBitangent));

    // Build TBN transform and apply to normal
    vec3 N = normalize(t * normalMap.x + b * normalMap.y + n * normalMap.z);
    vec3 V = normalize(vViewVec);

    // Per-style light directions in the face's texture space (s, -t, normal),
    // the basis ericw-tools writes the LIGHTINGDIR lump in. Without a
    // deluxemap, every style shares the direction the vertex shader has.
    vec3 fallbackLight = normalize(vLightVec);
    vec4 lightS = vec4(dot(fallbackLight, t));
    vec4 lightT = vec4(-dot(fallbackLight, b));
    vec4 lightN = vec4(dot(fallbackLight, n));

    if (uHaveDeluxemap) {
      // Each component is stored as (v + 1) * 128 in a byte.
      const float DELUXEMAP_DECODE = 255.0 / 128.0;
      lightS = texture(tDeluxemap, vec3(vTexCoord.zw, 0.0)) * DELUXEMAP_DECODE - 1.0;
      lightT = texture(tDeluxemap, vec3(vTexCoord.zw, 1.0)) * DELUXEMAP_DECODE - 1.0;
      lightN = texture(tDeluxemap, vec3(vTexCoord.zw, 2.0)) * DELUXEMAP_DECODE - 1.0;
    }

    // t, b and n are orthonormal, so a dot product with a style's world-space
    // direction is the same combination of the basis projections, and its
    // length is the length of the texture-space vector.
    vec4 styleInvLength = inversesqrt(max(lightS * lightS + lightT * lightT + lightN * lightN, 0.0001));
    vec4 styleNdotL = (lightS * dot(N, t) - lightT * dot(N, b) + lightN * dot(N, n)) * styleInvLength;
    vec4 styleVdotL = (lightS * dot(V, t) - lightT * dot(V, b) + lightN * dot(V, n)) * styleInvLength;
    // N·H with H = normalize(L + V), where |L + V|² = 2 + 2 L·V.
    vec4 styleNdotH = (styleNdotL + dot(N, V)) * inversesqrt(max(2.0 + 2.0 * styleVdotL, 0.0001));

    // Add dynamic light contribution
    float dynLightDot = max(dot(N, vDynamicLightVec), 0.0) * dynamicStrength;
    vec3 dynH = normalize(vDynamicLightVec + V);
    dynSpecFactor = specIntensity * pow(max(dot(N, dynH), 0.0), 16.0) * dynamicStrength;

    // The lightmap already holds the cosine against the flat surface, so the
    // bumped normal only rescales it by how much more or less it faces the
    // light than the flat surface does. A flat normal reproduces the lightmap
    // exactly, also where the baked direction is grazing (multiplying by N·L
    // there counts the cosine twice and leaves dark blotches). The softening
    // term keeps that ratio bounded at grazing angles.
    const float GRAZING_SOFTENING = 0.25;
    const float MAX_BUMP_GAIN = 2.0;
    vec4 styleFlatNdotL = lightN * styleInvLength;
    vec4 styleGain = (max(styleNdotL, 0.0) + GRAZING_SOFTENING) / (max(styleFlatNdotL, 0.0) + GRAZING_SOFTENING);
    styleGain = min(styleGain, MAX_BUMP_GAIN);

    // Blend between full lighting and bump-modified lighting, which keeps
    // surfaces facing away from a light from going completely black while
    // still letting the bump mapping show.
    const float minAmbient = 0.5;
    styleBump = minAmbient + (1.0 - minAmbient) * pow(styleGain + dynLightDot, vec4(0.7));
    styleSpecular = specIntensity * pow(max(styleNdotH, 0.0), vec4(16.0));

    // Dynamic lights have no direction here, so they take the bump shading of
    // the baked lights, weighted by how bright each style was baked rather
    // than by its current value, so a flickering style does not move it either.
    vec4 styleWeight = max(lightmapR, max(lightmapG, lightmapB));
    dlightBump = (dot(styleWeight, styleBump) + 0.0001) / (dot(styleWeight, vec4(1.0)) + 0.0001);
  }

  vec3 shadedLightmap = (lightstyle * styleBump) * lightmapStyles;
  vec3 specularLightmap = (lightstyle * styleSpecular) * lightmapStyles;

  // Pre-calculate common factors to avoid redundant calculations
  vec3 shadeAmbient = vLightDot * uShadeLight + uAmbientLight + vDynamicLightDot * uDynamicShadeLight;
  vec3 lightingFactor = (shadedLightmap * shadow + surfaceDlight * dlightBump) * shadeAmbient;
  vec3 emissiveMask = clamp(luminance.rgb + vec3(uBloomEmissiveScale), 0.0, 1.0);
  // Static specular is attenuated by the shadow maps; dynamic specular is
  // attenuated via surfaceDlight, which already has the point shadows baked in.
  vec3 specularColor = specularLightmap * shadow + dynSpecFactor * surfaceDlight;

  // Combine lighting in one operation per channel
  vec3 emissiveColor = texel.rgb * emissiveMask;
  vec3 finalColor = texel.rgb * lightingFactor + specularColor + emissiveColor;

  // Apply gamma correction using pow on vec3 (single operation instead of 3)
  finalColor = pow(finalColor, vec3(uGamma));

  // Apply fog
  finalColor = mix(uFogColor, finalColor, vFog);

  fragColor = vec4(finalColor, texel.a * uAlpha);

  emissiveColor += texel.rgb * surfaceDlight * uBloomDlightScale;
  emissiveColor += specularColor * uBloomSpecularScale;
  emissiveColor = pow(emissiveColor, vec3(uGamma));
  emissiveColor = mix(uFogColor, emissiveColor, vFog);
  fragEmissive = vec4(emissiveColor, texel.a * uAlpha);
}
