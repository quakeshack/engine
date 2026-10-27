// The shading of a brush surface, shared by `brush` and `brush-refract`: textures, lightstyles, lightmap, bump and
// specular lighting, dynamic lights, gamma and fog. The program supplies the shadows.
#include "brush-fragment-inputs.glsl"

/**
 * Light of a point light at this fragment, before any shadow: the linear falloff and 2.0/255.0 scale reproduce the
 * brightness curve of the baked surface dlight (see R.AddDynamicLights: byte = clamp((radius - dist) * 2 * color, 0,
 * 255)), evaluated per fragment against the true 3D distance. Radius is floored like the cube shadow floors it
 * (samplePointLightContribution in brush.frag), so an unused (zero-radius) slot adds nothing.
 */
vec3 pointLightAttenuation(vec3 lightPos, float lightRadius, vec3 lightColor) {
  float fragDist = length(vWorldPos - lightPos);
  float f = max(lightRadius, 2.0);

  return clamp((f - fragDist) * (2.0 / 255.0) * lightColor, 0.0, 1.0);
}

/**
 * Shades the surface. shadow is the top-down shadow factor (1 = lit), pointDlight the light of the point lights that
 * are not in the baked dlight texture. color and emissive come out with gamma and fog applied, alpha is the texel's
 * alpha times uAlpha.
 */
void shadeBrushSurface(float shadow, vec3 pointDlight, out vec3 color, out vec3 emissive, out float alpha) {
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

  color = finalColor;
  alpha = texel.a * uAlpha;

  emissiveColor += texel.rgb * surfaceDlight * uBloomDlightScale;
  emissiveColor += specularColor * uBloomSpecularScale;
  emissiveColor = pow(emissiveColor, vec3(uGamma));
  emissiveColor = mix(uFogColor, emissiveColor, vFog);
  emissive = emissiveColor;
}
