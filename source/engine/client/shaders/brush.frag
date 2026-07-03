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
uniform sampler2DShadow tShadowMap0;
uniform sampler2DShadow tShadowMap1;
uniform sampler2DShadow tShadowMap2;
uniform float uShadowEnabled;
uniform int uShadowCount;
uniform float uShadowDarkness;
uniform float uShadowMapSize;

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
in float vFog;
in vec3 vNormal;
in vec3 vLightVec;
in vec3 vDynamicLightVec;
in vec3 vTangent;
in vec3 vBitangent;
in vec3 vViewVec;
in vec4 vShadowCoord0;
in vec4 vShadowCoord1;
in vec4 vShadowCoord2;
in vec3 vWorldPos;
uniform vec3 uFogColor;
in mat3 vAngles;

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

  return mix(1.0, mix(uShadowDarkness, 1.0, lit), fade);
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

  // Sample lightmap layers (R, G, B each in a separate array layer)
  vec4 lightmapR = texture(tLightmap, vec3(vTexCoord.zw, 0.0));
  vec4 lightmapG = texture(tLightmap, vec3(vTexCoord.zw, 1.0));
  vec4 lightmapB = texture(tLightmap, vec3(vTexCoord.zw, 2.0));

  vec3 lightmap = vec3(
    dot(lightmapR, lightstyle),
    dot(lightmapG, lightstyle),
    dot(lightmapB, lightstyle)
  );

  // Local entity shadow — small local depth map, BSP-light-driven direction.
  // Modulates the lightmap; fades smoothly to fully-lit at coverage edge.
  // 5×5 Gaussian-weighted PCF for smooth shadow edges. Each tap uses the
  // hardware sampler2DShadow (LINEAR gives free 2×2 PCF per tap).
  float s0 = sampleLocalShadowPCF(tShadowMap0, vShadowCoord0);
  float s1 = sampleLocalShadowPCF(tShadowMap1, vShadowCoord1);
  float s2 = sampleLocalShadowPCF(tShadowMap2, vShadowCoord2);

  float shadow = mix(1.0, s0, step(1.0, float(uShadowCount)));
  shadow = mix(shadow, min(s0, s1), step(2.0, float(uShadowCount)));
  shadow = mix(shadow, min(min(s0, s1), s2), step(3.0, float(uShadowCount)));
  shadow = mix(1.0, shadow, step(0.5, uShadowEnabled));

  // Point light shadows — up to 3 independent shadow-casting dlights, each
  // occluded by its own cube depth map and added on top of the baked dlight
  // texture (which excludes these lights; see R.AddDynamicLights). This way
  // nearby dlights correctly shadow each other instead of a single shadow
  // darkening every light's combined contribution at once.
  vec3 pointDlight = samplePointLightContribution(tPointShadowMap0, uPointLightPos0, uPointLightRadius0, uPointLightColor0)
                    + samplePointLightContribution(tPointShadowMap1, uPointLightPos1, uPointLightRadius1, uPointLightColor1)
                    + samplePointLightContribution(tPointShadowMap2, uPointLightPos2, uPointLightRadius2, uPointLightColor2);

  vec3 surfaceDlight = texture(tDlight, vTexCoord.zw).rgb + pointDlight;
  vec3 staticLight = lightmap * shadow + surfaceDlight;

  float bumpLightDot = 1.0;
  float specFactor = 0.0;
  float dynSpecFactor = 0.0;
  float lightFactor = 1.0;

  if (uPerformDotLighting) {
    float dynamicStrength = clamp(max(uDynamicShadeLight.r, max(uDynamicShadeLight.g, uDynamicShadeLight.b)), 0.0, 1.0);
    vec3 lightDirection;

    if (uHaveDeluxemap) {
      // Reuse pre-calculated deluxemap coordinates
      vec4 deluxemapR = texture(tDeluxemap, vec3(vTexCoord.zw, 0.0));
      vec4 deluxemapG = texture(tDeluxemap, vec3(vTexCoord.zw, 1.0));
      vec4 deluxemapB = texture(tDeluxemap, vec3(vTexCoord.zw, 2.0));

      lightDirection = vec3(
        dot(deluxemapR, lightstyle),
        dot(deluxemapG, lightstyle),
        dot(deluxemapB, lightstyle)
      );

      lightDirection.x *= vNormal.x >= 0.0 ? 1.0 : -1.0;
      lightDirection.y *= vNormal.y >= 0.0 ? 1.0 : -1.0;

      // need to adjust for rotation of the surface
      lightDirection *= vAngles;
    } else {
      // fallback to what the vertex shader has for us
      lightDirection = vLightVec;
    }

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
    vec3 t = normalize(vTangent - vNormal * dot(vNormal, vTangent));
    vec3 b = normalize(vBitangent - vNormal * dot(vNormal, vBitangent) - t * dot(t, vBitangent));

    // Build TBN transform and apply to normal
    vec3 N = normalize(t * normalMap.x + b * normalMap.y + vNormal * normalMap.z);
    vec3 L = normalize(lightDirection);
    vec3 V = normalize(vViewVec);

    // Calculate lighting (removed duplicate lightFactor assignment)
    lightFactor = max(dot(N, L), 0.0);
    vec3 H = normalize(L + V);
    specFactor = specIntensity * pow(max(dot(N, H), 0.0), 16.0);

    // Add dynamic light contribution
    float dynLightDot = max(dot(N, vDynamicLightVec), 0.0) * dynamicStrength;
    vec3 dynH = normalize(vDynamicLightVec + V);
    dynSpecFactor = specIntensity * pow(max(dot(N, dynH), 0.0), 16.0) * dynamicStrength;

    lightFactor += dynLightDot;
  }

  // Calculate bump mapping factor - blend between full lighting and bump-modified lighting
  // This prevents completely black surfaces while still allowing bump mapping to have effect
  const float minAmbient = 0.5;
  float bumpFactor = minAmbient + (1.0 - minAmbient) * pow(lightFactor, 0.7);

  // Pre-calculate common factors to avoid redundant calculations
  vec3 shadeAmbient = vLightDot * uShadeLight + uAmbientLight + vDynamicLightDot * uDynamicShadeLight;
  vec3 lightingFactor = staticLight * bumpFactor * shadeAmbient;
  vec3 emissiveMask = clamp(luminance.rgb + vec3(uBloomEmissiveScale), 0.0, 1.0);
  // Static specular is attenuated by the shadow maps; dynamic specular is
  // attenuated via surfaceDlight, which already has the point shadows baked in.
  vec3 specularColor = specFactor * lightmap * shadow + dynSpecFactor * surfaceDlight;

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
